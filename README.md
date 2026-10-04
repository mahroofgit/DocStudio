# DocPrint Studio for iPhone

Document layout and scan clean-up in the browser, built for iPhone (also works on iPad and desktop). Turn a photo of paper into a clean, straightened scan, place images at exact physical sizes, and export PDF or Word. Plain HTML/CSS/JavaScript, no build step. It installs to the Home Screen, works offline and autosaves your document on the device. Nothing is uploaded anywhere.

**Install:** open `https://mahroofgit.github.io/<this-repo>/` in Safari → Share → *Add to Home Screen*.

## Features

- **Scan Document:** take a photo; the page edges are found, the perspective is straightened and the lighting is evened out automatically.
- **Edit Corners:** place the four corners yourself, with a magnifying loupe and a live preview.
- **Document Scan filters:** Original / Color / B&W / Grayscale, threshold, exposure, contrast, saturation, gamma, sharpness.
- **Layout:** rulers with drag-out guides, snapping to guides, edges and centers, exact X / Y / W / H in mm, cm or in, aspect lock, size presets (passport 35 × 45 mm, 2 × 2 in, ID card, business card, 300 dpi, fit to page), rotation, opacity, layers and align.
- **Text boxes** with font, size, color and alignment.
- **Pages:** US Letter, Legal, A3, A4, A5 or custom; portrait / landscape; insert, duplicate, rotate, reorder, delete.
- **PDF import:** each page becomes a page and stays vector in the exported PDF.
- **100 % = real size**, with calibration against a bank card.
- **Export:** PDF, Word (.docx), or the current page as a 300 dpi JPEG, via the iOS share sheet (Save to Files, Print, AirDrop, Mail).
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
| `js/export.js`, `js/zip.js` | PDF (pdf-lib), DOCX, page image |
| `vendor/` | pdf.js 3.11 (Apache-2.0) and pdf-lib 1.17 (MIT), licenses included |
