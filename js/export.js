// Export: multi-page PDF (pdf-lib; imported PDF pages stay vector), DOCX (WordprocessingML,
// a port of DocxExporter.swift) and single pages as images.

import { state } from './model.js';
import { assets, fullResBytes, canvasToBlob } from './imaging.js';
import { renderPdfPage, loadScript } from './pdfsupport.js';
import { renderPage, layoutTextLines, baselineFactor, drawTextLocal } from './render.js';
import { fontInfo, rotate, LINE_HEIGHT } from './geometry.js';
import { zipStore } from './zip.js';

let pdfLibPromise = null;
function pdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = loadScript('vendor/pdf-lib.min.js').then(() => window.PDFLib);
    pdfLibPromise.catch(() => { pdfLibPromise = null; });
  }
  return pdfLibPromise;
}

const safeName = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled';

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ------------------------------------------------------------------ PDF

export async function exportPDF(progress = () => {}) {
  const L = await pdfLib();
  const { PDFDocument, StandardFonts, rgb, degrees } = L;
  const doc = state.doc;
  const out = await PDFDocument.create();
  out.setTitle(doc.title);
  out.setCreator('DocPrint Studio');
  out.setProducer('DocPrint Studio (web)');
  out.setCreationDate(new Date());

  const fonts = {};
  const font = async (name) => (fonts[name] ||= await out.embedFont(StandardFonts[name]));
  const srcDocs = {};
  const srcDoc = async (assetId) => (srcDocs[assetId] ||= await PDFDocument.load(assets.get(assetId).bytes.slice(0), { ignoreEncryption: true }));
  const imageCache = new Map();

  const total = doc.pages.reduce((n, p) => n + p.elements.length, 0) || 1;
  let done = 0;

  for (const page of doc.pages) {
    const pdfPage = out.addPage([page.w, page.h]);
    const H = page.h;

    /** Draws something of size dw×dh centered on the element, rotated clockwise by rotCW. */
    const placement = (el, dw, dh, rotCW) => {
      const cx = el.x + el.w / 2, cy = H - (el.y + el.h / 2);
      const phi = (-rotCW * Math.PI) / 180;
      const ox = (-dw / 2) * Math.cos(phi) + (dh / 2) * Math.sin(phi);
      const oy = (-dw / 2) * Math.sin(phi) - (dh / 2) * Math.cos(phi);
      return { x: cx + ox, y: cy + oy, rotate: degrees(-rotCW) };
    };

    for (const el of page.elements) {
      const opacity = el.opacity ?? 1;
      if (el.kind === 'image') {
        const key = JSON.stringify([el.asset, el.quad, el.scan]);
        let img = imageCache.get(key);
        if (!img) {
          const b = await fullResBytes(el);
          img = b.png ? await out.embedPng(b.bytes) : await out.embedJpg(b.bytes);
          imageCache.set(key, img);
        }
        pdfPage.drawImage(img, { ...placement(el, el.w, el.h, el.rotation || 0), width: el.w, height: el.h, opacity });
      } else if (el.kind === 'pdf') {
        const src = await srcDoc(el.asset);
        const sp = src.getPage(el.pageIndex);
        const box = sp.getCropBox();
        const pr = ((sp.getRotation().angle % 360) + 360) % 360;
        const [emb] = await out.embedPages([sp], [{ left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height }]);
        const quarter = pr % 180 !== 0;
        const xScale = (quarter ? el.h : el.w) / box.width;
        const yScale = (quarter ? el.w : el.h) / box.height;
        const dw = box.width * xScale, dh = box.height * yScale;
        pdfPage.drawPage(emb, { ...placement(el, dw, dh, (el.rotation || 0) + pr), xScale, yScale, opacity });
      } else if (el.kind === 'text') {
        await drawPdfText(pdfPage, el, H, font, out, { rgb, degrees, placement });
      }
      progress(++done / total);
    }
  }
  const bytes = await out.save();
  return new File([bytes], `${safeName(doc.title)}.pdf`, { type: 'application/pdf' });
}

