# DocPrint Studio for iPhone

Document layout and scan clean-up in the browser, built for iPhone (also works on iPad and desktop). Turn a photo of paper into a clean, straightened scan, place images at exact physical sizes, and export PDF or Word. Plain HTML/CSS/JavaScript, no build step. It installs to the Home Screen, works offline and autosaves your document on the device. Nothing is uploaded anywhere.

**Install:** open `https://mahroofgit.github.io/<this-repo>/` in Safari → Share → *Add to Home Screen*.

## Features

- **Document library:** the app opens to Home with quick tools (Smart Scan, Import Images, Import Files, Blank Document), Recents and All Documents (search, sort by recent / created / name). Open, share, rename, duplicate or delete any document; each one is saved on the device as you work.
- **Camera scanning** (big camera button): live viewfinder that outlines the paper as you aim, **Single** or **Batch** capture, grid, flash where supported, undo last shot, and import from Photos or Files. If the live camera isn't allowed, the iPhone camera is used instead.
- **Page review** after scanning: go through the pages one by one: **Crop** (corner editor with loupe), **Rotate**, **Filter** (Original / Enhance / Gray / B&W with ink sensitivity, apply to all), **Retake**, **Delete**, drag to reorder, **Add** more. **Done** places one page per scan, fitted to the page, in a new document (or the open one when scanning from the editor).

- **Scan Document / Scan Enhance:** the page edges are found, the perspective is straightened, the lighting is evened out, and the result is fitted to the current page using the Fit to Page rules (keep proportions, or fill the page when the aspect lock is off; margin respected). One undo reverts it.
- **Edit Corners:** place the four corners yourself, with a magnifying loupe and a live preview.
- **Adaptive scanning:** the lighting map is built only from areas that look like bare paper (logos, photos and shaded boxes keep their tone), and black / white levels are measured from each photo automatically.
- **Document Scan filters:** Original / Color / B&W / Grayscale, B&W ink sensitivity (local threshold that keeps faint and thin strokes), hard 1-bit threshold, exposure, contrast, saturation, gamma, sharpness.
- **Layout:** rulers with drag-out guides, snapping to guides, edges and centers, exact X / Y / W / H in mm, cm or in, aspect lock, size presets (passport 35 × 45 mm, 2 × 2 in, ID card, business card, 300 dpi), rotation, opacity, layers and align.
- **Fit to Page:** *Keep proportions* scales the selection to fit inside the page and centers it; *Fill page* stretches it to the page exactly (handy for a photographed A4 / Letter form). Adjustable margin and *Restore Proportions*.
- **Text boxes** with font, size, color and alignment.
- **Markup** (like macOS Markup): Select, Text, Rectangle, Oval, Line, Arrow, Highlighter and Pen. Drag on the page to draw; *Perfect shapes* (or ⇧ on an iPad keyboard) makes squares, circles and 45° lines. Shapes and text return to Select when placed; the pen and highlighter stay on until you tap **Done**. Restyle a selection with color swatches, fill, line width, corner radius and arrowheads; new marks use the last style. The highlighter multiplies like a real marker. Shapes export as vectors in PDF.
- **Long-press** an object for Duplicate, Bring to Front / Send to Back, Fit to Page, Stretch to Fill Page, Corner Unwarp, Scan Enhance and Delete. Long-press a page thumbnail for its page menu, or long-press and drag it to reorder.
- **Status bar** with the finger / pointer position, the selection's size and the zoom; rulers mark guides and the pointer. Double-tap empty space to fit the page.
- **Keyboard (iPad):** V T R O L A H P pick tools, Esc stops drawing, ⌫ deletes, arrows nudge (⇧ × 10), ⌘Z / ⇧⌘Z, ⌘D, ⌘+ / ⌘− / ⌘0.
- **Pages:** US Letter, Legal, A3, A4, A5 or custom; portrait / landscape; insert, duplicate, rotate, reorder, delete.
- **PDF import:** each page becomes a page and stays vector in the exported PDF.
- **Zoom:** Fit Width, Fit Page, 100 % = real size, 50 / 75 / 150 / 200 / 400 %, pinch to zoom. Calibrate against a bank card or a ruler bar.
- **Export:** one screen for PDF, Word, JPEG and PNG. Pick pages (all, current or a range like `1-3, 5`), a quality preset or the compression slider, resolution, and color / grayscale / 1-bit B&W, and watch the estimated file size update live with badges for common 1–25 MB upload limits. *Fit under N MB* finds the best quality that fits. The preview shows the page exactly as it will be compressed (*1:1 Pixels* to inspect text). PDFs can be made **searchable** (on-device English OCR) and **password-protected** (AES-128). Files go out through the iOS share sheet (Save to Files, Save to Photos, Print, AirDrop, Mail).
- Undo / redo, pinch to zoom, double-tap a text box to edit it.

## Publishing

Every push to `main` runs the tests and deploys through `.github/workflows/pages.yml`. Set *Settings → Pages → Build and deployment → Source* to **GitHub Actions** (the branch option also works, but skips the tests). Open copies of the app pick up a new release automatically: app files are fetched network-first and the page reloads once when a new version takes over. Bump `APP_VERSION` in `js/ui.js` and `VERSION` in `sw.js` together for each release (a test checks this).

**Run locally:** `python3 -m http.server 8000`, then open `http://localhost:8000`.

## Files

| File | Responsibility |
|---|---|
| `js/geometry.js` | units, paper sizes, rotation, snapping, resize handles, text wrapping |
| `js/model.js` | pages / elements / guides, undo/redo, autosave, import, scan actions |
| `js/scan-worker.js` | Web Worker: perspective unwarp, illumination flattening, filters, edge detection |
| `js/imaging.js` | image import (EXIF orientation, DPI), proxies, preview cache, full-resolution renders |
| `js/canvas.js` | touch canvas: move / resize / rotate, pinch zoom, rulers, guides, real-size zoom |
| `js/ui.js`, `js/perspective.js` | panels (Edit, Markup, Scan, Pages), sheets (Add, View, Menu, context menus), corner editor |
| `js/markup.js` | markup tools, styles and the shape / ink geometry used by the canvas and every exporter |
| `js/export.js` | export engine: resolution / compression / colour mode, caches, size estimate, fit-under-N-MB, previews, PDF (pdf-lib, JPEG passed through, 1-bit images), DOCX, JPEG / PNG pages |
| `js/exportui.js` | export screen |
| `js/pdfcrypt.js` | PDF password protection (AES-128, standard security handler) |
| `js/ocr.js` | searchable-PDF text recognition (Tesseract, English, on device) |
| `js/png.js`, `js/zip.js` | 1-bit / 8-bit grayscale PNG encoder, zlib, ZIP writer |
| `tests/` | scan pipeline tests (ported from the Mac app) and crypto tests: `node tests/scan.test.js` |
| `vendor/` | pdf.js 3.11 (Apache-2.0), pdf-lib 1.17 (MIT), tesseract.js 6 + English data (Apache-2.0), licenses included |
