/* POST /api/enhance — the website's guest-photo pipeline, for the studio.
 *
 * A straight port of hcn-database's lib/photos/{fal,catalog,pipeline}.ts minus
 * the Supabase storage: the browser sends the normalised image, fal.ai does
 * the work, the browser fetches the results. FAL_KEY lives here and nowhere
 * else — this static site has no other secret, and a key in the client
 * bundle is a key on the internet.
 *
 * Body:  { image: dataURI, upscale?: bool, removeBackground?: bool,
 *          upscaler?: id | {model, params}, remover?: id | {model, params} }
 * Reply: { ok, upscaled: url|null, cutout: url|null, steps: string[] }
 *        — fal-hosted URLs; the client fetches them (or via /api/fetch when
 *        the CDN won't answer a cross-origin request).
 * GET:   { ok, configured, defaults, models }  — so the client can hide the
 *        cloud options when there is no key.
 *
 * Costs are per call (fal list prices, September 2026): Topaz $0.08/image,
 * Bria $0.018/image. There is no quota here; the origin check and optional
 * ENHANCE_TOKEN are what stand between the key and a stranger's headshots.
 */

const FAL_RUN = 'https://fal.run';
const FAL_REST = 'https://rest.alpha.fal.ai';

/* ---------- catalog (ids, endpoints, typed params) ---------- */

const SCALE = { key: 'scale', kind: 'select', choices: ['auto', '2', '3', '4'], default: 'auto' };

export const UPSCALERS = [
  {
    id: 'topaz',
    endpoint: 'fal-ai/topaz/upscale/image',
    name: 'Topaz Gigapixel',
    price: '$0.08 / image',
    fields: [
      SCALE,
      { key: 'model', kind: 'select', choices: ['Standard V2', 'High Fidelity V2', 'Low Resolution V2', 'Recovery V2'], default: 'Standard V2' },
      { key: 'face_enhancement', kind: 'boolean', default: true },
      { key: 'face_enhancement_strength', kind: 'number', min: 0, max: 1, default: 0.8 },
      { key: 'face_enhancement_creativity', kind: 'number', min: 0, max: 1, default: 0 },
      { key: 'fix_compression', kind: 'number', min: 0, max: 1, default: null },
      { key: 'denoise', kind: 'number', min: 0, max: 1, default: null },
      { key: 'sharpen', kind: 'number', min: 0, max: 1, default: null },
    ],
  },
  {
    id: 'seedvr',
    endpoint: 'fal-ai/seedvr/upscale/image',
    name: 'SeedVR2',
    price: '$0.001 / megapixel',
    fields: [SCALE, { key: 'noise_scale', kind: 'number', min: 0, max: 1, default: 0.1 }],
  },
  {
    id: 'crystal',
    endpoint: 'clarityai/crystal-upscaler',
    name: 'Crystal (Clarity AI)',
    price: '$0.016 / megapixel',
    fields: [SCALE, { key: 'creativity', kind: 'number', min: 0, max: 10, default: 0 }],
  },
  {
    id: 'clarity',
    endpoint: 'fal-ai/clarity-upscaler',
    name: 'Clarity Upscaler',
    price: '$0.03 / megapixel',
    fields: [
      SCALE,
      { key: 'creativity', kind: 'number', min: 0, max: 1, default: 0.35 },
      { key: 'resemblance', kind: 'number', min: 0, max: 1, default: 0.6 },
      { key: 'prompt', kind: 'text', default: 'masterpiece, best quality, highres' },
    ],
  },
  { id: 'recraft-crisp', endpoint: 'fal-ai/recraft/upscale/crisp', name: 'Recraft Crisp', price: '$0.004 / image', fields: [] },
  {
    id: 'ideogram',
    endpoint: 'fal-ai/ideogram/upscale',
    name: 'Ideogram Upscale',
    price: '$0.06 / image',
    fields: [
      { key: 'resemblance', kind: 'number', min: 1, max: 100, default: 50 },
      { key: 'detail', kind: 'number', min: 1, max: 100, default: 50 },
    ],
  },
  {
    id: 'esrgan',
    endpoint: 'fal-ai/esrgan',
    name: 'Real-ESRGAN',
    price: 'GPU seconds',
    fields: [
      SCALE,
      { key: 'model', kind: 'select', choices: ['RealESRGAN_x4plus', 'RealESRGAN_x2plus', 'RealESRGAN_x4_v3'], default: 'RealESRGAN_x4plus' },
      { key: 'face', kind: 'boolean', default: false },
    ],
  },
  { id: 'aura', endpoint: 'fal-ai/aura-sr', name: 'AuraSR', price: 'GPU seconds', fields: [{ key: 'checkpoint', kind: 'select', choices: ['v2', 'v1'], default: 'v2' }] },
];

