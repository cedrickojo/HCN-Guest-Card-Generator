import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EXPORT_SIZES,
  FONT_CHOICES,
  MAX_UPLOAD_BYTES,
  THUMB,
  backgroundRect,
  boxToCrop,
  cropFrame,
  drawThumb,
  exportThumb,
  overlayRect,
  scaleFor,
  subjectRect,
  textLayout,
} from './thumb.js';
import { DEFAULT_MODEL, MODELS, alphaMatte } from './removeBg.js';
import { DEFAULT_MATTE, composeCutout } from './matte.js';
import { ColorRow, DropZone, Group, Row, Segmented, Slider, clamp, slug, useBrandFonts } from './ui.jsx';
import { Tabs } from './router.jsx';

const PREVIEW_W = 1024;
const PREVIEW_H = Math.round((PREVIEW_W * THUMB.H) / THUMB.W);
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

let nextId = 1;

const newText = (over = {}) => ({
  id: nextId++,
  show: true,
  text: 'Nobody Else Will||Tell You',
  font: 'black',
  size: 104,
  color: '#ffffff',
  align: 'center',
  nx: 0.5,
  ny: 0.14,
  lineGap: 1.02,
  upper: false,
  highlight: { on: false, color: '#f5232c', padX: 22, padY: 12, radius: 4 },
  ...over,
});

const initialState = () => ({
  bg: { img: null, name: '', color: '#0d0d12', zoom: 1, nx: 0.5, ny: 0.5, brightness: 1, contrast: 1, saturation: 1 },
  vignette: { top: 0, right: 0, bottom: 0.35, left: 0, softness: 0.4, color: '#000000', overSubjects: false },
  subjects: [],
  overlays: [],
  texts: [newText()],
});

