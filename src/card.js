/* HCN card renderer.
 *
 * A direct port of scripts/make_card.py from the hcn-guest-card skill.
 * Every constant below was measured off the designers' original AI/PSD files
 * at the 2160x2880 reference size; `scaleFor()` maps them to any output size.
 *
 * drawCard() is the single source of truth for both the on-screen preview and
 * the full-resolution export, so what you drag is what you download.
 */

export const ASPECTS = {
  '3:4': [2160, 2880],
  '4:5': [2160, 2700],
  '1:1': [2160, 2160],
  '9:16': [2160, 3840],
  '16:9': [3840, 2160],
};

export const CORAL = [255, 101, 85];

export const REF = {
  BASE_W: 1919,
  BASE_H: 2639,
  MARGIN: 120,
  RADIUS: 80,
  BORDER_W: 8,
  BORDER_A: 27 / 255,
  GLASS_A: 43 / 255,
  GLOW_OPACITY: 0.8,
  GLOW_SIZE: 220,
  EYEBROW_DY: 609,
  NAME_DY: 485,
  TITLE_DY: 145,
  EYEBROW_SIZE: 88,
  NAME_SIZE: 318,
  TITLE_SIZE: 88,
  SCRIM_TOP: 829,
  SCRIM_FULL: 419,
  SCRIM_MAX: 0.78,
  SCRIM_FALLOFF: 1.15,
  LOGO_OFF_X: 65,
  LOGO_OFF_Y: 46,
  LOGO_W_FRAC: 1789 / 1919,
  PLATE_H: 215,
  PLATE_PAD: 62,
  PLATE_RADIUS: 40,
};

export const FONTS = { display: 'F37Analog', mono: 'RLOkima' };

/* Maps reference-space units onto an output of any size.
 *
 * This must be strictly proportional to W/H, or the preview stops being a
 * faithful miniature of the export. Dividing the *frame* by the reference
 * frame does that; subtracting an absolute margin first does not, because a
 * fixed 240px inset is 39% of a 615px preview but only 11% of a 2160px
 * export — which rendered preview type ~31% small at 3:4. The reference frame
 * is the content box plus its margins: 1919+240 x 2639+240 = 2160x2880.
 */
