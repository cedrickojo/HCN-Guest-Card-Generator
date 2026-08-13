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

import { clampN, hexToRgb, makeCanvas, roundRectPath, sourceRect, splitLines, subjectRect, tintGlow } from './shared.js';

export { sourceRect, subjectRect };

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
  const { sx, sy, sw, sh } = sourceRect(sub);
  gctx.filter = `blur(${spread / 3}px)`;
  gctx.drawImage(sub.img, sx, sy, sw, sh, r.x - gx, r.y - gy, r.w, r.h);
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

/* ---------- crop ---------- */

/** Where the subject's *whole* image would sit if it weren't cropped, given
 *  that the cropped region must stay exactly where it is on the canvas. That
 *  is the frame you drag a crop box inside. */
export function cropFrame(sub, W, H) {
  const box = subjectRect(sub, W, H);
  const c = sub.crop || { x: 0, y: 0, w: 1, h: 1 };
  const pxPerSrc = box.w / (c.w * sub.img.width);
  return {
    box,
    full: {
      x: box.x - c.x * sub.img.width * pxPerSrc,
      y: box.y - c.y * sub.img.height * pxPerSrc,
      w: sub.img.width * pxPerSrc,
      h: sub.img.height * pxPerSrc,
    },
  };
}

/** Screen-space box back to a normalised crop, clamped inside the image. */
export function boxToCrop(full, box) {
  const x = clampN((box.x - full.x) / full.w, 0, 1);
  const y = clampN((box.y - full.y) / full.h, 0, 1);
  const w = clampN(box.w / full.w, 0.02, 1 - x);
  const h = clampN(box.h / full.h, 0.02, 1 - y);
  return { x, y, w, h };
}

/* ---------- overlays ---------- */

export function overlayRect(ov, W, H) {
  const h = ov.scale * H;
  const w = (ov.img.width / ov.img.height) * h;
  return { x: ov.nx * W - w / 2, y: ov.ny * H - h / 2, w, h };
}

function drawOverlays(ctx, W, H, overlays, front) {
  for (const ov of [...overlays].sort((a, b) => a.z - b.z)) {
    if (!ov.show || !!ov.front !== front) continue;
    const r = overlayRect(ov, W, H);
    ctx.save();
    ctx.globalAlpha = ov.opacity;
    ctx.drawImage(ov.img, r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

/** Same three controls as the backdrop, per headshot. Returns null when all
 *  are neutral so the common case skips the filter entirely. */
function subjectFilter(sub) {
  const a = sub.adjust;
  if (!a || (a.brightness === 1 && a.contrast === 1 && a.saturation === 1)) return null;
  return `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})`;
}

/* ---------- the thumbnail ---------- */

export function drawThumb(ctx, W, H, state, opts = {}) {
  const s = scaleFor(W);
  ctx.save();
  ctx.clearRect(0, 0, W, H);

  drawBackground(ctx, W, H, state.bg);
  if (!state.vignette.overSubjects) drawVignette(ctx, W, H, state.vignette);

  const cropping = opts.cropping;
  for (const sub of [...state.subjects].sort((a, b) => a.z - b.z)) {
    const filt = subjectFilter(sub);
    if (cropping && cropping.id === sub.id) {
      // while cropping, the subject shows whole so you can see what you are
      // cutting away; the halo would only trace a silhouette about to change
      const f = cropping.frame.full;
      ctx.save();
      if (filt) ctx.filter = filt;
      ctx.drawImage(sub.img, f.x, f.y, f.w, f.h);
      ctx.restore();
      continue;
    }
    const r = subjectRect(sub, W, H);
    if (sub.glow.on) drawGlow(ctx, sub, r, s);
    const { sx, sy, sw, sh } = sourceRect(sub);
    ctx.save();
    if (filt) ctx.filter = filt;
    ctx.drawImage(sub.img, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  drawOverlays(ctx, W, H, state.overlays || [], false);

  if (state.vignette.overSubjects) drawVignette(ctx, W, H, state.vignette);

  for (const item of state.texts) drawText(ctx, item, W, H, s);

  drawOverlays(ctx, W, H, state.overlays || [], true);

  if (cropping) drawCropOverlay(ctx, W, H, cropping.box, s);

  /* brush cursor — outer ring at full radius, dashed inner ring at the solid
   * core so the feather band is visible before you commit a stroke */
  if (opts.brush) {
    const b = opts.brush;
    ctx.save();
    ctx.strokeStyle = b.mode === 'add' ? '#6fe08c' : '#ff655c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.stroke();
    if (b.feather > 0.02) {
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, Math.max(1, b.r * (1 - b.feather)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

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

/* Everything outside the crop box goes dim, the box itself gets corner ticks —
 * the standard crop affordance, drawn on the canvas so it lines up exactly
 * with the pixels it describes. */
function drawCropOverlay(ctx, W, H, box, s) {
  ctx.save();
  // dim the whole frame, not just the subject's bounds — a partial scrim reads
  // as a rendering artefact rather than as "this is what you're keeping"
  ctx.fillStyle = 'rgba(8,8,12,0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.fill('evenodd');

  ctx.strokeStyle = '#ff655c';
  ctx.lineWidth = Math.max(1.5, 2.5 * s);
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, 5 * s);
  const t = Math.min(box.w, box.h) * 0.16;
  for (const [cx, cy, dx, dy] of [
    [box.x, box.y, 1, 1],
    [box.x + box.w, box.y, -1, 1],
    [box.x, box.y + box.h, 1, -1],
    [box.x + box.w, box.y + box.h, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * t, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * t);
    ctx.stroke();
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
