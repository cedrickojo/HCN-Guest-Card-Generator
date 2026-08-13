/* Helpers shared by the guest-card and thumbnail renderers.
 *
 * These were originally private to card.js. They live here so the two
 * renderers can't drift apart on the things that must agree — colour parsing,
 * how `||` splits a line, and how a placed image is measured. */

export const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export const CORAL = [255, 101, 85];

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return CORAL.slice();
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** Split on real newlines or the `||` escape, dropping blank lines unless the
 *  whole field is blank (so an empty field still measures as one empty line). */
export function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n|\|\|/)
    .map((t) => t.trim())
    .filter((t, i, a) => t.length > 0 || a.length === 1);
}

/** A placed image, sized as a fraction of canvas height and centred on nx/ny. */
export function subjectRect(sub, W, H) {
  const h = sub.scale * H;
  const w = (sub.img.width / sub.img.height) * h;
  return { x: sub.nx * W - w / 2, y: sub.ny * H - h / 2, w, h };
}

/** Colour a blurred silhouette and lift its falloff with a square-root curve —
 *  the coral halo from the guest cards, reused for thumbnail cutouts. */
export function tintGlow(ctx, w, h, rgb, opacity) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rgb[0];
    d[i + 1] = rgb[1];
    d[i + 2] = rgb[2];
    d[i + 3] = Math.sqrt(d[i + 3] / 255) * opacity * 255;
  }
  ctx.putImageData(img, 0, 0);
}
