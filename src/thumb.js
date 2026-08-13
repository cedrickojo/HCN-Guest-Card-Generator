/* YouTube thumbnail renderer.
 *
 * 1280x720 is the reference space: every size below is in those units and
 * `scaleFor()` maps them onto whatever output is being drawn. As in card.js,
 * that scale is strictly proportional to the output width, so the preview is
 * an exact miniature of the export — drawThumb() renders both.
 *
 * Layer order, bottom to top: background fill, background image, vignette,
 * cutouts (each with an optional halo), then text. The vignette can be lifted
 * above the cutouts when you want it to frame the whole composition rather
 * than just push the backdrop back.
 */

import { clampN, hexToRgb, makeCanvas, roundRectPath, splitLines, subjectRect, tintGlow } from './shared.js';

export { subjectRect };

export const THUMB = { W: 1280, H: 720 };

export const EXPORT_SIZES = {
  '1280x720': [1280, 720],
  '1920x1080': [1920, 1080],
};

/** YouTube rejects thumbnails over 2MB. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export function scaleFor(W) {
  return W / THUMB.W;
}

/* The two brand faces are bundled; the rest are system stacks, so they render
 * with whatever the designer's machine has. Weight is baked in per family —
 * the bundled OTFs are single weights and asking for 900 only invites the
 * browser to synthesise a fake bold. */