export function scaleFor(W, H) {
  return Math.min(W / (REF.BASE_W + 2 * REF.MARGIN), H / (REF.BASE_H + 2 * REF.MARGIN));
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return CORAL.slice();
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ---------- one-time image preparation ---------- */

/** The PSD grade: desaturate 24%, then levels 36 / gamma 1.26 / 207. */
export function gradeCutout(source) {
  const w = source.width;
  const h = source.height;
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lo = 36 / 255;
  const span = (207 - 36) / 255;
  const invGamma = 1 / 1.26;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = [r + (lum - r) * 0.24, g + (lum - g) * 0.24, b + (lum - b) * 0.24];
    for (let k = 0; k < 3; k++) {
      let t = (v[k] - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d[i + k] = Math.pow(t, invGamma) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Trim a logo to its ink: alpha channel when present, else anything darker than near-white. */
export function trimLogo(source) {
  const w = source.width;
  const h = source.height;
  const ctx = makeCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  let opaque = true;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      opaque = false;
      break;
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ink = opaque ? (d[i] + d[i + 1] + d[i + 2]) / 3 < 245 : d[i + 3] > 16;
      if (ink) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { canvas: source, opaque };
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = makeCanvas(cw, ch);
  out.getContext('2d').drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch);
  return { canvas: out, opaque };
}

/* ---------- cached background + sheen ---------- */

const bgCache = new Map();
const sheenCache = new Map();

function backgroundLayer(W, H, accent, texture) {
  const key = `${W}x${H}:${accent.join(',')}`;
  const hit = bgCache.get(key);
  if (hit) return hit;

  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  const cover = Math.max(W / texture.width, H / texture.height);
  const tw = texture.width * cover;
  const th = texture.height * cover;
  ctx.drawImage(texture, (W - tw) / 2, (H - th) / 2, tw, th);

  const isCoral = accent[0] === CORAL[0] && accent[1] === CORAL[1] && accent[2] === CORAL[2];
  if (!isCoral) {
    // Remap the coral family onto the target hue, preserving the white-mix gradient.
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const denom = 255 - CORAL[1];
    for (let i = 0; i < d.length; i += 4) {
      let t = (255 - d[i + 1]) / denom;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d[i] = 255 * (1 - t) + accent[0] * t;
      d[i + 1] = 255 * (1 - t) + accent[1] * t;
      d[i + 2] = 255 * (1 - t) + accent[2] * t;
    }
    ctx.putImageData(img, 0, 0);
  }
  bgCache.set(key, cv);
  if (bgCache.size > 12) bgCache.delete(bgCache.keys().next().value);
  return cv;
}

/** Diagonal glass sheen, fit from the AI file's Glass Top layer. */
function sheenLayer(W, H) {
  const key = `${W}x${H}`;
  const hit = sheenCache.get(key);
  if (hit) return hit;
  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const ry = 57.6 * (y / H) - 27.8;
    for (let x = 0; x < W; x++) {
      let a = ry + 31.7 * (1 - x / W);
      a = a < 0 ? 0 : a > 255 ? 255 : a;
      const i = (y * W + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  sheenCache.set(key, cv);
  if (sheenCache.size > 8) sheenCache.delete(sheenCache.keys().next().value);
  return cv;
}

/* ---------- layout ---------- */

export function subjectRect(sub, W, H) {
  const h = sub.scale * H;
  const w = (sub.img.width / sub.img.height) * h;
  return { x: sub.nx * W - w / 2, y: sub.ny * H - h / 2, w, h };
}

export function splitLines(text) {
  return String(text ?? '')
    .split('||')
    .map((t) => t.trim())
    .filter((t, i, a) => t.length > 0 || a.length === 1);
}

function setFont(ctx, field, s) {
  const family = field.font === 'display' ? FONTS.display : FONTS.mono;
  ctx.font = `${Math.round(field.size * s)}px "${family}"`;
}

export function textRect(ctx, field, W, H, s) {
  if (!field.show) return null;
  const lines = splitLines(field.upper ? field.text.toUpperCase() : field.text);
  setFont(ctx, field, s);
  const size = field.size * s;
  const lineH = size * 1.24;
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  const h = lineH * lines.length;
  const x0 = field.nx * W;
  const x = field.align === 'center' ? x0 - maxW / 2 : field.align === 'right' ? x0 - maxW : x0;
  return { x, y: field.ny * H, w: maxW, h, lines, lineH, size };
}

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Scrim geometry in device pixels. `full` is clamped to `top` so the solid
 *  band can never overrun the fade and invert the gradient. */
export function scrimRect(scrim, s, cardBottom) {
  const top = Math.max(0, scrim.top ?? REF.SCRIM_TOP);
  const full = clampN(scrim.full ?? REF.SCRIM_FULL, 0, top);
  const y0 = cardBottom - top * s;
  const y1 = cardBottom - full * s;
  return { y0, y1, fadeH: y1 - y0, falloff: clampN(scrim.falloff ?? REF.SCRIM_FALLOFF, 0.2, 4) };
}

export function plateRect(logo, W, H, s) {
  if (!logo.show || !logo.img) return null;
  const h = logo.height * s;
  const pad = logo.pad * s;
  const inner = Math.max(1, h - 2 * pad);
  const w = (logo.img.width / logo.img.height) * inner + 2 * pad;
  return { x: logo.nx * W, y: logo.ny * H, w, h, pad, inner };
}

/* ---------- the card ---------- */

export function drawCard(ctx, W, H, state, assets, opts = {}) {
  const s = scaleFor(W, H);
  const M = REF.MARGIN * s;
  const R = REF.RADIUS * s;
  const cardL = M;
  const cardT = M;
  const cardW = W - 2 * M;
  const cardH = H - 2 * M;
  const cardBottom = H - M;
  const accent = hexToRgb(state.color);
  const accentCss = `rgb(${accent[0]},${accent[1]},${accent[2]})`;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  /* 1. textured background + glass fill */
  ctx.drawImage(backgroundLayer(W, H, accent, assets.texture), 0, 0);
  ctx.save();
  roundRectPath(ctx, cardL, cardT, cardW, cardH, R);
  ctx.clip();
  ctx.fillStyle = `rgba(255,255,255,${REF.GLASS_A})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  /* 2. inner layer: glow, subjects, scrim — all masked to the card */
  const inner = makeCanvas(W, H);
  const ictx = inner.getContext('2d', { willReadFrequently: true });
  const ordered = [...state.subjects].sort((a, b) => a.z - b.z);

  if (ordered.length) {
    // silhouette of the whole group
    const sil = makeCanvas(W, H);
    const sctx = sil.getContext('2d');
    for (const sub of ordered) {
      const r = subjectRect(sub, W, H);
      sctx.drawImage(sub.img, r.x, r.y, r.w, r.h);
    }
    // one coral glow behind everyone
    const glow = makeCanvas(W, H);
    const gctx = glow.getContext('2d', { willReadFrequently: true });
    gctx.filter = `blur(${(REF.GLOW_SIZE * s) / 3}px)`;
    gctx.drawImage(sil, 0, 0);
    gctx.filter = 'none';
    const gimg = gctx.getImageData(0, 0, W, H);
    const gd = gimg.data;
    for (let i = 0; i < gd.length; i += 4) {
      gd[i] = accent[0];
      gd[i + 1] = accent[1];
      gd[i + 2] = accent[2];
      gd[i + 3] = Math.sqrt(gd[i + 3] / 255) * REF.GLOW_OPACITY * 255;
    }
    gctx.putImageData(gimg, 0, 0);
    ictx.drawImage(glow, 0, 0);

    // subjects back to front, with a soft separation shadow under each overlap
    ordered.forEach((sub, idx) => {
      const r = subjectRect(sub, W, H);
      if (idx > 0) {
        ictx.save();
        ictx.filter = `blur(${22 * s}px)`;
        ictx.globalAlpha = 0.45;
        const sh = makeCanvas(W, H);
        const shctx = sh.getContext('2d');
        shctx.drawImage(sub.img, r.x, r.y, r.w, r.h);
        shctx.globalCompositeOperation = 'source-in';
        shctx.fillStyle = 'rgb(10,8,12)';
        shctx.fillRect(0, 0, W, H);
        ictx.drawImage(sh, 0, 0);
        ictx.restore();
      }
      ictx.drawImage(sub.img, r.x, r.y, r.w, r.h);
    });
  }

  /* 3. scrim — the dark gradient that absorbs cropped-off shoulders.
   *
   * Three knobs, all in reference units measured up from the card's bottom
   * edge: `top` is the total height (where the fade starts at zero opacity),
   * `full` is the solid band at the base that sits at `max` opacity, and the
   * fade runs between them on a `falloff` power curve. */
  const scrimGeom = scrimRect(state.scrim, s, cardBottom);
  if (scrimGeom.fadeH > 0) {
    const grad = ictx.createLinearGradient(0, scrimGeom.y0, 0, scrimGeom.y1);
    grad.addColorStop(0, 'rgba(16,14,20,0)');
    for (let k = 1; k <= 16; k++) {
      const t = k / 16;
      grad.addColorStop(t, `rgba(16,14,20,${Math.pow(t, scrimGeom.falloff) * state.scrim.max})`);
    }
    ictx.fillStyle = grad;
    ictx.fillRect(0, scrimGeom.y0, W, scrimGeom.fadeH);
  }
  ictx.fillStyle = `rgba(16,14,20,${state.scrim.max})`;
  ictx.fillRect(0, scrimGeom.y1, W, H - scrimGeom.y1);

  ctx.save();
  roundRectPath(ctx, cardL, cardT, cardW, cardH, R);
  ctx.clip();
  ctx.drawImage(inner, 0, 0);

  /* 4. foreground chrome: sheen, border, HCN lockup */
  ctx.drawImage(sheenLayer(W, H), 0, 0);
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, cardL, cardT, cardW, cardH, R);
  ctx.strokeStyle = `rgba(${accent[0]},${accent[1]},${accent[2]},${REF.BORDER_A})`;
  ctx.lineWidth = Math.max(2, REF.BORDER_W * s);
  ctx.stroke();
  ctx.restore();

  if (assets.lockup) {
    const lw = Math.min(cardW * REF.LOGO_W_FRAC, cardW * 0.92);
    const lh = (assets.lockup.height * lw) / assets.lockup.width;
    ctx.drawImage(assets.lockup, cardL + REF.LOGO_OFF_X * s, cardT + REF.LOGO_OFF_Y * s, lw, lh);
  }

  /* 5. company plate + text */
  const plate = plateRect(state.logo, W, H, s);
  if (plate) {
    ctx.save();
    roundRectPath(ctx, plate.x, plate.y, plate.w, plate.h, REF.PLATE_RADIUS * s * state.logo.radius);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.clip();
    const iw = plate.w - 2 * plate.pad;
    const ih = plate.inner;
    ctx.drawImage(state.logo.img, plate.x + plate.pad, plate.y + (plate.h - ih) / 2, iw, ih);
    ctx.restore();
  }

  ctx.textBaseline = 'top';
  for (const key of ['eyebrow', 'name', 'title']) {
    const field = state.text[key];
    const r = textRect(ctx, field, W, H, s);
    if (!r) continue;
    setFont(ctx, field, s);
    ctx.fillStyle = field.color || '#ffffff';
    ctx.textAlign = 'left';
    r.lines.forEach((ln, i) => {
      const lw = ctx.measureText(ln).width;
      const x =
        field.align === 'center' ? field.nx * W - lw / 2 : field.align === 'right' ? field.nx * W - lw : field.nx * W;
      ctx.fillText(ln, x, r.y + i * r.lineH);
    });
  }

  /* 6. selection affordances — preview only, never exported */
  if (opts.selection) {
    const sel = opts.selection;
    ctx.save();
    ctx.strokeStyle = accentCss;
    ctx.lineWidth = Math.max(2, 6 * s);
    ctx.setLineDash([18 * s, 12 * s]);
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    ctx.restore();
  }
  ctx.restore();
}

export async function exportPng(state, assets, ar) {
  const [W, H] = ASPECTS[ar];
  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d');
  drawCard(ctx, W, H, state, assets);
  if (cv.convertToBlob) return cv.convertToBlob({ type: 'image/png' });
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}
