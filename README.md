# DocPrint Studio for iPhone

Document layout and scan clean-up in the browser, built for iPhone (also works on iPad and desktop). Turn a photo of paper into a clean, straightened scan, place images at exact physical sizes, and export PDF or Word. Plain HTML/CSS/JavaScript, no build step. It installs to the Home Screen, works offline and autosaves your document on the device. Nothing is uploaded anywhere.

**Install:** open `https://mahroofgit.github.io/<this-repo>/` in Safari → Share → *Add to Home Screen*.

## Features

- **Scan Document:** take a photo; the page edges are found, the perspective is straightened and the lighting is evened out automatically.
- **Edit Corners:** place the four corners yourself, with a magnifying loupe and a live preview.
- **Adaptive scanning:** the lighting map is built only from areas that look like bare paper (logos, photos and shaded boxes keep their tone), and black / white levels are measured from each photo automatically.
- **Document Scan filters:** Original / Color / B&W / Grayscale, B&W ink sensitivity (local threshold that keeps faint and thin strokes), hard 1-bit threshold, exposure, contrast, saturation, gamma, sharpness.
- **Layout:** rulers with drag-out guides, snapping to guides, edges and centers, exact X / Y / W / H in mm, cm or in, aspect lock, size presets (passport 35 × 45 mm, 2 × 2 in, ID card, business card, 300 dpi), rotation, opacity, layers and align.
- **Fit to Page:** *Keep proportions* scales the selection to fit inside the page and centers it; *Fill page* stretches it to the page exactly (handy for a photographed A4 / Letter form). Adjustable margin and *Restore Proportions*.
- **Text boxes** with font, size, color and alignment.
- **Pages:** US Letter, Legal, A3, A4, A5 or custom; portrait / landscape; insert, duplicate, rotate, reorder, delete.
- **PDF import:** each page becomes a page and stays vector in the exported PDF.
- **100 % = real size**, with calibration against a bank card.
- **Export:** one screen for PDF, Word, JPEG and PNG. Pick pages (all, current or a range like `1-3, 5`), a quality preset or the compression slider, resolution, and color / grayscale / 1-bit B&W, and watch the estimated file size update live with badges for common 1–25 MB upload limits. *Fit under N MB* finds the best quality that fits. The preview shows the page exactly as it will be compressed (*1:1 Pixels* to inspect text). PDFs can be made **searchable** (on-device English OCR) and **password-protected** (AES-128). Files go out through the iOS share sheet (Save to Files, Save to Photos, Print, AirDrop, Mail).
- Undo / redo, pinch to zoom, double-tap a text box to edit it.

## Publishing

Every push to `main` deploys through `.github/workflows/pages.yml`. Once, enable *Settings → Pages → Source: GitHub Actions*.

**Run locally:** `python3 -m http.server 8000`, then open `http://localhost:8000`.

## Files

| File | Responsibility |
|---|---|
| `js/geometry.js` | units, paper sizes, rotation, snapping, resize handles, text wrapping |
| `js/model.js` | pages / elements / guides, undo/redo, autosave, import, scan actions |
| `js/scan-worker.js` | Web Worker: perspective unwarp, illumination flattening, filters, edge detection |
| `js/imaging.js` | image import (EXIF orientation, DPI), proxies, preview cache, full-resolution renders |
| `js/canvas.js` | touch canvas: move / resize / rotate, pinch zoom, rulers, guides, real-size zoom |
| `js/ui.js`, `js/perspective.js` | panels (Edit, Scan, Pages), sheets (Add, Export, View, Menu), corner editor |
| `js/export.js` | export engine: resolution / compression / colour mode, caches, size estimate, fit-under-N-MB, previews, PDF (pdf-lib, JPEG passed through, 1-bit images), DOCX, JPEG / PNG pages |
| `js/exportui.js` | export screen |
| `js/pdfcrypt.js` | PDF password protection (AES-128, standard security handler) |
| `js/ocr.js` | searchable-PDF text recognition (Tesseract, English, on device) |
| `js/png.js`, `js/zip.js` | 1-bit / 8-bit grayscale PNG encoder, zlib, ZIP writer |
| `tests/` | scan pipeline tests (ported from the Mac app) and crypto tests: `node tests/scan.test.js` |
| `vendor/` | pdf.js 3.11 (Apache-2.0), pdf-lib 1.17 (MIT), tesseract.js 6 + English data (Apache-2.0), licenses included |