export const REMOVERS = [
  { id: 'bria', endpoint: 'fal-ai/bria/background/remove', name: 'Bria RMBG 2.0', price: '$0.018 / image', fields: [] },
  {
    id: 'birefnet',
    endpoint: 'fal-ai/birefnet/v2',
    name: 'BiRefNet v2',
    price: 'GPU seconds',
    fields: [
      { key: 'model', kind: 'select', choices: ['General Use (Light)', 'General Use (Heavy)', 'General Use (Light 2K)', 'Portrait', 'Matting'], default: 'General Use (Light)' },
      { key: 'operating_resolution', kind: 'select', choices: ['1024x1024', '2048x2048'], default: '1024x1024' },
      { key: 'refine_foreground', kind: 'boolean', default: true },
    ],
  },
  { id: 'ben2', endpoint: 'fal-ai/ben/v2/image', name: 'BEN2', price: '$0.025 / megapixel', fields: [] },
];

const DEFAULT_UPSCALER = 'topaz';
const DEFAULT_REMOVER = 'bria';
const MAX_FACTOR = 4;
const TARGET_EDGE = 2048; // what "auto" aims to fill, as on the site
const MAX_UPSCALED_PIXELS = 24_000_000; // Topaz's first price tier

/* Untrusted params in, exactly the catalog's keys out — typed, clamped,
 * defaulted. Nothing else reaches fal. */
function sanitize(spec, raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const f of spec.fields) {
    const v = input[f.key];
    if (f.kind === 'select') out[f.key] = typeof v === 'string' && f.choices.includes(v) ? v : f.default;
    else if (f.kind === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      out[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.default;
    } else if (f.kind === 'boolean') out[f.key] = typeof v === 'boolean' ? v : f.default;
    else if (f.kind === 'text') out[f.key] = typeof v === 'string' ? v.trim().slice(0, 500) : f.default;
  }
  return out;
}

function choose(list, req, fallback) {
  const id = typeof req === 'string' ? req : req && typeof req.model === 'string' ? req.model : fallback;
  const spec = list.find((m) => m.id === id);
  if (!spec) throw httpError(400, `Unknown model "${id}". Choose one of: ${list.map((m) => m.id).join(', ')}.`);
  return { spec, params: sanitize(spec, req && typeof req === 'object' ? req.params : {}) };
}

/* ---------- fal ---------- */

function falKey() {
  const key = process.env.FAL_KEY?.trim();
  return key && /^[\x20-\x7E]+$/.test(key) ? key : null;
}

async function falRun(endpoint, input) {
  const res = await fetch(`${FAL_RUN}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) throw httpError(502, `fal ${endpoint} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function firstUrl(out, name) {
  const url = out?.image?.url ?? out?.images?.[0]?.url;
  if (!url) throw httpError(502, `${name} returned no image.`);
  return url;
}

/* The models fetch their input by URL. fal's own client parks uploads in
 * fal's CDN via the storage API; do the same, and fall back to handing the
 * data URI straight to the model if the storage call is refused. */
async function stage(dataUri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUri);
  if (!m) throw httpError(400, 'image must be a base64 image data URI');
  const contentType = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  try {
    const init = await fetch(`${FAL_REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
      method: 'POST',
      headers: { Authorization: `Key ${falKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: contentType, file_name: `studio.${contentType.split('/')[1] === 'jpeg' ? 'jpg' : 'png'}` }),
    });
    if (!init.ok) throw new Error(`initiate ${init.status}`);
    const { upload_url: uploadUrl, file_url: fileUrl } = await init.json();
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes });
    if (!put.ok) throw new Error(`put ${put.status}`);
    return { url: fileUrl, staged: true };
  } catch (err) {
    console.warn('fal storage staging failed, sending inline:', err.message);
    return { url: dataUri, staged: false };
  }
}

function upscaleInput(spec, params, imageUrl, factor) {
  const input = { image_url: imageUrl };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  switch (spec.id) {
    case 'topaz':
      Object.assign(input, {
        model: params.model,
        upscale_factor: factor,
        face_enhancement: params.face_enhancement === true,
        face_enhancement_strength: num(params.face_enhancement_strength) ?? 0.8,
        face_enhancement_creativity: num(params.face_enhancement_creativity) ?? 0,
        output_format: 'png',
      });
      for (const k of ['fix_compression', 'denoise', 'sharpen']) if (num(params[k]) !== undefined) input[k] = params[k];
      break;
    case 'seedvr':
      Object.assign(input, { upscale_mode: 'factor', upscale_factor: factor, noise_scale: num(params.noise_scale) ?? 0.1, output_format: 'png' });
      break;
    case 'crystal':
      Object.assign(input, { scale_factor: factor, creativity: num(params.creativity) ?? 0, output_format: 'png' });
      break;
    case 'clarity':
      Object.assign(input, { upscale_factor: factor, creativity: num(params.creativity) ?? 0.35, resemblance: num(params.resemblance) ?? 0.6, prompt: params.prompt });
      break;
    case 'ideogram':
      Object.assign(input, { resemblance: num(params.resemblance) ?? 50, detail: num(params.detail) ?? 50 });
      break;
    case 'esrgan':
      Object.assign(input, { model: params.model, scale: factor, face: params.face === true, output_format: 'png' });
      break;
    case 'aura':
      Object.assign(input, { checkpoint: params.checkpoint, upscaling_factor: 4 });
      break;
    // recraft-crisp: image_url only
  }
  return input;
}