async function drawPdfText(pdfPage, el, H, font, out, { rgb, degrees, placement }) {
  const info = fontInfo(el.font);
  const opacity = el.opacity ?? 1;
  const lines = layoutTextLines(el);
  if (info.pdf) {
    try {
      const f = await font(info.pdf);
      const [r, g, b] = hexToRgb(el.color);
      const base = baselineFactor(el.font) * el.size;
      const ops = lines.map((line, i) => {
        const width = f.widthOfTextAtSize(line, el.size);           // throws if not encodable
        const lx = el.align === 'center' ? -width / 2 : el.align === 'right' ? el.w / 2 - width : -el.w / 2;
        const ly = -el.h / 2 + base + i * el.size * LINE_HEIGHT;     // local, Y down
        const [rx, ry] = rotate(lx, ly, el.rotation || 0);
        return { line, x: el.x + el.w / 2 + rx, y: H - (el.y + el.h / 2 + ry) };
      });
      for (const o of ops) {
        if (!o.line) continue;
        pdfPage.drawText(o.line, { x: o.x, y: o.y, size: el.size, font: f, color: rgb(r, g, b), rotate: degrees(-(el.rotation || 0)), opacity });
      }
      return;
    } catch { /* characters outside WinAnsi → raster fallback below */ }
  }
  // Fonts without a PDF standard equivalent (or non-Latin text): 300 dpi transparent PNG.
  // The bitmap is symmetric around the frame center so it rotates exactly like the frame.
  const scale = 300 / 72;
  const pad = el.size;                                  // room for overhanging glyphs
  const halfW = el.w / 2 + pad;
  const halfH = Math.max(el.h / 2, lines.length * el.size * LINE_HEIGHT - el.h / 2) + pad;
  const c = document.createElement('canvas');
  c.width = Math.ceil(2 * halfW * scale);
  c.height = Math.ceil(2 * halfH * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(halfW, halfH);
  drawTextLocal(ctx, el);
  const png = new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
  c.width = c.height = 1;
  const img = await out.embedPng(png);
  const dw = 2 * halfW, dh = 2 * halfH;
  pdfPage.drawImage(img, { ...placement(el, dw, dh, el.rotation || 0), width: dw, height: dh, opacity });
}

// ------------------------------------------------------------------ DOCX

const EMU = 12700, TWIP = 20;
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emu = (pt) => Math.round(pt * EMU);
const twips = (pt) => Math.round(pt * TWIP);

function sectPr(w, h) {
  const orient = w > h ? ' w:orient="landscape"' : '';
  return `<w:sectPr><w:pgSz w:w="${twips(w)}" w:h="${twips(h)}"${orient}/>` +
    '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
}

function anchorXML(el, relID, id, z, name) {
  const x = emu(el.x), y = emu(el.y), cx = Math.max(1, emu(el.w)), cy = Math.max(1, emu(el.h));
  let r = (el.rotation || 0) % 360; if (r < 0) r += 360;
  const rot = Math.round(r * 60000);
  const rotAttr = rot ? ` rot="${rot}"` : '';
  const height = 251658240 + z * 1024;
  const alpha = (el.opacity ?? 1) < 0.999 ? `<a:alphaModFix amt="${Math.round((el.opacity ?? 1) * 100000)}"/>` : '';
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${height}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${xmlEscape(el.name || '')}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relID}">${alpha}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm${rotAttr}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
}

