/* Background removal.
 *
 * Runs entirely in the browser: the ONNX model and WASM runtime are fetched
 * from IMG.LY's CDN on first use (~40MB, then cached by the browser), and the
 * image never leaves the machine. That is what makes this deployable to Vercel
 * as a static site — no serverless function, no 250MB bundle limit, no cold
 * starts, and no per-image cost.
 *
 * LICENSING: @imgly/background-removal is AGPL-3.0. If this app is served to
 * anyone over a network, AGPL section 13 requires you to offer them the app's
 * source. Fine for an internal HCN tool or an open repo; not fine for a closed
 * commercial product. IMG.LY sells commercial licenses.
 *
 * TO SWAP PROVIDERS: replace the bodies of cutout() and alphaMatte() only.
 * Everything else treats them as
 *   cutout:     (File, onProgress) => Promise<Blob>       // RGBA foreground
 *   alphaMatte: (File, model, onProgress) => Promise<Blob> // matte in alpha
 * Drop-in options:
 *   - your own endpoint running the skill's Python rembg pipeline
 *   - onnxruntime-web + u2net_human_seg.onnx (Apache-2.0, ~176MB download)
 *   - a hosted API (remove.bg, Replicate) — costs money, needs a key proxy
 */
import { removeBackground, segmentForeground } from '@imgly/background-removal';

/* The library's own default is "medium" = isnet_fp16. Half precision is where
 * mattes tend to fall apart on dark hair and dark skin against dark sets —
 * the very case this show hits constantly — so the thumbnail tool asks for
 * full precision and lets you drop down if you want the speed. */
export const MODELS = [
  { id: 'isnet', label: 'Best — full precision', note: 'Slowest, cleanest edges' },
  { id: 'isnet_fp16', label: 'Balanced — half precision', note: "The library's default" },
  { id: 'isnet_quint8', label: 'Fast — quantised', note: 'Roughest on dark tones' },
];

export const DEFAULT_MODEL = 'isnet';

function reporter(onProgress) {
  return (key, current, total) => {
    if (!onProgress) return;
    const pct = total ? Math.round((current / total) * 100) : 0;
    onProgress(key.startsWith('fetch') ? `Loading model ${pct}%` : `Cutting out ${pct}%`);
  };
}

/** Foreground with the background knocked out, as an RGBA PNG. */
export async function cutout(file, onProgress, model) {
  return removeBackground(file, {
    ...(model ? { model } : {}),
    output: { format: 'image/png', quality: 1 },
    progress: reporter(onProgress),
  });
}

/** Just the segmentation matte, carried in the alpha channel of a white PNG.
 *
 * Keeping the matte separate from the source image is what makes re-cutting
 * cheap: edge level, feather, choke and decontamination are all recomposited
 * locally in composeCutout(), and only a change of model costs another
 * inference run. */
export async function alphaMatte(file, model, onProgress) {
  return segmentForeground(file, {
    model: model || DEFAULT_MODEL,
    output: { format: 'image/png', quality: 1 },
    progress: reporter(onProgress),
  });
}
