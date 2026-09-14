/* "Website" card style — the guest cards from watchhcn.com's home deck.
 *
 * A port of makeCard() in HCN-Website/index.html: a palette backdrop with a
 * radial glow behind the head and a halftone dot field, the cut-out seated
 * with a wide soft shadow, a scrim into the name band, an EP chip top-left,
 * the "HCN" dot-matrix mark top-right, Archivo for the type. Five palettes,
 * X-Ray Gray and Vital Red families only.
 *
 * Two unit systems meet here and it is worth being explicit about them:
 *   - `k = W / 900`  — the site composes at 900 px wide; every pixel number
 *     lifted from it (40 px margins, 26 px halftone grid, 90 px shadow blur)
 *     scales by k, so a card at any size is the site's card, larger.
 *   - `s = scaleFor(W, H)` — the studio's own reference scale, shared with
 *     the classic style, so the text sliders, scrim sliders and drag
 *     positions mean the same thing in both styles.
 */

import { scaleFor, plateRect, REF } from './card.js';
import { hexToRgb, roundRectPath, sourceRect, splitLines, subjectRect } from './shared.js';

export { plateRect };

export const PALETTES = [
  { name: 'Gray / Vital Red', bg: '#35313A', glow: '#FF6555', ink: '#FFFFFF', chip: '#FF6555' },
  { name: 'Vital Red / Pale', bg: '#FF6555', glow: '#FFB3A8', ink: '#35313A', chip: '#35313A' },
  { name: 'Ink / Muted', bg: '#1E1B22', glow: '#6B6774', ink: '#FFFFFF', chip: '#FF6555' },
  { name: 'Deep Red', bg: '#C9463A', glow: '#FF8C7F', ink: '#FFFFFF', chip: '#35313A' },
  { name: 'Slate', bg: '#4B4654', glow: '#FF6555', ink: '#FFFFFF', chip: '#FFFFFF' },
];

export const WEB_DEFAULTS = {
  palette: 0,
  ...PALETTES[0],
  glowStrength: 0.85,
  halftone: true,
  shadow: true,
  mark: true,
};

/* The site's text, in the studio's reference units (a 900-wide site card is
 * a 2160-wide studio card: ×2.4). Name 0.075·min(w,h), sub 0.034·min(w,h),
 * chip text 17 px, all read off makeCard(). */
export const WEB_TEXT = {
  eyebrow: { size: 41, weight: 700, font: 'chip' },
  name: { size: 162, weight: 800, font: 'display' },
  title: { size: 73, weight: 500, font: 'display' },
};

const FAMILY = { display: 'Archivo', chip: 'Archivo', mark: 'Doto' };

const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

function setFont(ctx, key, field, s) {
  const spec = WEB_TEXT[key] || WEB_TEXT.title;
  ctx.font = `${spec.weight} ${Math.round(field.size * s)}px "${FAMILY[spec.font]}", system-ui, sans-serif`;
}

/** Same contract as card.textRect(), plus the field's key so the chip can pad
 *  its plate. Sizes and positions stay in the studio's units. */
export function textRect(ctx, field, W, H, s, key = 'title') {
  if (!field.show) return null;
  const lines = splitLines(field.upper ? field.text.toUpperCase() : field.text);
  setFont(ctx, key, field, s);
  const size = field.size * s;
  const lineH = size * 1.2;
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  // the site's chip is a fixed 96×34 box around 17 px "EP 01": that is 1.5 em
  // of side padding and 0.42 em top and bottom, which also fits "EP 100"
  const chip = key === 'eyebrow';
  const padX = chip ? size * 1.5 : 0;
  const padY = chip ? size * 0.42 : 0;
  const h = lineH * lines.length + padY * 2;
  const w = maxW + padX * 2;
  const x0 = field.nx * W;
  const x = field.align === 'center' ? x0 - w / 2 : field.align === 'right' ? x0 - w : x0;
  return { x, y: field.ny * H, w, h, lines, lineH, size, padX, padY, textW: maxW };
}

/* The glow sits behind the head. The site fixes it at 38% down a square
 * photo; here the headshot moves, so the glow follows the frontmost one. */
function glowCentre(state, W, H) {
  const subs = state.subjects;
  if (!subs.length) return [W / 2, H * 0.42];
  const top = subs.reduce((a, b) => (b.z > a.z ? b : a));
  const r = subjectRect(top, W, H);
  return [r.x + r.w / 2, r.y + r.h * 0.38];
}

