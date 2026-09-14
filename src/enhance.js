/* Cloud enhance — the website's fal.ai pipeline, from the browser side.
 *
 * Talks only to our own /api/enhance; the fal key never comes here. The
 * browser does the normalisation the site's server did with sharp: cap the
 * long edge, flatten any transparency onto white (the RGB under alpha 0 is
 * garbage and upscalers hallucinate edges around it), send JPEG so the
 * request stays well inside the function's 4.5 MB body limit.
 *
 * Results come back as fal-hosted URLs. They are fetched directly first; if
 * the CDN refuses the cross-origin request, the same URL goes through
 * /api/fetch, which streams it from the server. */

const SEND_EDGE = 2048; // 2× from here already reaches 4096, past what any card needs

let statusPromise = null;

/** GET /api/enhance, memoised — tells the UI whether a key is configured. */
export function cloudStatus(force = false) {
  if (!statusPromise || force) {
    statusPromise = fetch('/api/enhance', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { ok: false, configured: false }))
      .catch(() => ({ ok: false, configured: false }));
  }
  return statusPromise;
}

function tokenHeader() {
  let t = '';
  try {
    t = localStorage.getItem('hcn.enhanceToken') || '';
  } catch {
    /* storage blocked */
  }
  return t ? { 'x-enhance-token': t } : {};
}

async function toSendable(source) {
  const bmp = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const k = Math.min(1, SEND_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  return { dataUri: c.toDataURL('image/jpeg', 0.92), width: w, height: h };
}

async function fetchImage(url) {
  const tryFetch = async (u) => {
    const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return createImageBitmap(await r.blob());
  };
  try {
    return await tryFetch(url);
  } catch {
    return tryFetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  }
}

/**
 * @param source   File | Blob | ImageBitmap
 * @param opts     { upscale, removeBackground, upscaler, remover }
 * @param onProgress (message) => void
 * @returns { upscaled: ImageBitmap|null, cutout: ImageBitmap|null, steps }
 */
export async function cloudEnhance(source, opts = {}, onProgress) {
  const say = (m) => onProgress && onProgress(m);
  say('Preparing');
  const { dataUri, width, height } = await toSendable(source);
  const wantUp = opts.upscale !== false;
  const wantCut = opts.removeBackground !== false;
  say(wantUp && wantCut ? 'Upscaling + cutting out (cloud)' : wantUp ? 'Upscaling (cloud)' : 'Cutting out (cloud)');
  const r = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeader() },
    body: JSON.stringify({
      image: dataUri,
      width,
      height,
      upscale: wantUp,
      removeBackground: wantCut,
      upscaler: opts.upscaler,
      remover: opts.remover,
    }),
  });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* non-JSON error page */
  }
  if (!r.ok || !j?.ok) throw new Error(j?.error || `enhance failed (${r.status})`);
  say('Downloading result');
  const [upscaled, cutout] = await Promise.all([
    j.upscaled ? fetchImage(j.upscaled) : null,
    j.cutout ? fetchImage(j.cutout) : null,
  ]);
  return { upscaled, cutout, steps: j.steps || [] };
}