export default function Thumbnail({ path }) {
  const [state, setState] = useState(initialState);
  const [sel, setSel] = useState(null); // {kind:'subject'|'overlay'|'text'|'bg', id}
  const [cropId, setCropId] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportSize, setExportSize] = useState('1280x720');
  const [format, setFormat] = useState('png');
  const [lastSize, setLastSize] = useState(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const fontsReady = useBrandFonts();
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const cropDragRef = useRef(null);
  const recomposeRef = useRef(new Map());
  const presetRef = useRef(null);

  const cropSubject = cropId ? state.subjects.find((s) => s.id === cropId) : null;

  /* ---- draw ---- */
  const selectionRect = useCallback(
    (ctx) => {
      if (!sel || cropId) return null;
      const s = scaleFor(PREVIEW_W);
      if (sel.kind === 'subject') {
        const sub = state.subjects.find((x) => x.id === sel.id);
        return sub ? subjectRect(sub, PREVIEW_W, PREVIEW_H) : null;
      }
      if (sel.kind === 'overlay') {
        const ov = state.overlays.find((x) => x.id === sel.id);
        return ov ? overlayRect(ov, PREVIEW_W, PREVIEW_H) : null;
      }
      if (sel.kind === 'text') {
        const item = state.texts.find((x) => x.id === sel.id);
        return item ? textLayout(ctx, item, PREVIEW_W, PREVIEW_H, s) : null;
      }
      // an outline tracing the whole frame says nothing — only show it when the
      // backdrop overflows and there is actually somewhere to pan it
      const r = backgroundRect(state.bg, PREVIEW_W, PREVIEW_H);
      if (!r || (r.w - PREVIEW_W < 1 && r.h - PREVIEW_H < 1)) return null;
      return r;
    },
    [sel, cropId, state]
  );

  const [liveBox, setLiveBox] = useState(null); // crop box mid-drag

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !fontsReady) return;
    cv.width = PREVIEW_W;
    cv.height = PREVIEW_H;
    const ctx = cv.getContext('2d');
    const raf = requestAnimationFrame(() => {
      let cropping = null;
      if (cropSubject) {
        const frame = cropFrame(cropSubject, PREVIEW_W, PREVIEW_H);
        cropping = { id: cropSubject.id, frame, box: liveBox || frame.box };
      }
      drawThumb(ctx, PREVIEW_W, PREVIEW_H, state, { selection: selectionRect(ctx), cropping });
    });
    return () => cancelAnimationFrame(raf);
  }, [state, fontsReady, selectionRect, cropSubject, liveBox]);

  /* ---- hit testing: text, overlays, cutouts front to back, then backdrop ---- */
  const pick = (px, py) => {
    const ctx = canvasRef.current.getContext('2d');
    const s = scaleFor(PREVIEW_W);
    const inside = (r) => r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    for (const item of [...state.texts].reverse()) {
      if (inside(textLayout(ctx, item, PREVIEW_W, PREVIEW_H, s))) {
        return { kind: 'text', id: item.id, ref: { nx: item.nx, ny: item.ny } };
      }
    }
    for (const ov of [...state.overlays].sort((a, b) => b.z - a.z)) {
      if (ov.show && inside(overlayRect(ov, PREVIEW_W, PREVIEW_H))) {
        return { kind: 'overlay', id: ov.id, ref: { nx: ov.nx, ny: ov.ny } };
      }
    }
    for (const sub of [...state.subjects].sort((a, b) => b.z - a.z)) {
      if (inside(subjectRect(sub, PREVIEW_W, PREVIEW_H))) {
        return { kind: 'subject', id: sub.id, ref: { nx: sub.nx, ny: sub.ny } };
      }
    }
    if (state.bg.img) return { kind: 'bg', ref: { nx: state.bg.nx, ny: state.bg.ny } };
    return null;
  };

  const toCanvas = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * PREVIEW_W, ((e.clientY - r.top) / r.height) * PREVIEW_H];
  };

  const onPointerDown = (e) => {
    const [px, py] = toCanvas(e);
    canvasRef.current.setPointerCapture(e.pointerId);
    if (cropSubject) {
      cropDragRef.current = { x: px, y: py };
      setLiveBox({ x: px, y: py, w: 0, h: 0 });
      return;
    }
    const hit = pick(px, py);
    setSel(hit ? { kind: hit.kind, id: hit.id } : null);
    if (!hit) return;
    dragRef.current = { hit, startX: px, startY: py };
  };

  const onPointerMove = (e) => {
    const [px, py] = toCanvas(e);
    if (cropDragRef.current) {
      const a = cropDragRef.current;
      setLiveBox({ x: Math.min(a.x, px), y: Math.min(a.y, py), w: Math.abs(px - a.x), h: Math.abs(py - a.y) });
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const dx = px - d.startX;
    const dy = py - d.startY;
    setState((st) => {
      const nx = d.hit.ref.nx + dx / PREVIEW_W;
      const ny = d.hit.ref.ny + dy / PREVIEW_H;
      if (d.hit.kind === 'subject')
        return { ...st, subjects: st.subjects.map((s) => (s.id === d.hit.id ? { ...s, nx, ny } : s)) };
      if (d.hit.kind === 'overlay')
        return { ...st, overlays: st.overlays.map((o) => (o.id === d.hit.id ? { ...o, nx, ny } : o)) };
      if (d.hit.kind === 'text')
        return { ...st, texts: st.texts.map((t) => (t.id === d.hit.id ? { ...t, nx, ny } : t)) };
      // the backdrop pans within its own overflow, so a pixel of drag is a
      // different fraction than it is for a subject — and none at all when the
      // image exactly fills the frame
      const r = backgroundRect(st.bg, PREVIEW_W, PREVIEW_H);
      if (!r) return st;
      const slackX = PREVIEW_W - r.w;
      const slackY = PREVIEW_H - r.h;
      return {
        ...st,
        bg: {
          ...st.bg,
          nx: slackX === 0 ? st.bg.nx : clamp(d.hit.ref.nx + dx / slackX, 0, 1),
          ny: slackY === 0 ? st.bg.ny : clamp(d.hit.ref.ny + dy / slackY, 0, 1),
        },
      };
    });
  };

  const endDrag = (e) => {
    // throws NotFoundError if this pointer was never captured, which happens
    // on a stray pointercancel
    try {
      canvasRef.current.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (cropDragRef.current) {
      cropDragRef.current = null;
      // ignore a click without a drag, so tapping the canvas doesn't wipe the crop
      if (liveBox && liveBox.w > 6 && liveBox.h > 6) commitCrop(liveBox);
      setLiveBox(null);
      return;
    }
    dragRef.current = null;
  };

  // wheel must be non-passive or preventDefault() is ignored
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e) => {
      if (!sel || sel.kind === 'text' || cropId) return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.03 : 1 / 1.03;
      setState((st) => {
        if (sel.kind === 'subject')
          return { ...st, subjects: st.subjects.map((s) => (s.id === sel.id ? { ...s, scale: clamp(s.scale * f, 0.05, 4) } : s)) };
        if (sel.kind === 'overlay')
          return { ...st, overlays: st.overlays.map((o) => (o.id === sel.id ? { ...o, scale: clamp(o.scale * f, 0.02, 4) } : o)) };
        return { ...st, bg: { ...st.bg, zoom: clamp(st.bg.zoom * f, 1, 5) } };
      });
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [sel, cropId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && cropId) return setCropId(null);
      if (!sel || cropId || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const step = e.shiftKey ? 0.02 : 0.004;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!mv) return;
      e.preventDefault();
      const bump = (o) => ({ ...o, nx: o.nx + mv[0], ny: o.ny + mv[1] });
      setState((st) => {
        if (sel.kind === 'subject')
          return { ...st, subjects: st.subjects.map((s) => (s.id === sel.id ? bump(s) : s)) };
        if (sel.kind === 'overlay')
          return { ...st, overlays: st.overlays.map((o) => (o.id === sel.id ? bump(o) : o)) };
        if (sel.kind === 'text') return { ...st, texts: st.texts.map((t) => (t.id === sel.id ? bump(t) : t)) };
        return { ...st, bg: { ...st.bg, nx: clamp(st.bg.nx + mv[0], 0, 1), ny: clamp(st.bg.ny + mv[1], 0, 1) } };
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, cropId]);

  /* ---- crop ---- */

  /* Cropping keeps the kept region exactly where it was drawn: the new crop is
   * the box, so the subject's placement becomes the box outright. */
  const commitCrop = (box) => {
    setState((st) => ({
      ...st,
      subjects: st.subjects.map((s) => {
        if (s.id !== cropId) return s;
        const frame = cropFrame(s, PREVIEW_W, PREVIEW_H);
        return {
          ...s,
          crop: boxToCrop(frame.full, box),
          nx: (box.x + box.w / 2) / PREVIEW_W,
          ny: (box.y + box.h / 2) / PREVIEW_H,
          scale: box.h / PREVIEW_H,
        };
      }),
    }));
  };

  const resetCrop = (id) =>
    setState((st) => ({
      ...st,
      subjects: st.subjects.map((s) => {
        if (s.id !== id) return s;
        const { full } = cropFrame(s, PREVIEW_W, PREVIEW_H);
        return {
          ...s,
          crop: { ...FULL_CROP },
          nx: (full.x + full.w / 2) / PREVIEW_W,
          ny: (full.y + full.h / 2) / PREVIEW_H,
          scale: full.h / PREVIEW_H,
        };
      }),
    }));

  /* ---- cutouts ---- */
  const addHeadshots = async (files) => {
    setBusy(true);
    try {
      for (const file of files) {
        setStatus(`${file.name} — starting`);
        const src = await createImageBitmap(file);
        const maskBlob = await alphaMatte(file, model, (m) => setStatus(`${file.name} — ${m}`));
        const mask = await createImageBitmap(maskBlob);
        const matte = { ...DEFAULT_MATTE };
        const img = composeCutout(src, mask, matte);
        setState((st) => {
          const z = st.subjects.length ? Math.max(...st.subjects.map((s) => s.z)) + 1 : 0;
          const n = st.subjects.length;
          return {
            ...st,
            subjects: [
              ...st.subjects,
              {
                id: nextId++,
                name: file.name,
                file,
                src,
                mask,
                model,
                matte,
                img,
                crop: { ...FULL_CROP },
                nx: n === 0 ? 0.22 : n === 1 ? 0.78 : 0.5,
                ny: 0.62,
                scale: 1.05,
                z,
                glow: { on: false, color: '#ff655c', size: 90, opacity: 0.75 },
              },
            ],
          };
        });
      }
      setStatus('');
    } catch (err) {
      setStatus(`Cutout failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  /* Matte edits are a local recomposite, not another inference run, so the
   * slider stays live and only the pixel work is debounced. */
  const updMatte = (id, key, value) => {
    setState((st) => ({
      ...st,
      subjects: st.subjects.map((s) => (s.id === id ? { ...s, matte: { ...s.matte, [key]: value } } : s)),
    }));
    // one timer per subject: a single shared timer would let a tweak on one
    // headshot cancel a pending recomposite on another and leave it stale
    clearTimeout(recomposeRef.current.get(id));
    recomposeRef.current.set(
      id,
      setTimeout(() => {
        recomposeRef.current.delete(id);
        setState((st) => ({
          ...st,
          subjects: st.subjects.map((s) => (s.id === id ? { ...s, img: composeCutout(s.src, s.mask, s.matte) } : s)),
        }));
      }, 140)
    );
  };

  /** Only a change of model needs the model run again. */
  const recut = async (sub, nextModel) => {
    setBusy(true);
    try {
      setStatus(`${sub.name} — re-cutting`);
      const maskBlob = await alphaMatte(sub.file, nextModel, (m) => setStatus(`${sub.name} — ${m}`));
      const mask = await createImageBitmap(maskBlob);
      setState((st) => ({
        ...st,
        subjects: st.subjects.map((s) =>
          s.id === sub.id ? { ...s, mask, model: nextModel, img: composeCutout(s.src, mask, s.matte) } : s
        ),
      }));
      setStatus('');
    } catch (err) {
      setStatus(`Re-cut failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const resetMatte = (id) => {
    setState((st) => ({
      ...st,
      subjects: st.subjects.map((s) =>
        s.id === id ? { ...s, matte: { ...DEFAULT_MATTE }, img: composeCutout(s.src, s.mask, DEFAULT_MATTE) } : s
      ),
    }));
  };

  /* ---- other images ---- */
  const addBackground = async ([file]) => {
    const img = await createImageBitmap(file);
    setState((st) => ({ ...st, bg: { ...st.bg, img, name: file.name, zoom: 1, nx: 0.5, ny: 0.5 } }));
    setSel({ kind: 'bg' });
  };

  const addOverlays = async (files) => {
    for (const file of files) {
      const img = await createImageBitmap(file);
      setState((st) => ({
        ...st,
        overlays: [
          ...st.overlays,
          {
            id: nextId++,
            name: file.name,
            img,
            show: true,
            nx: 0.5,
            ny: 0.5,
            scale: 0.25,
            opacity: 1,
            front: true,
            z: st.overlays.length ? Math.max(...st.overlays.map((o) => o.z)) + 1 : 0,
          },
        ],
      }));
    }
  };

  /* ---- export ---- */
  const download = async () => {
    setBusy(true);
    setStatus('Rendering');
    try {
      const blob = await exportThumb(state, exportSize, format, 0.92);
      setLastSize(blob.size);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(state.texts[0]?.text) || 'thumbnail'}-${exportSize}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('');
    } catch (err) {
      setStatus(`Export failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const savePreset = () => {
    const { bg, subjects, overlays, ...rest } = state;
    const preset = { ...rest, bg: { ...bg, img: null } };
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hcn-thumbnail-preset.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadPreset = async (file) => {
    const preset = JSON.parse(await file.text());
    setState((st) => ({
      ...st,
      ...preset,
      bg: { ...st.bg, ...preset.bg, img: st.bg.img, name: st.bg.name },
      subjects: st.subjects,
      overlays: st.overlays,
    }));
    nextId = Math.max(nextId, ...(preset.texts || []).map((t) => t.id + 1));
  };

  /* ---- updates ---- */
  const updBg = (key, value) => setState((st) => ({ ...st, bg: { ...st.bg, [key]: value } }));
  const updVig = (key, value) => setState((st) => ({ ...st, vignette: { ...st.vignette, [key]: value } }));
  const updSub = (id, key, value) =>
    setState((st) => ({ ...st, subjects: st.subjects.map((s) => (s.id === id ? { ...s, [key]: value } : s)) }));
  const updOv = (id, key, value) =>
    setState((st) => ({ ...st, overlays: st.overlays.map((o) => (o.id === id ? { ...o, [key]: value } : o)) }));
  const updGlow = (id, key, value) =>
    setState((st) => ({
      ...st,
      subjects: st.subjects.map((s) => (s.id === id ? { ...s, glow: { ...s.glow, [key]: value } } : s)),
    }));
  const updText = (id, key, value) =>
    setState((st) => ({ ...st, texts: st.texts.map((t) => (t.id === id ? { ...t, [key]: value } : t)) }));
  const updHl = (id, key, value) =>
    setState((st) => ({
      ...st,
      texts: st.texts.map((t) => (t.id === id ? { ...t, highlight: { ...t.highlight, [key]: value } } : t)),
    }));

  const reorder = (key, id, dir) =>
    setState((st) => {
      const byZ = [...st[key]].sort((a, b) => a.z - b.z);
      const i = byZ.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= byZ.length) return st;
      [byZ[i], byZ[j]] = [byZ[j], byZ[i]];
      const zmap = new Map(byZ.map((s, k) => [s.id, k]));
      return { ...st, [key]: st[key].map((s) => ({ ...s, z: zmap.get(s.id) })) };
    });

  /* Drop a new block under the last one. Measured rather than offset by a
   * guess, because a two-line block at 104px is a third of the frame tall and
   * a fixed nudge lands the new text on top of it. */
  const addTextBlock = () => {
    const ctx = canvasRef.current?.getContext('2d');
    const last = state.texts[state.texts.length - 1];
    let ny = 0.6;
    if (last && ctx) {
      const L = textLayout(ctx, last, PREVIEW_W, PREVIEW_H, scaleFor(PREVIEW_W));
      if (L) ny = clamp((L.y + L.h) / PREVIEW_H + 0.02, 0, 0.9);
    }
    const t = newText({ text: 'The Truth!', ny, highlight: { on: true, color: '#f5232c', padX: 22, padY: 12, radius: 4 } });
    setState((st) => ({ ...st, texts: [...st.texts, t] }));
    setSel({ kind: 'text', id: t.id });
  };

  const selectedSubject = sel?.kind === 'subject' ? state.subjects.find((s) => s.id === sel.id) : null;
  const selectedOverlay = sel?.kind === 'overlay' ? state.overlays.find((o) => o.id === sel.id) : null;
  const subjectLayers = useMemo(() => [...state.subjects].sort((a, b) => b.z - a.z), [state.subjects]);
  const overlayLayers = useMemo(() => [...state.overlays].sort((a, b) => b.z - a.z), [state.overlays]);
  const v = state.vignette;
  const allSides = Math.max(v.top, v.right, v.bottom, v.left);
  const oversize = lastSize != null && lastSize > MAX_UPLOAD_BYTES;

  return (
    <div className="app">
      <header>
        <div className="mark">
          <span className="dot" style={{ background: '#ff655c' }} />
          HCN THUMBNAIL STUDIO
        </div>
        <Tabs path={path} />
        <div className="head-actions">
          <button className="ghost" onClick={savePreset}>Save preset</button>
          <button className="ghost" onClick={() => presetRef.current.click()}>Load preset</button>
          <button className="primary" onClick={download} disabled={busy}>Download</button>
        </div>
        <input ref={presetRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files[0] && loadPreset(e.target.files[0])} />
      </header>

      <main>
        <section className="stage">
          <canvas
            ref={canvasRef}
            className={`card thumb${cropId ? ' cropping' : ''}`}
            style={{ aspectRatio: `${THUMB.W} / ${THUMB.H}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
          <p className="hint">
            {status ||
              (cropId
                ? 'Crop mode — drag a box over the headshot. Esc or Done to finish.'
                : 'Drag anything. Scroll to scale a selected item or zoom the background. Arrow keys nudge.')}
          </p>
          {lastSize != null && (
            <p className={`hint ${oversize ? 'warn' : ''}`}>
              Last export {(lastSize / 1024 / 1024).toFixed(2)}MB
              {oversize ? ' — over YouTube’s 2MB limit, try JPEG or 1280x720' : ''}
            </p>
          )}
        </section>

        <aside className="panel">
          <Group title="Export">
            <Segmented label="Size" value={exportSize} onChange={setExportSize}
              options={Object.keys(EXPORT_SIZES).map((k) => ({ value: k, label: k.replace('x', '×') }))} />
            <Segmented label="Format" value={format} onChange={setFormat}
              options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }]} />
          </Group>

          <Group title="Background">
            <DropZone label={state.bg.img ? `Replace — ${state.bg.name}` : 'Add background image'} onFiles={addBackground} />
            {state.bg.img && (
              <button className="wide ghost" onClick={() => setState((st) => ({ ...st, bg: { ...st.bg, img: null, name: '' } }))}>
                Remove image
              </button>
            )}
            <ColorRow label="Fill" value={state.bg.color} onChange={(hex) => updBg('color', hex)} />
            {state.bg.img && (
              <>
                <Slider label="Zoom" value={state.bg.zoom} min={1} max={5} step={0.01} onChange={(x) => updBg('zoom', x)} fmt={(x) => `${x.toFixed(2)}×`} />
                <Slider label="Pan X" value={state.bg.nx} min={0} max={1} step={0.005} onChange={(x) => updBg('nx', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Pan Y" value={state.bg.ny} min={0} max={1} step={0.005} onChange={(x) => updBg('ny', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Brightness" value={state.bg.brightness} min={0} max={2} step={0.01} onChange={(x) => updBg('brightness', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Contrast" value={state.bg.contrast} min={0} max={2} step={0.01} onChange={(x) => updBg('contrast', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Saturation" value={state.bg.saturation} min={0} max={2} step={0.01} onChange={(x) => updBg('saturation', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
              </>
            )}
          </Group>

          <Group title="Vignette">
            <Slider label="All sides" value={allSides} min={0} max={1} step={0.01} fmt={(x) => `${Math.round(x * 100)}%`}
              onChange={(x) => setState((st) => ({ ...st, vignette: { ...st.vignette, top: x, right: x, bottom: x, left: x } }))} />
            <Slider label="Top" value={v.top} min={0} max={1} step={0.01} onChange={(x) => updVig('top', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
            <Slider label="Right" value={v.right} min={0} max={1} step={0.01} onChange={(x) => updVig('right', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
            <Slider label="Bottom" value={v.bottom} min={0} max={1} step={0.01} onChange={(x) => updVig('bottom', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
            <Slider label="Left" value={v.left} min={0} max={1} step={0.01} onChange={(x) => updVig('left', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
            <Slider label="Softness" value={v.softness} min={0.02} max={1} step={0.01} onChange={(x) => updVig('softness', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
            <ColorRow label="Colour" value={v.color} onChange={(hex) => updVig('color', hex)} />
            <Row label="Over headshots">
              <input type="checkbox" checked={v.overSubjects} onChange={(e) => updVig('overSubjects', e.target.checked)} />
            </Row>
          </Group>

          <Group title="Headshots">
            <Row label="Cutout model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </Row>
            <p className="empty">{MODELS.find((m) => m.id === model)?.note}. Applies to new headshots; use Re-cut below to change one already placed.</p>
            <DropZone label={busy ? 'Working…' : 'Add headshots'} multiple disabled={busy} onFiles={addHeadshots} />
            {subjectLayers.length === 0 && <p className="empty">Backgrounds come off on import, nothing else is applied.</p>}
            <ul className="layers">
              {subjectLayers.map((s) => (
                <li key={s.id} className={sel?.kind === 'subject' && sel.id === s.id ? 'on' : ''} onClick={() => setSel({ kind: 'subject', id: s.id })}>
                  <span className="lname">{s.name}</span>
                  <span className="lbtns">
                    <button onClick={(e) => (e.stopPropagation(), reorder('subjects', s.id, 1))} title="Forward">↑</button>
                    <button onClick={(e) => (e.stopPropagation(), reorder('subjects', s.id, -1))} title="Back">↓</button>
                    <button onClick={(e) => (e.stopPropagation(), setCropId(null), setState((st) => ({ ...st, subjects: st.subjects.filter((x) => x.id !== s.id) })))} title="Remove">×</button>
                  </span>
                </li>
              ))}
            </ul>
            {selectedSubject && (
              <>
                <Slider label="Size" value={selectedSubject.scale} min={0.05} max={4} step={0.005} onChange={(x) => updSub(selectedSubject.id, 'scale', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <div className="seg">
                  <button className={cropId === selectedSubject.id ? 'on' : ''} onClick={() => setCropId(cropId === selectedSubject.id ? null : selectedSubject.id)}>
                    {cropId === selectedSubject.id ? 'Done cropping' : 'Crop'}
                  </button>
                  <button onClick={() => resetCrop(selectedSubject.id)}>Reset crop</button>
                </div>
                <Row label="Glow">
                  <input type="checkbox" checked={selectedSubject.glow.on} onChange={(e) => updGlow(selectedSubject.id, 'on', e.target.checked)} />
                </Row>
                {selectedSubject.glow.on && (
                  <>
                    <ColorRow label="Glow colour" value={selectedSubject.glow.color} onChange={(hex) => updGlow(selectedSubject.id, 'color', hex)} />
                    <Slider label="Glow size" value={selectedSubject.glow.size} min={5} max={300} step={1} onChange={(x) => updGlow(selectedSubject.id, 'size', x)} />
                    <Slider label="Glow strength" value={selectedSubject.glow.opacity} min={0} max={1} step={0.01} onChange={(x) => updGlow(selectedSubject.id, 'opacity', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                  </>
                )}
              </>
            )}
          </Group>

          {selectedSubject && (
            <Group title={`Cutout edge — ${selectedSubject.name}`}>
              <p className="empty">
                These recomposite the existing matte instantly. Raise hardness when a face goes half-transparent; shift
                inward and clean the edges when a rim of the old background survives.
              </p>
              <Slider label="Edge hardness" value={selectedSubject.matte.hardness} min={1} max={16} step={0.1} onChange={(x) => updMatte(selectedSubject.id, 'hardness', x)} fmt={(x) => `${x.toFixed(1)}×`} />
              <Slider label="Edge shift" value={selectedSubject.matte.shift} min={-1} max={1} step={0.01} onChange={(x) => updMatte(selectedSubject.id, 'shift', x)} fmt={(x) => (x === 0 ? 'none' : x > 0 ? `out ${Math.round(x * 100)}` : `in ${Math.round(-x * 100)}`)} />
              <Slider label="Edge softness" value={selectedSubject.matte.softness} min={0} max={12} step={0.5} onChange={(x) => updMatte(selectedSubject.id, 'softness', x)} fmt={(x) => `${x}px`} />
              <Slider label="Clean edges" value={selectedSubject.matte.clean} min={0} max={3} step={1} onChange={(x) => updMatte(selectedSubject.id, 'clean', x)} fmt={(x) => (x ? `${x} pass` : 'off')} />
              <button className="wide ghost" onClick={() => resetMatte(selectedSubject.id)}>Reset edge</button>
              <Row label="Re-cut with">
                <select value={selectedSubject.model} onChange={(e) => recut(selectedSubject, e.target.value)} disabled={busy}>
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </Row>
            </Group>
          )}

          <Group title="Overlays">
            <DropZone label="Add overlay image" multiple onFiles={addOverlays} />
            {overlayLayers.length === 0 && <p className="empty">Logos, badges, arrows — placed as-is, no background removal.</p>}
            <ul className="layers">
              {overlayLayers.map((o) => (
                <li key={o.id} className={sel?.kind === 'overlay' && sel.id === o.id ? 'on' : ''} onClick={() => setSel({ kind: 'overlay', id: o.id })}>
                  <span className="lname">{o.name}</span>
                  <span className="lbtns">
                    <button onClick={(e) => (e.stopPropagation(), reorder('overlays', o.id, 1))} title="Forward">↑</button>
                    <button onClick={(e) => (e.stopPropagation(), reorder('overlays', o.id, -1))} title="Back">↓</button>
                    <button onClick={(e) => (e.stopPropagation(), setState((st) => ({ ...st, overlays: st.overlays.filter((x) => x.id !== o.id) })))} title="Remove">×</button>
                  </span>
                </li>
              ))}
            </ul>
            {selectedOverlay && (
              <>
                <Slider label="Size" value={selectedOverlay.scale} min={0.02} max={2} step={0.005} onChange={(x) => updOv(selectedOverlay.id, 'scale', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Opacity" value={selectedOverlay.opacity} min={0} max={1} step={0.01} onChange={(x) => updOv(selectedOverlay.id, 'opacity', x)} fmt={(x) => `${Math.round(x * 100)}%`} />
                <Row label="In front of text">
                  <input type="checkbox" checked={selectedOverlay.front} onChange={(e) => updOv(selectedOverlay.id, 'front', e.target.checked)} />
                </Row>
                <Row label="Show">
                  <input type="checkbox" checked={selectedOverlay.show} onChange={(e) => updOv(selectedOverlay.id, 'show', e.target.checked)} />
                </Row>
              </>
            )}
          </Group>

          {state.texts.map((t, i) => (
            <Group key={t.id} title={`Text ${i + 1}`}
              right={<button className="x" title="Remove" onClick={() => setState((st) => ({ ...st, texts: st.texts.filter((x) => x.id !== t.id) }))}>×</button>}
            >
              <textarea rows={2} value={t.text} placeholder="One line per row, or use ||"
                onChange={(e) => updText(t.id, 'text', e.target.value)} onFocus={() => setSel({ kind: 'text', id: t.id })} />
              <Row label="Font">
                <select value={t.font} onChange={(e) => updText(t.id, 'font', e.target.value)}>
                  {FONT_CHOICES.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </Row>
              <Slider label="Size" value={t.size} min={16} max={260} step={1} onChange={(x) => updText(t.id, 'size', x)} />
              <Slider label="Line spacing" value={t.lineGap} min={0.7} max={2} step={0.01} onChange={(x) => updText(t.id, 'lineGap', x)} fmt={(x) => x.toFixed(2)} />
              <ColorRow label="Colour" value={t.color} onChange={(hex) => updText(t.id, 'color', hex)} />
              <Segmented label="Align" value={t.align} onChange={(a) => updText(t.id, 'align', a)}
                options={[{ value: 'left', label: 'L' }, { value: 'center', label: 'C' }, { value: 'right', label: 'R' }]} />
              <Row label="Uppercase">
                <input type="checkbox" checked={t.upper} onChange={(e) => updText(t.id, 'upper', e.target.checked)} />
              </Row>
              <Row label="Show">
                <input type="checkbox" checked={t.show} onChange={(e) => updText(t.id, 'show', e.target.checked)} />
              </Row>
              <Row label="Highlight">
                <input type="checkbox" checked={t.highlight.on} onChange={(e) => updHl(t.id, 'on', e.target.checked)} />
              </Row>
              {t.highlight.on && (
                <>
                  <ColorRow label="Highlight colour" value={t.highlight.color} onChange={(hex) => updHl(t.id, 'color', hex)} />
                  <Slider label="Pad across" value={t.highlight.padX} min={0} max={80} step={1} onChange={(x) => updHl(t.id, 'padX', x)} />
                  <Slider label="Pad down" value={t.highlight.padY} min={0} max={60} step={1} onChange={(x) => updHl(t.id, 'padY', x)} />
                  <Slider label="Corner radius" value={t.highlight.radius} min={0} max={40} step={1} onChange={(x) => updHl(t.id, 'radius', x)} />
                </>
              )}
            </Group>
          ))}

          <Group title="Add">
            <button className="wide" onClick={addTextBlock}>Add text block</button>
            <p className="empty">Highlight applies to a whole block — keep the highlighted line as its own block, as in the reference.</p>
          </Group>
        </aside>
      </main>
    </div>
  );
}
