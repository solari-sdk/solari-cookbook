import io
import base64
from typing import Tuple, Optional, List
from PIL import Image, ImageDraw, ImageFont


def bytes_to_base64(image_bytes: bytes) -> str:
    """Encodes raw image bytes into a base64 string."""
    return base64.b64encode(image_bytes).decode("utf-8")


def base64_to_bytes(b64_str: str) -> bytes:
    """Decodes a base64 string into raw image bytes."""
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    return base64.b64decode(b64_str)


def create_thumbnail(image_bytes: bytes, max_size: Tuple[int, int] = (640, 480), format: str = "JPEG") -> bytes:
    """Resizes an image into a compact thumbnail for fast WebSocket streaming."""
    image = Image.open(io.BytesIO(image_bytes))
    image.thumbnail(max_size, Image.Resampling.LANCZOS)
    output = io.BytesIO()
    if format.upper() == "JPEG" and image.mode in ("RGBA", "P"):
        image = image.convert("RGB")
    image.save(output, format=format, quality=75)
    return output.getvalue()


def annotate_screenshot(
    image_bytes: bytes,
    click_coords: Optional[Tuple[int, int]] = None,
    bounding_box: Optional[List[int]] = None,
    action_label: Optional[str] = None
) -> bytes:
    """
    Overlays visual action markers onto a screenshot:
    - Red crosshair / target circle at click_coords
    - Highlight rectangle for bounding_box [x1, y1, x2, y2]
    - Text badge with action_label
    """
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        overlay = Image.new("RGBA", image.size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(overlay)

        # Draw bounding box if provided [x1, y1, x2, y2]
        if bounding_box and len(bounding_box) == 4:
            x1, y1, x2, y2 = bounding_box
            draw.rectangle([x1, y1, x2, y2], outline=(0, 255, 204, 230), width=3)
            # Semi-transparent fill
            draw.rectangle([x1, y1, x2, y2], fill=(0, 255, 204, 30))

        # Draw click target marker if provided (x, y)
        if click_coords:
            cx, cy = click_coords
            r_outer = 18
            r_inner = 6
            # Outer red glow ring
            draw.ellipse([cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer], outline=(255, 59, 48, 240), width=3)
            draw.ellipse([cx - r_outer - 4, cy - r_outer - 4, cx + r_outer + 4, cy + r_outer + 4], outline=(255, 59, 48, 120), width=1)
            # Center target dot
            draw.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner], fill=(255, 59, 48, 255))
            # Crosshair lines
            draw.line([cx - r_outer - 6, cy, cx + r_outer + 6, cy], fill=(255, 255, 255, 200), width=2)
            draw.line([cx, cy - r_outer - 6, cx, cy + r_outer + 6], fill=(255, 255, 255, 200), width=2)

        # Draw action label badge
        if action_label and click_coords:
            cx, cy = click_coords
            badge_x = cx + 22
            badge_y = max(10, cy - 14)
            # Draw badge background
            draw.rectangle([badge_x, badge_y, badge_x + len(action_label) * 8 + 12, badge_y + 22], fill=(0, 0, 0, 210), outline=(255, 59, 48, 200), width=1)
            draw.text((badge_x + 6, badge_y + 4), action_label, fill=(255, 255, 255, 255))

        # Composite overlay
        annotated = Image.alpha_composite(image, overlay).convert("RGB")
        output = io.BytesIO()
        annotated.save(output, format="JPEG", quality=85)
        return output.getvalue()
    except Exception:
        # Fallback to unmodified image on annotation error
        return image_bytes