export const FONT_CHOICES = [
  { id: 'analog', label: 'F37 Analog', weight: 400, stack: '"F37Analog", system-ui, sans-serif' },
  { id: 'okima', label: 'RL Okima', weight: 400, stack: '"RLOkima", ui-monospace, monospace' },
  { id: 'black', label: 'Arial Black', weight: 900, stack: '"Arial Black", "Helvetica Neue", Helvetica, sans-serif' },
  { id: 'impact', label: 'Impact', weight: 400, stack: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' },
  { id: 'system', label: 'System sans', weight: 800, stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
];

const FONT_BY_ID = new Map(FONT_CHOICES.map((f) => [f.id, f]));

function applyFont(ctx, item, s) {
  const f = FONT_BY_ID.get(item.font) || FONT_CHOICES[0];
  ctx.font = `${f.weight} ${Math.round(item.size * s)}px ${f.stack}`;
}

/* ---------- background ---------- */

/** Cover-fit rect for the backdrop. `zoom` multiplies the cover scale and
 *  nx/ny pan within the resulting overflow (0.5 = centred). */
export function backgroundRect(bg, W, H) {
  if (!bg.img) return null;
  const cover = Math.max(W / bg.img.width, H / bg.img.height) * bg.zoom;
  const w = bg.img.width * cover;
  const h = bg.img.height * cover;
  return { x: (W - w) * bg.nx, y: (H - h) * bg.ny, w, h };
}

function drawBackground(ctx, W, H, bg) {
  ctx.fillStyle = bg.color;
  ctx.fillRect(0, 0, W, H);
  const r = backgroundRect(bg, W, H);
  if (!r) return;
  ctx.save();
  ctx.filter = `brightness(${bg.brightness}) contrast(${bg.contrast}) saturate(${bg.saturation})`;
  ctx.drawImage(bg.img, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/* ---------- vignette ---------- */

/* Smoothstep rather than a straight ramp: a linear vignette leaves a visible
 * band where it meets the untouched middle. */
function edgeGradient(ctx, x0, y0, x1, y1, rgb, strength) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const fade = 1 - t * t * (3 - 2 * t);
    g.addColorStop(t, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${fade * strength})`);
  }
  return g;
}

export function drawVignette(ctx, W, H, v) {
  const rgb = hexToRgb(v.color);
  const soft = clampN(v.softness, 0.02, 1);
  const dw = soft * W;
  const dh = soft * H;
  const side = (strength, grad, x, y, w, h) => {
    if (strength <= 0) return;
    ctx.fillStyle = grad();
    ctx.fillRect(x, y, w, h);
  };
  side(v.top, () => edgeGradient(ctx, 0, 0, 0, dh, rgb, v.top), 0, 0, W, dh);
  side(v.bottom, () => edgeGradient(ctx, 0, H, 0, H - dh, rgb, v.bottom), 0, H - dh, W, dh);
  side(v.left, () => edgeGradient(ctx, 0, 0, dw, 0, rgb, v.left), 0, 0, dw, H);
  side(v.right, () => edgeGradient(ctx, W, 0, W - dw, 0, rgb, v.right), W - dw, 0, dw, H);
}

/* ---------- cutouts ---------- */

/* The halo is built on a canvas cropped to the subject's bounds plus the blur
 * spread, not a full-frame one. With several subjects redrawing on every drag
 * frame, a full-frame getImageData each is the difference between smooth and
 * unusable. */
function drawGlow(ctx, sub, r, s) {
  const g = sub.glow;
  const spread = Math.max(1, g.size * s);
  const gx = Math.floor(r.x - spread);
  const gy = Math.floor(r.y - spread);
  const gw = Math.ceil(r.w + spread * 2);
  const gh = Math.ceil(r.h + spread * 2);
  if (gw <= 0 || gh <= 0) return;
  const cv = makeCanvas(gw, gh);
  const gctx = cv.getContext('2d', { willReadFrequently: true });
  gctx.filter = `blur(${spread / 3}px)`;
  gctx.drawImage(sub.img, r.x - gx, r.y - gy, r.w, r.h);
  gctx.filter = 'none';
  tintGlow(gctx, gw, gh, hexToRgb(g.color), g.opacity);
  ctx.drawImage(cv, gx, gy);
}

/* ---------- text ---------- */

/** Per-line geometry for a text block: where each line draws, and the tight
 *  box around its glyphs that a highlight fills. Also the union bounds, which
 *  is what hit-testing and the selection outline use. */
export function textLayout(ctx, item, W, H, s) {
  if (!item.show) return null;
  const lines = splitLines(item.upper ? String(item.text).toUpperCase() : item.text);
  applyFont(ctx, item, s);
  ctx.textBaseline = 'alphabetic';
  const size = item.size * s;
  const lineH = size * item.lineGap;
  const probe = ctx.measureText('Hg');
  const ascent = probe.fontBoundingBoxAscent || size * 0.8;
  const padX = item.highlight.padX * s;
  const padY = item.highlight.padY * s;
  const originX = item.nx * W;
  const top = item.ny * H;

  const out = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  lines.forEach((text, i) => {
    const m = ctx.measureText(text);
    const w = m.width;
    const x = item.align === 'center' ? originX - w / 2 : item.align === 'right' ? originX - w : originX;
    const baseline = top + ascent + i * lineH;
    // actualBoundingBox hugs the glyphs, so the highlight sits on the cap
    // height instead of floating on the font's full line box
    const a = m.actualBoundingBoxAscent || size * 0.72;
    const d = m.actualBoundingBoxDescent || 0;
    const box = text ? { x: x - padX, y: baseline - a - padY, w: w + 2 * padX, h: a + d + 2 * padY } : null;
    out.push({ text, x, baseline, w, box });
    const l = box ? box.x : x;
    const rt = box ? box.x + box.w : x + w;
    const t = box ? box.y : baseline - a;
    const b = box ? box.y + box.h : baseline + d;
    if (l < minX) minX = l;
    if (rt > maxX) maxX = rt;
    if (t < minY) minY = t;
    if (b > maxY) maxY = b;
  });

  if (!out.length) return null;
  return { lines: out, x: minX, y: minY, w: maxX - minX, h: maxY - minY, lineH, size };
}

function drawText(ctx, item, W, H, s) {
  const L = textLayout(ctx, item, W, H, s);
  if (!L) return;
  applyFont(ctx, item, s);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // every highlight box first, then every line — otherwise a tall box on line
  // two paints over the descenders of line one
  if (item.highlight.on) {
    ctx.fillStyle = item.highlight.color;
    for (const ln of L.lines) {
      if (!ln.box) continue;
      roundRectPath(ctx, ln.box.x, ln.box.y, ln.box.w, ln.box.h, item.highlight.radius * s);
      ctx.fill();
    }
  }
  ctx.fillStyle = item.color;
  for (const ln of L.lines) ctx.fillText(ln.text, ln.x, ln.baseline);
}

/* ---------- the thumbnail ---------- */

export function drawThumb(ctx, W, H, state, opts = {}) {
  const s = scaleFor(W);
  ctx.save();
  ctx.clearRect(0, 0, W, H);

  drawBackground(ctx, W, H, state.bg);
  if (!state.vignette.overSubjects) drawVignette(ctx, W, H, state.vignette);

  for (const sub of [...state.subjects].sort((a, b) => a.z - b.z)) {
    const r = subjectRect(sub, W, H);
    if (sub.glow.on) drawGlow(ctx, sub, r, s);
    ctx.drawImage(sub.img, r.x, r.y, r.w, r.h);
  }

  if (state.vignette.overSubjects) drawVignette(ctx, W, H, state.vignette);

  for (const item of state.texts) drawText(ctx, item, W, H, s);

  /* selection affordance — preview only, never exported */
  if (opts.selection) {
    const sel = opts.selection;
    ctx.strokeStyle = '#ff655c';
    ctx.lineWidth = Math.max(1.5, 3 * s);
    ctx.setLineDash([10 * s, 7 * s]);
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
  }
  ctx.restore();
}

export async function exportThumb(state, size, format, quality) {
  const [W, H] = EXPORT_SIZES[size] || EXPORT_SIZES['1280x720'];
  const cv = makeCanvas(W, H);
  drawThumb(cv.getContext('2d'), W, H, state);
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  if (cv.convertToBlob) return cv.convertToBlob({ type, quality });
  return new Promise((res) => cv.toBlob(res, type, quality));
}
