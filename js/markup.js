// Markup (port of Markup.swift): tools, styles and the shape / ink geometry shared by the
// canvas, thumbnails and every exporter. Geometry is produced as path commands in element-local
// page points (origin top-left, Y down) so it can be emitted as SVG, Canvas 2D or PDF operators.

export const TOOLS = [
  { id: 'select', label: 'Select', key: 'v', icon: 'cursor' },
  { id: 'text', label: 'Text', key: 't', icon: 'text' },
  { id: 'rectangle', label: 'Rectangle', key: 'r', icon: 'rect', shape: 'rectangle' },
  { id: 'ellipse', label: 'Oval', key: 'o', icon: 'oval', shape: 'ellipse' },
  { id: 'line', label: 'Line', key: 'l', icon: 'line', shape: 'line' },
  { id: 'arrow', label: 'Arrow', key: 'a', icon: 'arrow', shape: 'arrow' },
  { id: 'highlighter', label: 'Highlighter', key: 'h', icon: 'highlighter', freehand: true },
  { id: 'pen', label: 'Pen', key: 'p', icon: 'pen', freehand: true },
];
export const tool = (id) => TOOLS.find((t) => t.id === id) || TOOLS[0];

// macOS system colours: black, red, orange, yellow, green, blue, purple, white.
export const PALETTE = ['#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff'];

export const DEFAULT_STYLE = Object.freeze({
  color: '#ff3b30', fill: null, lineWidth: 2, penWidth: 2.5, highlighterColor: '#ffcc00', highlighterWidth: 14,
});
export const HIGHLIGHT_ALPHA = 0.45;

export const isMarkup = (el) => el && (el.kind === 'shape' || el.kind === 'ink' || el.kind === 'signature');
export const isLinear = (s) => s.kind === 'line' || s.kind === 'arrow';
export const arrowHeadLength = (lw) => Math.max(9, lw * 4.5);

/** Extra room (points) around the frame that strokes and arrowheads can reach. */
export function markupPad(el) {
  if (el.kind === 'shape') return el.shape.lineWidth + arrowHeadLength(el.shape.lineWidth) / 2;
  if (el.kind === 'signature') return 1;
  return (el.ink?.lineWidth ?? 2) / 2 + 1;
}

// ------------------------------------------------------------------ geometry

const K = 0.5522847498;   // cubic Bézier circle constant

function roundedRect(x, y, w, h, r) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const c = r * K;
  return [
    ['M', x + r, y], ['L', x + w - r, y], ['C', x + w - r + c, y, x + w, y + r - c, x + w, y + r],
    ['L', x + w, y + h - r], ['C', x + w, y + h - r + c, x + w - r + c, y + h, x + w - r, y + h],
    ['L', x + r, y + h], ['C', x + r - c, y + h, x, y + h - r + c, x, y + h - r],
    ['L', x, y + r], ['C', x, y + r - c, x + r - c, y, x + r, y], ['Z'],
  ];
}

function ellipse(x, y, w, h) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, ox = rx * K, oy = ry * K;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry],
    ['C', cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ['C', cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry],
    ['C', cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ['Z'],
  ];
}

export function endpoints(s, w, h) {
  return [[s.start[0] * w, s.start[1] * h], [s.end[0] * w, s.end[1] * h]];
}

/** Outline to stroke (and fill, for closed shapes) inside a w×h frame. */
export function shapeOutline(s, w, h) {
  const lw = s.lineWidth;
  if (s.kind === 'rectangle') return roundedRect(lw / 2, lw / 2, w - lw, h - lw, s.cornerRadius || 0);
  if (s.kind === 'ellipse') return ellipse(lw / 2, lw / 2, w - lw, h - lw);
  const [a, b] = endpoints(s, w, h);
  const head = arrowHeadLength(lw);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // Stop the shaft under the arrowheads so the tips stay sharp.
  const pulled = (from, to) => {
    if (len <= 0) return from;
    const t = Math.min(0.5, (head * 0.8) / len);
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  };
  const p0 = s.kind === 'arrow' && s.arrowAtStart ? pulled(a, b) : a;
  const p1 = s.kind === 'arrow' && s.arrowAtEnd ? pulled(b, a) : b;
  return [['M', p0[0], p0[1]], ['L', p1[0], p1[1]]];
}

/** Filled arrowhead triangles (empty for other shapes). */
export function arrowHeads(s, w, h) {
  if (s.kind !== 'arrow') return [];
  const [a, b] = endpoints(s, w, h);
  const len = arrowHeadLength(s.lineWidth);
  const head = (tip, from) => {
    const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]), sp = Math.PI / 7;
    return [['M', tip[0], tip[1]],
      ['L', tip[0] - len * Math.cos(ang - sp), tip[1] - len * Math.sin(ang - sp)],
      ['L', tip[0] - len * Math.cos(ang + sp), tip[1] - len * Math.sin(ang + sp)], ['Z']];
  };
  return [...(s.arrowAtEnd ? head(b, a) : []), ...(s.arrowAtStart ? head(a, b) : [])];
}

