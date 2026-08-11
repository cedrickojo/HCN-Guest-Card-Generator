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
 * TO SWAP PROVIDERS: replace the body of cutout() only. Everything else in the
 * app treats it as `(File, onProgress) => Promise<Blob>`. Drop-in options:
 *   - your own endpoint running the skill's Python rembg pipeline
 *   - onnxruntime-web + u2net_human_seg.onnx (Apache-2.0, ~176MB download)
 *   - a hosted API (remove.bg, Replicate) — costs money, needs a key proxy
 */
import { removeBackground } from '@imgly/background-removal';

export async function cutout(file, onProgress) {
  return removeBackground(file, {
    output: { format: 'image/png', quality: 1 },
    progress: (key, current, total) => {
      if (!onProgress) return;
      const pct = total ? Math.round((current / total) * 100) : 0;
      onProgress(key.startsWith('fetch') ? `Loading model ${pct}%` : `Cutting out ${pct}%`);
    },
  });
}
