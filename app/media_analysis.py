from __future__ import annotations

import io
import mimetypes
from hashlib import sha256
from pathlib import Path
from typing import Any

from PIL import ExifTags, Image, ImageChops, ImageStat
from pypdf import PdfReader

MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


def _bounded(data: bytes) -> None:
    if not data:
        raise ValueError("artifact must not be empty")
    if len(data) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds 25 MiB analysis limit")


def _safe_metadata_value(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)[:4000]


def document_metadata(data: bytes, *, filename: str | None = None, mime_type: str | None = None) -> dict[str, object]:
    """Extract bounded, non-executable metadata from a user/public document."""
    _bounded(data)
    guessed = mimetypes.guess_type(filename or "")[0]
    detected = mime_type or guessed or "application/octet-stream"
    result: dict[str, object] = {
        "filename": Path(filename).name if filename else None,
        "mime_type": detected,
        "size_bytes": len(data),
        "sha256": sha256(data).hexdigest(),
        "metadata": {},
    }
    if data.startswith(b"%PDF-") or detected == "application/pdf":
        reader = PdfReader(io.BytesIO(data), strict=False)
        metadata = reader.metadata or {}
        result.update(
            {
                "document_type": "pdf",
                "page_count": len(reader.pages),
                "encrypted": bool(reader.is_encrypted),
                "metadata": {
                    str(key).lstrip("/"): _safe_metadata_value(value)
                    for key, value in metadata.items()
                    if value is not None
                },
            }
        )
    else:
        result["document_type"] = "generic"
    return result


def image_metadata(data: bytes, *, filename: str | None = None) -> dict[str, object]:
    """Extract image dimensions and EXIF without executing embedded content."""
    _bounded(data)
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        exif = image.getexif()
        normalized: dict[str, object] = {}
        for tag_id, value in exif.items():
            name = ExifTags.TAGS.get(tag_id, str(tag_id))
            if isinstance(value, bytes):
                normalized[name] = value[:128].hex()
            elif isinstance(value, (str, int, float, bool)) or value is None:
                normalized[name] = value
            elif isinstance(value, tuple):
                normalized[name] = [_safe_metadata_value(item) for item in value[:32]]
            else:
                normalized[name] = _safe_metadata_value(value)
        return {
            "filename": Path(filename).name if filename else None,
            "format": image.format,
            "mode": image.mode,
            "width": image.width,
            "height": image.height,
            "pixel_count": image.width * image.height,
            "sha256": sha256(data).hexdigest(),
            "exif": normalized,
        }


def compare_images(left: bytes, right: bytes) -> dict[str, object]:
    """Compare two screenshots/images and report bounded visual change metrics."""
    _bounded(left)
    _bounded(right)
    with Image.open(io.BytesIO(left)) as left_image, Image.open(io.BytesIO(right)) as right_image:
        left_rgb = left_image.convert("RGB")
        right_rgb = right_image.convert("RGB")
        if left_rgb.size != right_rgb.size:
            return {
                "same_dimensions": False,
                "left_size": list(left_rgb.size),
                "right_size": list(right_rgb.size),
                "identical": False,
                "changed_bbox": None,
                "mean_channel_delta": None,
                "normalized_change_score": 1.0,
            }
        diff = ImageChops.difference(left_rgb, right_rgb)
        bbox = diff.getbbox()
        means = ImageStat.Stat(diff).mean
        mean_delta = sum(means) / len(means)
        return {
            "same_dimensions": True,
            "left_size": list(left_rgb.size),
            "right_size": list(right_rgb.size),
            "identical": bbox is None,
            "changed_bbox": list(bbox) if bbox else None,
            "mean_channel_delta": round(mean_delta, 6),
            "normalized_change_score": round(mean_delta / 255.0, 8),
        }
