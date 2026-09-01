from __future__ import annotations

import io
import mimetypes
import re
import shutil
import subprocess
import tempfile
from hashlib import sha256
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import ExifTags, Image, ImageChops, ImageStat
from pypdf import PdfReader

MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000
MAX_OCR_BYTES = 10 * 1024 * 1024
MAX_OCR_PIXELS = 20_000_000
MAX_OCR_TEXT_CHARS = 1_000_000
MAX_CODE_RESULTS = 100
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


def _bounded_image(data: bytes, *, max_bytes: int, max_pixels: int) -> Image.Image:
    _bounded(data)
    if len(data) > max_bytes:
        raise ValueError(f"image exceeds {max_bytes // (1024 * 1024)} MiB operation limit")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise ValueError("unsupported or malformed image") from exc
    if image.width * image.height > max_pixels:
        image.close()
        raise ValueError(f"image exceeds {max_pixels:,} pixel operation limit")
    return image


def ocr_image(
    data: bytes,
    *,
    language: str = "eng",
    timeout_seconds: int = 15,
) -> dict[str, object]:
    """OCR a bounded user/public image with a locally installed Tesseract engine.

    The input is decoded by Pillow and rewritten to a temporary PNG before the OCR
    process receives it. No shell is used, language input is allowlisted, execution
    has a hard timeout, and returned text is capped.
    """
    if not re.fullmatch(r"[A-Za-z0-9_+.-]{1,100}", language):
        raise ValueError("invalid OCR language selector")
    if not 1 <= timeout_seconds <= 30:
        raise ValueError("OCR timeout must be between 1 and 30 seconds")
    executable = shutil.which("tesseract")
    if not executable:
        raise RuntimeError("Tesseract OCR engine is not installed or not on PATH")

    image = _bounded_image(data, max_bytes=MAX_OCR_BYTES, max_pixels=MAX_OCR_PIXELS)
    try:
        rgb = image.convert("RGB")
        with tempfile.TemporaryDirectory(prefix="solari-ocr-") as directory:
            input_path = Path(directory) / "input.png"
            rgb.save(input_path, format="PNG")
            try:
                completed = subprocess.run(
                    [executable, str(input_path), "stdout", "-l", language, "--psm", "6"],
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("OCR execution exceeded the configured timeout") from exc
    finally:
        image.close()

    if completed.returncode != 0:
        error = completed.stderr.strip()[:1000] or f"exit status {completed.returncode}"
        raise RuntimeError(f"OCR engine failed: {error}")
    text = completed.stdout[:MAX_OCR_TEXT_CHARS]
    return {
        "engine": "tesseract",
        "language": language,
        "text": text,
        "truncated": len(completed.stdout) > MAX_OCR_TEXT_CHARS,
        "sha256": sha256(data).hexdigest(),
    }


def extract_codes(data: bytes) -> dict[str, object]:
    """Extract bounded QR and common barcode payloads from a user/public image."""
    image = _bounded_image(data, max_bytes=MAX_OCR_BYTES, max_pixels=MAX_OCR_PIXELS)
    try:
        array = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)
    finally:
        image.close()

    decoded: list[dict[str, str]] = []
    qr = cv2.QRCodeDetector()
    try:
        ok, values, _points, _straight = qr.detectAndDecodeMulti(array)
    except (cv2.error, ValueError):
        ok, values = False, ()
    if ok:
        for value in values:
            if value:
                decoded.append({"type": "QR_CODE", "value": str(value)})
    if not decoded:
        try:
            value, _points, _straight = qr.detectAndDecode(array)
        except cv2.error:
            value = ""
        if value:
            decoded.append({"type": "QR_CODE", "value": str(value)})

    detector_factory = getattr(cv2, "barcode_BarcodeDetector", None)
    if detector_factory is not None:
        try:
            detector = detector_factory()
            result = detector.detectAndDecodeWithType(array)
            if isinstance(result, tuple) and len(result) >= 3:
                ok = bool(result[0])
                values = result[1] if isinstance(result[1], (tuple, list)) else (result[1],)
                types = result[2] if isinstance(result[2], (tuple, list)) else (result[2],)
                if ok:
                    for value, code_type in zip(values, types):
                        if value:
                            decoded.append({"type": str(code_type or "BARCODE"), "value": str(value)})
        except cv2.error:
            pass

    unique: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in decoded:
        key = (item["type"], item["value"])
        if key not in seen:
            seen.add(key)
            unique.append(item)
        if len(unique) >= MAX_CODE_RESULTS:
            break
    return {
        "codes": unique,
        "count": len(unique),
        "truncated": len(decoded) > MAX_CODE_RESULTS,
        "sha256": sha256(data).hexdigest(),
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