/** Smooth stroke through points (quadratic curves through midpoints). */
export function smoothPath(pts) {
  if (!pts.length) return [];
  const out = [['M', pts[0][0], pts[0][1]]];
  if (pts.length === 1) { out.push(['L', pts[0][0] + 0.01, pts[0][1]]); return out; }
  if (pts.length === 2) { out.push(['L', pts[1][0], pts[1][1]]); return out; }
  for (let i = 1; i < pts.length - 1; i++) {
    out.push(['Q', pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]);
  }
  const last = pts[pts.length - 1];
  out.push(['L', last[0], last[1]]);
  return out;
}

export const inkPath = (ink, w, h) => smoothPath(ink.points.map(([x, y]) => [x * w, y * h]));

/** Drops points closer than `tolerance` to keep strokes light. */
export function simplify(pts, tolerance) {
  if (!pts.length) return [];
  const out = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= tolerance) { out.push(p); last = p; }
  }
  const end = pts[pts.length - 1];
  if (end !== out[out.length - 1]) out.push(end);
  return out;
}

/**
 * Draw list for a shape / ink element: [{ path, fill?, stroke?, width?, multiply? }] in local points.
 * `color(c)` maps colours (export colour modes).
 */
export function drawList(el, w, h, color = (c) => c) {
  if (el.kind === 'shape') {
    const s = el.shape, ops = [];
    const outline = shapeOutline(s, w, h);
    if (s.fill && !isLinear(s)) ops.push({ path: outline, fill: color(s.fill) });
    ops.push({ path: outline, stroke: color(s.stroke), width: s.lineWidth });
    if (s.kind === 'arrow') ops.push({ path: arrowHeads(s, w, h), fill: color(s.stroke) });
    return ops;
  }
  if (el.kind === 'ink') {
    const ink = el.ink;
    return [{ path: inkPath(ink, w, h), stroke: color(ink.color), width: ink.lineWidth, alpha: ink.highlighter ? HIGHLIGHT_ALPHA : 1, multiply: !!ink.highlighter }];
  }
  if (el.kind === 'signature') return signatureOps(el.sig, w, h, color);
  return [];
}

// ------------------------------------------------------------------ signatures

/**
 * A signature is stored in a unit box (0…1 on both axes) so it scales with its frame:
 *   { color, paths: [{ d: [[cmd, …numbers]], fill: true }]            typed (glyph outlines)
 *            strokes: [[[x, y], …]], width }                           drawn (width = share of height)
 */
export function scaleCmds(cmds, w, h) {
  return cmds.map((c) => {
    const out = [c[0]];
    for (let i = 1; i < c.length; i += 2) out.push(c[i] * w, c[i + 1] * h);
    return out;
  });
}
function signatureOps(sig, w, h, color) {
  const col = color(sig.color || '#000000');
  if (sig.paths) return [{ path: sig.paths.flatMap((p) => scaleCmds(p, w, h)), fill: col }];
  const width = Math.max(0.3, (sig.width || 0.06) * h);
  return sig.strokes.map((pts) => ({ path: smoothPath(pts.map(([x, y]) => [x * w, y * h])), stroke: col, width }));
}

// ------------------------------------------------------------------ emitters

/** SVG path data, scaled by `k`. */
export function svgPath(cmds, k = 1) {
  const f = (v) => (Math.round(v * k * 100) / 100).toString();
  return cmds.map((c) => (c[0] === 'Z' ? 'Z' : c[0] + c.slice(1).map(f).join(' '))).join('');
}

/** Replays commands onto a CanvasRenderingContext2D (in the current transform). */
export function canvasPath(ctx, cmds) {
  ctx.beginPath();
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
    else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else if (c[0] === 'Z') ctx.closePath();
  }
}

/** Draws a markup element into a 2D context whose origin is the element's top-left, in points. */
export function drawMarkupCanvas(ctx, el, color = (c) => c) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const op of drawList(el, el.w, el.h, color)) {
    ctx.save();
    if (op.multiply) ctx.globalCompositeOperation = 'multiply';
    if (op.alpha != null) ctx.globalAlpha *= op.alpha;
    canvasPath(ctx, op.path);
    if (op.fill) { ctx.fillStyle = op.fill; ctx.fill(); }
    if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.width; ctx.stroke(); }
    ctx.restore();
  }
  ctx.restore();
}

/** pdf-lib operators for the commands (current transform = element-local, Y down). */
export function pdfPathOps(L, cmds) {
  const ops = [];
  let cur = [0, 0];
  for (const c of cmds) {
    if (c[0] === 'M') { ops.push(L.moveTo(c[1], c[2])); cur = [c[1], c[2]]; }
    else if (c[0] === 'L') { ops.push(L.lineTo(c[1], c[2])); cur = [c[1], c[2]]; }
    else if (c[0] === 'Q') {
      // Quadratic → cubic.
      const [x0, y0] = cur, [qx, qy, x, y] = c.slice(1);
      ops.push(L.appendBezierCurve(x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y));
      cur = [x, y];
    } else if (c[0] === 'C') { ops.push(L.appendBezierCurve(c[1], c[2], c[3], c[4], c[5], c[6])); cur = [c[5], c[6]]; }
    else if (c[0] === 'Z') ops.push(L.closePath());
  }
  return ops;
}

export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