function removerInput(spec, params, imageUrl) {
  const input = { image_url: imageUrl };
  if (spec.id === 'birefnet') {
    Object.assign(input, {
      model: params.model,
      operating_resolution: params.operating_resolution,
      refine_foreground: params.refine_foreground !== false,
      output_format: 'png',
    });
  }
  return input;
}

/* "auto" = the smallest factor that fills 2048 px, ≤ 4×, ≤ 24 MP upscaled;
 * ≤ 1 means the photo is already big enough and the call is skipped. */
function pickFactor(params, w, h, steps) {
  const wanted = params.scale;
  const explicit = typeof wanted === 'string' && wanted !== 'auto' ? Number(wanted) : 0;
  if (!(w > 0 && h > 0)) {
    // no dimensions from the caller: nothing to size "auto" against, so take
    // the explicit factor or a plain 2× rather than silently skipping
    const factor = explicit || 2;
    steps.push(`dimensions not supplied — upscaling ${factor}×`);
    return factor;
  }
  const needed = Math.ceil(TARGET_EDGE / Math.max(w, h));
  const requested = explicit || Math.min(MAX_FACTOR, needed);
  const byPixels = Math.floor(Math.sqrt(MAX_UPSCALED_PIXELS / (w * h)));
  const factor = Math.min(requested, byPixels);
  if (factor > 1 && factor < requested) steps.push(`scale limited to ${factor}× (24 MP cap)`);
  if (!(factor > 1)) {
    steps.push(`upscale skipped — ${w}×${h} already fills ${TARGET_EDGE} px`);
    return 0;
  }
  return factor;
}

/* ---------- request plumbing ---------- */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/* Same-origin only. A key that anyone's page can spend is not a secret. */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin navigation: no Origin header
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (originHost === host) return true;
  const extra = (process.env.ENHANCE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

function tokenOk(req) {
  const want = process.env.ENHANCE_TOKEN?.trim();
  if (!want) return true;
  return (req.headers['x-enhance-token'] || '') === want;
}

export function status() {
  const strip = (m) => ({ id: m.id, name: m.name, price: m.price, fields: m.fields.map((f) => ({ ...f })) });
  return {
    ok: true,
    configured: falKey() !== null,
    tokenRequired: !!process.env.ENHANCE_TOKEN?.trim(),
    defaults: { upscaler: DEFAULT_UPSCALER, remover: DEFAULT_REMOVER },
    models: { upscalers: UPSCALERS.map(strip), removers: REMOVERS.map(strip) },
  };
}

/** The pipeline itself, separated from HTTP so it can be exercised directly. */
export async function enhance(body) {
  const upscale = body.upscale !== false;
  const removeBackground = body.removeBackground !== false;
  if (!upscale && !removeBackground) throw httpError(400, 'Pick at least one step.');
  if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) throw httpError(400, 'image must be a data URI');
  const w = Number(body.width) || 0;
  const h = Number(body.height) || 0;

  const up = choose(UPSCALERS, body.upscaler, DEFAULT_UPSCALER);
  const rm = choose(REMOVERS, body.remover, DEFAULT_REMOVER);
  const steps = [];

  const factor = upscale ? pickFactor(up.params, w, h, steps) : 0;
  const doUpscale = factor > 1;
  if (!doUpscale && !removeBackground) return { ok: true, upscaled: null, cutout: null, steps };

  let working = (await stage(body.image)).url;
  let upscaled = null;
  if (doUpscale) {
    upscaled = firstUrl(await falRun(up.spec.endpoint, upscaleInput(up.spec, up.params, working, factor)), up.spec.name);
    const variant = typeof up.params.model === 'string' ? ` ${up.params.model}` : '';
    steps.push(`upscaled ${factor}× with ${up.spec.name}${variant}`);
    working = upscaled;
  }
  let cutout = null;
  if (removeBackground) {
    cutout = firstUrl(await falRun(rm.spec.endpoint, removerInput(rm.spec, rm.params, working)), rm.spec.name);
    steps.push(`background removed with ${rm.spec.name}`);
  }
  return { ok: true, upscaled, cutout, steps };
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json(status());
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ ok: false, error: 'origin not allowed' });
  if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'enhance token required' });
  if (!falKey()) return res.status(503).json({ ok: false, error: 'FAL_KEY is not configured on the server' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid json' });
  }
  try {
    return res.status(200).json(await enhance(body));
  } catch (err) {
    const code = err.status || 500;
    // upstream bodies never reach the client verbatim; they go to the logs
    if (code >= 500) console.error('enhance failed:', err.message);
    return res.status(code).json({ ok: false, error: code >= 500 ? err.message.split(':')[0] : err.message });
  }
}
