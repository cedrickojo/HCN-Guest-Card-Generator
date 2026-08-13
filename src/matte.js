/* Matte compositing — turning a segmentation mask plus the original image into
 * a cutout, with the edge under your control.
 *
 * The model runs once and its matte is kept; everything here is a local
 * recomposite, so dragging these sliders is instant rather than another few
 * seconds of inference.
 *
 * Why these four knobs: a matte that fails on dark hair or dark skin against a
 * dark set fails in recognisable ways — the subject goes half-transparent
 * where the model was unsure, and a rim of the old background survives around
 * the edge. `hardness` pushes the unsure pixels to a decision, `shift` walks
 * the boundary in or out, `softness` puts a natural edge back, and `clean`
 * pulls interior colour outward over whatever rim is left.
 */

import { clampN, makeCanvas } from './shared.js';

export const DEFAULT_MATTE = { softness: 0, shift: 0, hardness: 1, clean: 0 };

/* ---------- touch-up strokes ----------
 *
 * Manual overrides for where the model was flat wrong — a watch that severed
 * a hand, a wisp of set that survived by the head. Strokes are stored as
 * vector data (mode, size, feather, points) in SOURCE-image coordinates, not
 * as bitmaps: that keeps them valid across crop and matte changes, makes each
 * stroke one cheap undo entry, and costs a replay instead of megabytes.
 *
 * Rendered onto one canvas: restore strokes paint white, erase strokes paint
 * black, soft-edged via a radial gradient whose solid core shrinks as feather
 * grows. composeCutout() reads it as a signed nudge on the matte: white
 * forces pixels in, black forces them out, at the stroke's own opacity.
 */

export function renderStrokes(strokes, w, h) {
  if (!strokes || !strokes.length) return null;
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  for (const st of strokes) {
    const col = st.mode === 'add' ? '255,255,255' : '0,0,0';
    const r = Math.max(1, st.size);
    // a gradient whose inner radius equals its outer is degenerate and paints
    // nothing at all, so a hard brush (feather 0) must stop just short of it
    const core = Math.min(r - 0.5, r * (1 - clampN(st.feather ?? 0.5, 0, 0.95)));
    const stamp = (x, y) => {
      const g = ctx.createRadialGradient(x, y, core, x, y, r);
      g.addColorStop(0, `rgba(${col},1)`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    let prev = null;
    for (const [x, y] of st.points) {
      if (prev) {
        const d = Math.hypot(x - prev[0], y - prev[1]);
        const step = Math.max(r * 0.25, 1);
        for (let t = step; t < d; t += step) stamp(prev[0] + ((x - prev[0]) * t) / d, prev[1] + ((y - prev[1]) * t) / d);
      }
      stamp(x, y);
      prev = [x, y];
    }
  }
  return cv;
}

/* Defaults are the identity transform: softness 0, shift 0, hardness 1 leaves
 * the model's matte exactly as it came, so an untouched import matches what
 * the tool produced before any of this existed. */

/** Replace the colour of partly-transparent edge pixels with colour drawn from
 *  their more-opaque neighbours, which is what removes a background halo. */
function decontaminate(d, w, h, iterations) {
  for (let k = 0; k < iterations; k++) {
    const src = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const a = src[i + 3];
        if (a === 0 || a > 250) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let wt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = ((y + dy) * w + (x + dx)) * 4;
            const aj = src[j + 3];
            if (aj <= a) continue;
            const q = aj / 255;
            r += src[j] * q;
            g += src[j + 1] * q;
            b += src[j + 2] * q;
            wt += q;
          }
        }
        if (wt > 0) {
          d[i] = r / wt;
          d[i + 1] = g / wt;
          d[i + 2] = b / wt;
        }
      }
    }
  }
}

/**
 * @param source  the original image, at full resolution
 * @param mask    segmentation matte carried in its alpha channel; resized to
 *                the source if the model returned it at a different size
 * @param m       {softness, shift, hardness, clean}
 * @param touch   optional source-sized canvas from renderStrokes(); white
 *                pixels force the matte in, black pixels force it out
 * @returns a canvas holding the composited cutout
 */
export function composeCutout(source, mask, m = DEFAULT_MATTE, touch = null) {
  const w = source.width;
  const h = source.height;

  const mc = makeCanvas(w, h);
  const mx = mc.getContext('2d', { willReadFrequently: true });
  if (m.softness > 0) mx.filter = `blur(${m.softness}px)`;
  mx.drawImage(mask, 0, 0, w, h);
  mx.filter = 'none';
  const mdata = mx.getImageData(0, 0, w, h).data;

  const cv = makeCanvas(w, h);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(source, 0, 0);
  const img = cx.getImageData(0, 0, w, h);
  const d = img.data;

  // blur first, then threshold: thresholding a blurred matte above 0.5 erodes
  // it and below 0.5 dilates it, which is a far cheaper choke/spread than a
  // real morphological pass and is indistinguishable at these radii
  // getImageData is un-premultiplied, so a half-opacity black stroke reads
  // r=0/a=128 and the signed term below behaves for soft edges and for
  // white-over-black overlaps alike
  const tdata = touch ? touch.getContext('2d').getImageData(0, 0, w, h).data : null;

  const level = 0.5 - m.shift * 0.45;
  const gain = m.hardness;
  const n = w * h;
  for (let i = 0, p = 3; i < n; i++, p += 4) {
    let o = 0.5 + (mdata[p] / 255 - level) * gain;
    if (tdata) {
      const ta = tdata[p] / 255;
      if (ta > 0) o += ((tdata[p - 3] / 255) * 2 - 1) * ta;
    }
    d[p] = o <= 0 ? 0 : o >= 1 ? 255 : o * 255;
  }

  if (m.clean > 0) decontaminate(d, w, h, m.clean);

  cx.putImageData(img, 0, 0);
  return cv;
}
