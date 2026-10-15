/* Snapping for the card page: a periodic grid hung off the card's margin,
 * the card's centre lines, and the inner content edges. The dragged thing's
 * bounding box is tested on its left/centre/right and top/middle/bottom, so a
 * centred name snaps by its centre and a left-aligned credit by its edge
 * without the caller caring which. Centre and edge lines reach further than
 * grid lines, so they win when both are close. */

import { REF, scaleFor } from './card.js';

export const GRID_STEPS = [40, 60, 80, 120];
export const DEFAULT_SNAP = { on: true, step: 60 };

/* Reach in reference units: ~11 and ~6 screen px on the preview. Centre and
 * margin lines pull from further than grid lines, so a near-centre drop lands
 * centred rather than on the grid line next to it. */
const LINE_REACH = 40;
const GRID_REACH = 20;

export function snapGeometry(W, H, step, inset = 60) {
  // the margin guide lines stay at a 60-unit inset: that is where type sits
  // comfortably, independent of the fit rule's much tighter limit
  const s = scaleFor(W, H);
  const M = REF.MARGIN * s;
  return {
    s,
    origin: M,
    stepPx: step * s,
    cx: W / 2,
    cy: H / 2,
    left: M + inset * s,
    right: W - M - inset * s,
    top: M + inset * s,
    bottom: H - M - inset * s,
  };
}

function bestOnAxis(points, lines, g) {
  const T = LINE_REACH * g.s;
  const G = GRID_REACH * g.s;
  let best = null;
  const consider = (d, at, priority) => {
    if (!best || priority < best.priority || (priority === best.priority && Math.abs(d) < Math.abs(best.d))) best = { d, at, priority };
  };
  // centre line first, then margin edges, then the grid — so a near-centre
  // drop lands centred even when an edge or grid line happens to be closer
  for (const p of points) {
    lines.forEach((ln, i) => {
      const d = ln - p;
      if (Math.abs(d) <= T) consider(d, ln, i === 0 ? 0 : 1);
    });
    const gl = g.origin + Math.round((p - g.origin) / g.stepPx) * g.stepPx;
    const d = gl - p;
    if (Math.abs(d) <= G) consider(d, gl, 2);
  }
  return best;
}

/** @returns {dx, dy, guideX, guideY} in device px — add dx/dy to the rect's
 *  position; guideX/guideY are the lines it snapped to, for drawing. */
export function snapRect(rect, W, H, step) {
  const g = snapGeometry(W, H, step);
  const bx = bestOnAxis([rect.x, rect.x + rect.w / 2, rect.x + rect.w], [g.cx, g.left, g.right], g);
  const by = bestOnAxis([rect.y, rect.y + rect.h / 2, rect.y + rect.h], [g.cy, g.top, g.bottom], g);
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guideX: bx ? bx.at : null, guideY: by ? by.at : null };
}

/** Preview-only overlay: the grid as faint dots, the active guides as lines. */
export function drawGuides(ctx, W, H, guides) {
  if (!guides || !guides.show) return;
  const g = snapGeometry(W, H, guides.step);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  const r = Math.max(0.75, 1.2 * g.s);
  for (let x = g.origin; x <= W - g.origin + 0.5; x += g.stepPx) {
    for (let y = g.origin; y <= H - g.origin + 0.5; y += g.stepPx) {
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6 * g.s, 6 * g.s]);
  for (const x of [g.cx, g.left, g.right]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (const y of [g.cy, g.top, g.bottom]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#6fe08c';
  ctx.lineWidth = Math.max(1.5, 2 * g.s);
  if (guides.x != null) {
    ctx.beginPath();
    ctx.moveTo(guides.x, 0);
    ctx.lineTo(guides.x, H);
    ctx.stroke();
  }
  if (guides.y != null) {
    ctx.beginPath();
    ctx.moveTo(0, guides.y);
    ctx.lineTo(W, guides.y);
    ctx.stroke();
  }
  ctx.restore();
}
