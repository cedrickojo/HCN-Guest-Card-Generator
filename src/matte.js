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

import { makeCanvas } from './shared.js';

export const DEFAULT_MATTE = { softness: 0, shift: 0, hardness: 1, clean: 0 };

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
 * @returns a canvas holding the composited cutout
 */
export function composeCutout(source, mask, m = DEFAULT_MATTE) {
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
  const level = 0.5 - m.shift * 0.45;
  const gain = m.hardness;
  const n = w * h;
  for (let i = 0, p = 3; i < n; i++, p += 4) {
    const o = 0.5 + (mdata[p] / 255 - level) * gain;
    d[p] = o <= 0 ? 0 : o >= 1 ? 255 : o * 255;
  }

  if (m.clean > 0) decontaminate(d, w, h, m.clean);

  cx.putImageData(img, 0, 0);
  return cv;
}