export function drawWebCard(ctx, W, H, state, assets, opts = {}) {
  const k = W / 900;
  const s = scaleFor(W, H);
  const web = { ...WEB_DEFAULTS, ...state.web };
  const [cx, cy] = glowCentre(state, W, H);

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  /* 1. backdrop: flat palette colour, radial glow, halftone field */
  ctx.fillStyle = web.bg;
  ctx.fillRect(0, 0, W, H);
  if (web.glowStrength > 0) {
    const g = ctx.createRadialGradient(cx, cy, 10 * k, cx, cy, Math.max(W, H) * 0.6);
    g.addColorStop(0, web.glow);
    g.addColorStop(1, web.bg);
    ctx.globalAlpha = web.glowStrength;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  if (web.halftone) {
    ctx.fillStyle = web.ink;
    ctx.globalAlpha = 0.12;
    const step = 26 * k;
    const far = Math.max(W, H);
    for (let y = 24 * k; y < H; y += step) {
      for (let x = 24 * k; x < W; x += step) {
        const d = Math.hypot(x - cx, y - cy) / far;
        const r = Math.max(0, 6 - d * 10) * k;
        if (r > 0.3 * k) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* 2. cut-outs, seated with the site's wide soft shadow; ungraded, as on
   *    the site — `raw` is the cut-out before the classic style's PSD grade */
  for (const sub of [...state.subjects].sort((a, b) => a.z - b.z)) {
    const img = sub.raw || sub.img;
    const r = subjectRect({ ...sub, img }, W, H);
    const { sx, sy, sw, sh } = sourceRect({ ...sub, img });
    ctx.save();
    if (web.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = 90 * k;
      ctx.shadowOffsetY = 20 * k;
    }
    ctx.drawImage(img, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  /* 3. scrim — the site fades to the backdrop colour over the bottom third;
   *    the studio's scrim sliders drive it so the controls match the classic
   *    style, with `max` as the opacity it reaches */
  const scrim = state.scrim;
  const y0 = H - scrim.top * s;
  const y1 = H - Math.min(scrim.full, scrim.top) * s;
  if (y1 > y0) {
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, rgba(web.bg, 0));
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      grad.addColorStop(t, rgba(web.bg, Math.pow(t, scrim.falloff) * scrim.max));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0, W, y1 - y0);
  }
  ctx.fillStyle = rgba(web.bg, scrim.max);
  ctx.fillRect(0, y1, W, H - y1);

  /* 4. logo plate — the studio's, unchanged, for when a company mark is wanted */
  const plate = plateRect(state.logo, W, H, s);
  if (plate) {
    ctx.save();
    roundRectPath(ctx, plate.x, plate.y, plate.w, plate.h, REF.PLATE_RADIUS * s * state.logo.radius);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.clip();
    ctx.drawImage(state.logo.img, plate.x + plate.pad, plate.y + (plate.h - plate.inner) / 2, plate.w - 2 * plate.pad, plate.inner);
    ctx.restore();
  }

  /* 5. type: EP chip, name, sub — then the HCN mark */
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (const key of ['eyebrow', 'name', 'title']) {
    const field = state.text[key];
    const r = textRect(ctx, field, W, H, s, key);
    if (!r) continue;
    setFont(ctx, key, field, s);
    if (key === 'eyebrow') {
      ctx.fillStyle = web.chip;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = web.chip.toUpperCase() === '#FFFFFF' ? '#35313A' : '#FFFFFF';
    } else {
      ctx.fillStyle = field.color || web.ink;
      if (key === 'title') ctx.globalAlpha = 0.72;
    }
    r.lines.forEach((ln, i) => {
      const lw = ctx.measureText(ln).width;
      const left = r.x + r.padX;
      const x = field.align === 'center' ? left + (r.textW - lw) / 2 : field.align === 'right' ? left + r.textW - lw : left;
      ctx.fillText(ln, x, r.y + r.padY + i * r.lineH);
    });
    ctx.globalAlpha = 1;
  }
  if (web.mark) {
    ctx.font = `900 ${Math.round(22 * k)}px "${FAMILY.mark}", ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = web.ink;
    ctx.fillText('HCN', W - 40 * k, 66 * k);
    ctx.textAlign = 'left';
  }

  /* 6. selection affordance — preview only */
  if (opts.selection) {
    const sel = opts.selection;
    ctx.save();
    ctx.strokeStyle = '#ff655c';
    ctx.lineWidth = Math.max(2, 6 * s);
    ctx.setLineDash([18 * s, 12 * s]);
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
    ctx.restore();
  }
  ctx.restore();
}

export async function exportWebPng(state, assets, ar, ASPECTS) {
  const [W, H] = ASPECTS[ar];
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  drawWebCard(cv.getContext('2d'), W, H, state, assets);
  if (cv.convertToBlob) return cv.convertToBlob({ type: 'image/png' });
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}