function textFrame(el) {
  const x = twips(el.x), y = twips(el.y), w = Math.max(1, twips(el.w)), h = Math.max(1, twips(el.h));
  const jc = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left';
  const color = (el.color || '#000000').replace('#', '').toUpperCase();
  const half = Math.max(2, Math.round(el.size * 2));
  const fontName = xmlEscape(el.font.replace('-Bold', '').replace('-Roman', ''));
  const bold = el.font.includes('Bold') ? '<w:b/>' : '';
  const rPr = `<w:rPr><w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:cs="${fontName}"/>${bold}` +
    `<w:color w:val="${color}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>`;
  let runs = '';
  String(el.text || '').split('\n').forEach((line, i) => {
    if (i > 0) runs += `<w:r>${rPr}<w:br/></w:r>`;
    runs += `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
  });
  return `<w:p><w:pPr><w:framePr w:w="${w}" w:h="${h}" w:hRule="exact" w:wrap="around" w:vAnchor="page" w:hAnchor="page" w:x="${x}" w:y="${y}"/>` +
    `<w:spacing w:before="0" w:after="0"/><w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;
}

export async function exportDOCX(progress = () => {}) {
  const doc = state.doc;
  const media = [];
  let body = '', drawingID = 1;
  const total = doc.pages.reduce((n, p) => n + p.elements.length, 0) || 1;
  let done = 0;

  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi];
    let anchors = '', frames = '';
    for (let z = 0; z < page.elements.length; z++) {
      const el = page.elements[z];
      if (el.kind === 'text') frames += textFrame(el);
      else {
        let pic = null;
        if (el.kind === 'image') {
          const b = await fullResBytes(el);
          pic = { data: b.bytes, png: b.png };
        } else {
          const a = assets.get(el.asset);
          const c = await renderPdfPage(a, el.pageIndex, (Math.max(el.w, el.h) * 200) / 72);   // 200 dpi
          pic = { data: new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer()), png: true };
          c.width = c.height = 1;
        }
        const n = media.length + 1;
        const relID = `rIdImg${n}`, fileName = `image${n}.${pic.png ? 'png' : 'jpeg'}`;
        media.push({ fileName, data: pic.data, relID });
        anchors += anchorXML(el, relID, drawingID++, z, fileName);
      }
      progress(++done / total);
    }
    body += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>' + anchors + '</w:p>';
    body += frames;
    if (pi < doc.pages.length - 1) {
      body += '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:rPr><w:sz w:val="2"/></w:rPr>' + sectPr(page.w, page.h) + '</w:pPr></w:p>';
    }
  }
  const last = doc.pages[doc.pages.length - 1];
  body += sectPr(last.w, last.h);

  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`;

  let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  for (const m of media) rels += `<Relationship Id="${m.relID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.fileName}"/>`;
  rels += '</Relationships>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica" w:cs="Helvetica"/>' +
    '<w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>' +
    '</w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>';

  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEscape(doc.title)}</dc:title><dc:creator>DocPrint Studio</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    '</cp:coreProperties>';

  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    `<Application>DocPrint Studio</Application><Pages>${doc.pages.length}</Pages></Properties>`;

  const enc = new TextEncoder();
  const files = [
    ['[Content_Types].xml', enc.encode(contentTypes)],
    ['_rels/.rels', enc.encode(rootRels)],
    ['docProps/core.xml', enc.encode(core)],
    ['docProps/app.xml', enc.encode(app)],
    ['word/document.xml', enc.encode(document)],
    ['word/styles.xml', enc.encode(styles)],
    ['word/_rels/document.xml.rels', enc.encode(rels)],
    ...media.map((m) => [`word/media/${m.fileName}`, m.data]),
  ];
  const zip = zipStore(files);
  return new File([zip], `${safeName(doc.title)}.docx`, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// ------------------------------------------------------------------ page image

/** Current page as a JPEG at up to 300 dpi (kept within iOS canvas limits). */
export async function exportPageImage(page, pageNumber) {
  let dpi = 300;
  const maxArea = 16000000;
  const area = (page.w / 72) * (page.h / 72) * dpi * dpi;
  if (area > maxArea) dpi = Math.floor(dpi * Math.sqrt(maxArea / area));
  const c = await renderPage(page, dpi / 72, { fullRes: true });
  const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
  c.width = c.height = 1;
  const suffix = state.doc.pages.length > 1 ? ` – page ${pageNumber}` : '';
  return new File([blob], `${safeName(state.doc.title)}${suffix}.jpg`, { type: 'image/jpeg' });
}
