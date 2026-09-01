# Bounded document and image processing

The local reconnaissance helpers treat uploaded/public artifacts as untrusted bytes. They do not execute embedded document content.

## Metadata

`document_metadata()` accepts at most 25 MiB and extracts generic file metadata plus bounded PDF metadata/page count using `pypdf`. `image_metadata()` decodes through Pillow, caps decoded images at 50 million pixels, and extracts dimensions/hash/EXIF values with value-length limits.

## OCR

`ocr_image()` is an optional local Tesseract-backed OCR pipeline for lawful public or user-supplied images. Its explicit resource/security boundary is:

- maximum input: 10 MiB;
- maximum decoded image: 20 million pixels;
- timeout: caller-selectable 1–30 seconds, default 15;
- maximum returned text: 1,000,000 characters;
- language selector restricted to a short allowlisted character set;
- image decoded and rewritten as a temporary PNG before OCR;
- Tesseract invoked with an argument vector, never through a shell; and
- temporary input removed automatically after each run.

The Python application does not silently install or download OCR language models. A local `tesseract` executable and the requested language data must already be available on `PATH`; absence is reported explicitly rather than treated as empty OCR text.

## QR and barcode extraction

`extract_codes()` uses the headless OpenCV decoders against the same 10 MiB / 20-million-pixel image boundary. It attempts QR decoding and OpenCV's common barcode detector when available, deduplicates exact type/value pairs, and returns at most 100 decoded values. Decode failures produce an empty code list, while malformed/oversized images raise validation errors.

The QR path is covered with a real generated QR fixture; barcode result-shape handling shares the same bounded result contract. Decoded values are data only and are never navigated to or executed automatically.
