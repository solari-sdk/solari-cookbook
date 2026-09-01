import io
import subprocess

import cv2
import pytest
from PIL import Image
from pypdf import PdfWriter

from app.media_analysis import compare_images, document_metadata, extract_codes, image_metadata, ocr_image


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


def _qr_png(value: str) -> bytes:
    encoder = cv2.QRCodeEncoder_create()
    matrix = encoder.encode(value)
    matrix = cv2.copyMakeBorder(matrix, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
    matrix = cv2.resize(matrix, None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)
    ok, encoded = cv2.imencode(".png", matrix)
    assert ok
    return encoded.tobytes()


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


def test_qr_extraction_decodes_real_generated_fixture():
    result = extract_codes(_qr_png("public-fixture-123"))
    assert result["count"] >= 1
    assert {item["value"] for item in result["codes"]} == {"public-fixture-123"}
    assert any(item["type"] == "QR_CODE" for item in result["codes"])


def test_ocr_uses_bounded_non_shell_tesseract_process(monkeypatch):
    calls = {}

    def fake_run(args, **kwargs):
        calls["args"] = args
        calls["kwargs"] = kwargs
        return subprocess.CompletedProcess(args, 0, stdout="fixture text\n", stderr="")

    monkeypatch.setattr("app.media_analysis.shutil.which", lambda name: "/usr/bin/tesseract" if name == "tesseract" else None)
    monkeypatch.setattr("app.media_analysis.subprocess.run", fake_run)
    result = ocr_image(_png((255, 255, 255)), timeout_seconds=7)
    assert result["text"] == "fixture text\n"
    assert result["engine"] == "tesseract"
    assert calls["args"][0] == "/usr/bin/tesseract"
    assert calls["args"][2:4] == ["stdout", "-l"]
    assert calls["kwargs"]["timeout"] == 7
    assert calls["kwargs"]["check"] is False
    assert "shell" not in calls["kwargs"]


def test_ocr_rejects_untrusted_language_selector(monkeypatch):
    monkeypatch.setattr("app.media_analysis.shutil.which", lambda _name: "/usr/bin/tesseract")
    with pytest.raises(ValueError, match="language"):
        ocr_image(_png((255, 255, 255)), language="eng;rm -rf /")


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
    with pytest.raises(ValueError, match="must not be empty"):
        extract_codes(b"")
