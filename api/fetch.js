/* GET /api/fetch?url=… — relay a fal result to the browser.
 *
 * Only for hosts on fal's CDN, only GET, streamed straight through. Exists
 * because the browser would rather fetch the result directly, and can when
 * the CDN answers cross-origin — this is the fallback when it doesn't. */

const ALLOWED = /(^|\.)fal\.media$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method not allowed' });
  let target;
  try {
    target = new URL(String(req.query?.url || ''));
  } catch {
    return res.status(400).json({ ok: false, error: 'url required' });
  }
  if (target.protocol !== 'https:' || !ALLOWED.test(target.hostname)) {
    return res.status(403).json({ ok: false, error: 'host not allowed' });
  }
  const up = await fetch(target, { headers: { Accept: 'image/*' } });
  if (!up.ok || !up.body) return res.status(502).json({ ok: false, error: `upstream ${up.status}` });
  res.status(200);
  res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  for await (const chunk of up.body) res.write(chunk);
  res.end();
}
