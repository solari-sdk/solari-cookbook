import io

import pytest
from PIL import Image
from pypdf import PdfWriter

from app.media_analysis import compare_images, document_metadata, image_metadata


def _png(pixel=(0, 0, 0), *, artist=None):
    image = Image.new("RGB", (4, 3), pixel)
    exif = Image.Exif()
    if artist:
        exif[315] = artist
    output = io.BytesIO()
    image.save(output, format="PNG", exif=exif)
    return output.getvalue()


def _pdf():
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": "Public fixture", "/Author": "Fixture author"})
    writer.write(output)
    return output.getvalue()


def test_document_metadata_extracts_pdf_metadata_without_text_execution():
    result = document_metadata(_pdf(), filename="fixture.pdf")
    assert result["document_type"] == "pdf"
    assert result["page_count"] == 1
    assert result["metadata"]["Title"] == "Public fixture"
    assert len(result["sha256"]) == 64


def test_image_metadata_extracts_dimensions_and_exif():
    result = image_metadata(_png(artist="Public fixture"), filename="image.png")
    assert result["format"] == "PNG"
    assert result["width"] == 4 and result["height"] == 3
    assert result["exif"]["Artist"] == "Public fixture"


def test_screenshot_comparison_reports_change_and_dimension_mismatch():
    same = _png((10, 20, 30))
    changed = _png((10, 20, 31))
    result = compare_images(same, changed)
    assert result["same_dimensions"] is True
    assert result["identical"] is False
    assert result["normalized_change_score"] > 0

    output = io.BytesIO()
    Image.new("RGB", (2, 2), (10, 20, 30)).save(output, format="PNG")
    mismatch = compare_images(same, output.getvalue())
    assert mismatch["same_dimensions"] is False
    assert mismatch["normalized_change_score"] == 1.0


def test_analysis_rejects_empty_input():
    with pytest.raises(ValueError, match="must not be empty"):
        document_metadata(b"")
    with pytest.raises(ValueError, match="must not be empty"):
        image_metadata(b"")
