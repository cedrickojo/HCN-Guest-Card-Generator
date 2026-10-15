import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASPECTS,
  REF,
  drawCard,
  exportPng,
  gradeCutout,
  plateRect,
  scaleFor,
  subjectRect,
  textRect as classicTextRect,
  trimLogo,
} from './card.js';
import { PALETTES, WEB_DEFAULTS, WEB_TEXT, drawWebCard, exportWebPng, textRect as webTextRect } from './webcard.js';
import { cutout } from './removeBg.js';
import { cloudEnhance, cloudStatus } from './enhance.js';
import { alphaBounds, cropTo, trimWorthwhile } from './matte.js';
import { ColorRow, DropZone, Group, Row, Segmented, Slider, clamp, slug, useBrandFonts } from './ui.jsx';
import { DEFAULT_SNAP, GRID_STEPS, snapRect } from './snap.js';
import { Tabs } from './router.jsx';

const MAX_PREVIEW = 820;

/* Two styles share one state shape. The classic layout comes from the
 * skill's PSD; the website layout reads off makeCard() in the site's
 * index.html, whose numbers are in a 900-wide frame — `k` converts. */
function defaultText(ar, style = 'classic') {
  const [W, H] = ASPECTS[ar];
  const s = scaleFor(W, H);
  if (style === 'web') {
    const k = W / 900;
    return {
      eyebrow: { show: true, text: 'EP 01', size: WEB_TEXT.eyebrow.size, nx: (40 * k) / W, ny: (40 * k) / H, align: 'left', font: 'chip', upper: true },
      name: { show: true, text: 'Guest Name', size: WEB_TEXT.name.size, nx: (40 * k) / W, ny: 1 - (142 * k) / H, align: 'left', font: 'display', upper: false },
      title: { show: true, text: 'Title, Company', size: WEB_TEXT.title.size, nx: (40 * k) / W, ny: 1 - (73 * k) / H, align: 'left', font: 'display', upper: false },
    };
  }
  const bottom = H - REF.MARGIN * s;
  return {
    eyebrow: { show: true, text: "NEXT WEEK'S GUEST:", size: REF.EYEBROW_SIZE, nx: 0.5, ny: (bottom - REF.EYEBROW_DY * s) / H, align: 'center', font: 'mono', upper: false },
    name: { show: true, text: 'Guest Name', size: REF.NAME_SIZE, nx: 0.5, ny: (bottom - REF.NAME_DY * s) / H, align: 'center', font: 'display', upper: true },
    title: { show: true, text: 'Title | Company', size: REF.TITLE_SIZE, nx: 0.5, ny: (bottom - REF.TITLE_DY * s) / H, align: 'center', font: 'mono', upper: false },
  };
}

function defaultScrim(ar, style = 'classic') {
  if (style !== 'web') return { max: REF.SCRIM_MAX, top: REF.SCRIM_TOP, full: REF.SCRIM_FULL, falloff: REF.SCRIM_FALLOFF };
  // the site fades to the backdrop over the bottom third, reaching 94%
  const [W, H] = ASPECTS[ar];
  return { max: 0.94, top: Math.round((0.34 * H) / scaleFor(W, H)), full: 0, falloff: 1 };
}

/* The plate sits bottom-left on the credit line (classic), with the credit
 * moved to the right to make room; in the website style it takes the top
 * right, under the HCN mark. `img` decides the plate's width, so the
 * right-anchored position is computed when one is known. */
const LOGO_INSET = 60;

function logoPlacement(ar, style, logo) {
  const [W, H] = ASPECTS[ar];
  const s = scaleFor(W, H);
  const M = REF.MARGIN * s;
  const h = (logo?.height ?? REF.PLATE_H) * s;
  if (style === 'web') {
    const k = W / 900;
    const pad = (logo?.pad ?? REF.PLATE_PAD) * s;
    const inner = Math.max(1, h - 2 * pad);
    const w = logo?.img ? (logo.img.width / logo.img.height) * inner + 2 * pad : h * 2;
    return { nx: (W - 40 * k - w) / W, ny: (100 * k) / H };
  }
  // vertically centred on the credit line
  const titleTop = H - M - REF.TITLE_DY * s;
  const titleH = REF.TITLE_SIZE * s * 1.24;
  return { nx: (M + LOGO_INSET * s) / W, ny: (titleTop + (titleH - h) / 2) / H };
}

function defaultLogo(ar, style = 'classic') {
  const base = { show: false, img: null, name: '', height: REF.PLATE_H, pad: REF.PLATE_PAD, radius: 1 };
  return { ...base, ...logoPlacement(ar, style, base) };
}

const initialState = (ar = '3:4') => ({
  ar,
  style: 'classic',
  color: '#FF6555',
  web: { ...WEB_DEFAULTS },
  subjects: [],
  text: defaultText(ar),
  logo: defaultLogo(ar),
  scrim: defaultScrim(ar),
});

/* With a logo bottom-left, the credit line moves to the right edge; without
 * one it returns to centre. Only the classic layout does this — the website
 * layout is left-aligned throughout and keeps its logo top-right. */
function creditFor(text, ar, style, logoOn) {
  if (style === 'web') return text;
  const [W, H] = ASPECTS[ar];
  const s = scaleFor(W, H);
  const title = logoOn
    ? { ...text.title, align: 'right', nx: (W - REF.MARGIN * s - LOGO_INSET * s) / W }
    : { ...text.title, align: 'center', nx: 0.5 };
  return { ...text, title };
}

const SCRIM_DEFAULTS = defaultScrim('3:4');

let nextId = 1;

export default function App({ path }) {
  const [state, setState] = useState(() => initialState());
  const [assets, setAssets] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null); // {kind:'subject'|'text'|'logo', id|key}
  const [cloud, setCloud] = useState({ configured: false });
  const [engine, setEngine] = useState(() => {
    try {
      return localStorage.getItem('hcn.engine') || 'browser';
    } catch {
      return 'browser';
    }
  });
  const [cloudUpscale, setCloudUpscale] = useState(true);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const editorRef = useRef(null);
  const dragRef = useRef(null);
  const presetRef = useRef(null);
  const [editing, setEditing] = useState(null); // text key being edited on the canvas
  const [openSig, setOpenSig] = useState({});
  const [guides, setGuides] = useState(null); // {x, y} active snap lines while dragging
  const [snap, setSnap] = useState(() => {
    try {
      return { ...DEFAULT_SNAP, ...JSON.parse(localStorage.getItem('hcn.cardSnap') || '{}') };
    } catch {
      return { ...DEFAULT_SNAP };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('hcn.cardSnap', JSON.stringify(snap));
    } catch {
      /* storage blocked */
    }
  }, [snap]);

  const fontsReady = useBrandFonts();
  const isWeb = state.style === 'web';
  const useCloud = engine === 'cloud' && cloud.configured;

  const [W, H] = ASPECTS[state.ar];
  const previewW = W >= H ? MAX_PREVIEW : Math.round((MAX_PREVIEW * W) / H);
  const previewH = Math.round((previewW * H) / W);

  useEffect(() => {
    cloudStatus().then(setCloud);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('hcn.engine', engine);
    } catch {
      /* storage blocked */
    }
  }, [engine]);

  /* ---- assets + fonts ---- */
  useEffect(() => {
    (async () => {
      const load = (src) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = src;
        });
      const [texture, lockup] = await Promise.all([load('/assets/bg_texture.png'), load('/assets/logo.png')]);
      setAssets({ texture, lockup });
    })();
  }, []);

  /* ---- style-aware geometry ---- */
  const textRect = useCallback(
    (ctx, key, w, h, s) => (isWeb ? webTextRect(ctx, state.text[key], w, h, s, key) : classicTextRect(ctx, state.text[key], w, h, s)),
    [isWeb, state.text]
  );

  /* ---- draw ---- */
  const selectionRect = useCallback(
    (ctx) => {
      if (!sel) return null;
      const s = scaleFor(previewW, previewH);
      if (sel.kind === 'subject') {
        const sub = state.subjects.find((x) => x.id === sel.id);
        return sub ? subjectRect(sub, previewW, previewH) : null;
      }
      if (sel.kind === 'text') return textRect(ctx, sel.key, previewW, previewH, s);
      return plateRect(state.logo, previewW, previewH, s);
    },
    [sel, state, previewW, previewH, textRect]
  );

  useEffect(() => {
    if (!assets || !fontsReady) return;
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = previewW;
    cv.height = previewH;
    const ctx = cv.getContext('2d');
    const raf = requestAnimationFrame(() => {
      const draw = isWeb ? drawWebCard : drawCard;
      draw(ctx, previewW, previewH, state, assets, {
        selection: selectionRect(ctx),
        editingKey: editing,
        guides: guides ? { show: true, step: snap.step, x: guides.x, y: guides.y } : null,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [state, assets, fontsReady, previewW, previewH, selectionRect, isWeb, editing, guides, snap.step]);

  /* ---- in-place text editing (as on the thumbnail page) ---- */
  const editingField = editing ? state.text[editing] : null;
  const editorStyle = useMemo(() => {
    if (!editingField || !canvasRef.current || !stageRef.current) return null;
    const ctx = canvasRef.current.getContext('2d');
    const s = scaleFor(previewW, previewH);
    const r = textRect(ctx, editing, previewW, previewH, s);
    if (!r) return null;
    const cr = canvasRef.current.getBoundingClientRect();
    const sr = stageRef.current.getBoundingClientRect();
    const k = cr.width / previewW;
    const spec = isWeb ? WEB_TEXT[editing] : null;
    const family = isWeb ? (spec.font === 'chip' || spec.font === 'display' ? 'Archivo' : 'Doto') : editingField.font === 'display' ? 'F37Analog' : 'RLOkima';
    const px = r.px * k;
    const lineH = r.lineH * k;
    const lines = Math.max(1, String(editingField.text).split(/\r?\n|\|\|/).length);
    return {
      left: cr.left - sr.left + r.x * k - 8,
      top: cr.top - sr.top + r.y * k - 4,
      width: Math.max(r.w * k, 160) + 16,
      height: lineH * lines + 10,
      fontSize: px,
      lineHeight: `${lineH}px`,
      fontFamily: `"${family}", system-ui, sans-serif`,
      fontWeight: isWeb ? spec.weight : 400,
      textAlign: editingField.align,
      textTransform: editingField.upper ? 'uppercase' : 'none',
      color: editingField.color || (isWeb ? web.ink : '#fff'),
    };
  }, [editingField, editing, previewW, previewH, isWeb, state.text, state.style]);

  useEffect(() => {
    if (editing && editorRef.current) {
      editorRef.current.focus();
      editorRef.current.select();
    }
  }, [editing]);

  const onDoubleClick = (e) => {
    const [px, py] = toCanvas(e);
    const hit = pick(px, py);
    if (!hit || hit.kind !== 'text') return;
    dragRef.current = null;
    setSel({ kind: 'text', key: hit.key });
    setEditing(hit.key);
    setOpenSig((o) => ({ ...o, [hit.key]: (o[hit.key] || 0) + 1 }));
  };

  /* ---- hit testing ---- */
  const pick = (px, py) => {
    const ctx = canvasRef.current.getContext('2d');
    const s = scaleFor(previewW, previewH);
    for (const key of ['title', 'name', 'eyebrow']) {
      const r = textRect(ctx, key, previewW, previewH, s);
      if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { kind: 'text', key, ref: { nx: state.text[key].nx, ny: state.text[key].ny } };
      }
    }
    const pr = plateRect(state.logo, previewW, previewH, s);
    if (pr && px >= pr.x && px <= pr.x + pr.w && py >= pr.y && py <= pr.y + pr.h) {
      return { kind: 'logo', ref: { nx: state.logo.nx, ny: state.logo.ny } };
    }
    const byZ = [...state.subjects].sort((a, b) => b.z - a.z);
    for (const sub of byZ) {
      const r = subjectRect(sub, previewW, previewH);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { kind: 'subject', id: sub.id, ref: { nx: sub.nx, ny: sub.ny } };
      }
    }
    return null;
  };

  const toCanvas = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * previewW, ((e.clientY - rect.top) / rect.height) * previewH];
  };

  const onPointerDown = (e) => {
    const [px, py] = toCanvas(e);
    const hit = pick(px, py);
    setSel(hit ? (hit.kind === 'text' ? { kind: 'text', key: hit.key } : hit.kind === 'logo' ? { kind: 'logo' } : { kind: 'subject', id: hit.id }) : null);
    if (!hit) return;
    canvasRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { hit, startX: px, startY: py, ref: hit.ref };
  };

  /* Where the dragged thing would sit at (nx, ny), snapped. Hold ⌥ to skip. */
  const snapped = (st, hit, nx, ny, free) => {
    if (!snap.on || free) return { nx, ny, guide: null };
    const ctx = canvasRef.current.getContext('2d');
    const s = scaleFor(previewW, previewH);
    let rect = null;
    if (hit.kind === 'subject') {
      const sub = st.subjects.find((x) => x.id === hit.id);
      rect = sub && subjectRect({ ...sub, nx, ny }, previewW, previewH);
    } else if (hit.kind === 'text') {
      const field = { ...st.text[hit.key], nx, ny };
      rect = isWeb ? webTextRect(ctx, field, previewW, previewH, s, hit.key) : classicTextRect(ctx, field, previewW, previewH, s);
    } else {
      rect = plateRect({ ...st.logo, nx, ny }, previewW, previewH, s);
    }
    if (!rect) return { nx, ny, guide: null };
    const r = snapRect(rect, previewW, previewH, snap.step);
    return { nx: nx + r.dx / previewW, ny: ny + r.dy / previewH, guide: { x: r.guideX, y: r.guideY } };
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const [px, py] = toCanvas(e);
    const rawX = d.ref.nx + (px - d.startX) / previewW;
    const rawY = d.ref.ny + (py - d.startY) / previewH;
    const free = e.altKey;
    // snapped against the current render's state — a frame stale at worst,
    // and it keeps the state updater free of side effects
    const { nx, ny, guide } = snapped(state, d.hit, rawX, rawY, free);
    setGuides(snap.on && !free ? { x: guide?.x ?? null, y: guide?.y ?? null } : null);
    setState((st) => {
      if (d.hit.kind === 'subject') return { ...st, subjects: st.subjects.map((s) => (s.id === d.hit.id ? { ...s, nx, ny } : s)) };
      if (d.hit.kind === 'text') return { ...st, text: { ...st.text, [d.hit.key]: { ...st.text[d.hit.key], nx, ny } } };
      return { ...st, logo: { ...st.logo, nx, ny } };
    });
  };

  const endDrag = (e) => {
    if (dragRef.current) canvasRef.current.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setGuides(null);
  };

  // wheel must be a non-passive listener or preventDefault() is ignored
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e) => {
      if (!sel || sel.kind !== 'subject') return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.03 : 1 / 1.03;
      setState((st) => ({
        ...st,
        subjects: st.subjects.map((s) => (s.id === sel.id ? { ...s, scale: clamp(s.scale * f, 0.05, 3) } : s)),
      }));
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [sel]);

  useEffect(() => {
    const onKey = (e) => {
      if (!sel || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const step = e.shiftKey ? 0.02 : 0.004;
      const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const mv = map[e.key];
      if (!mv) return;
      e.preventDefault();
      setState((st) => {
        if (sel.kind === 'subject')
          return { ...st, subjects: st.subjects.map((s) => (s.id === sel.id ? { ...s, nx: s.nx + mv[0], ny: s.ny + mv[1] } : s)) };
        if (sel.kind === 'text') {
          const f = st.text[sel.key];
          return { ...st, text: { ...st.text, [sel.key]: { ...f, nx: f.nx + mv[0], ny: f.ny + mv[1] } } };
        }
        return { ...st, logo: { ...st.logo, nx: st.logo.nx + mv[0], ny: st.logo.ny + mv[1] } };
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel]);

  /* ---- adding images ----
   *
   * Every subject keeps `raw` (the cut-out as delivered) and `img` (the PSD
   * grade applied): the classic style draws the grade, the website style
   * draws the raw cut-out, as the site does. */
  const cutoutFor = async (file, name) => {
    if (useCloud) {
      const r = await cloudEnhance(file, { upscale: cloudUpscale, removeBackground: true }, (m) => setStatus(`${name} — ${m}`));
      if (!r.cutout) throw new Error('the cloud returned no cut-out');
      return r.cutout;
    }
    const blob = await cutout(file, (m) => setStatus(`${name} — ${m}`));
    return createImageBitmap(blob);
  };

  const addHeadshots = async (files) => {
    setBusy(true);
    try {
      const list = Array.from(files);
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setStatus(`${file.name} — starting`);
        if (file.size > 0 && Math.min(...(await dims(file))) < 500 && !useCloud) {
          setStatus(`${file.name} — low resolution, will look soft at full size`);
        }
        let raw = await cutoutFor(file, file.name);
        // trim to the opaque extent so a headshot cut from a wide frame isn't a
        // frame-wide hit box when two are placed together
        const bounds = alphaBounds(raw);
        if (trimWorthwhile(bounds)) raw = cropTo(raw, bounds);
        const graded = gradeCutout(raw);
        setState((st) => {
          const z = st.subjects.length ? Math.max(...st.subjects.map((s) => s.z)) + 1 : 0;
          const n = st.subjects.length;
          const web = st.style === 'web';
          return {
            ...st,
            subjects: [
              ...st.subjects,
              {
                id: nextId++,
                name: file.name,
                file,
                raw,
                img: graded,
                nx: n === 0 ? 0.5 : 0.5 + (n % 2 === 1 ? -0.16 : 0.16) * Math.ceil(n / 2),
                // the site seats a full-width square photo 6% down the card
                ny: web ? 0.435 : 0.66,
                scale: web ? 0.75 : 0.62,
                z,
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

  /** Re-run one placed headshot through the website's pipeline. */
  const enhanceSubject = async (sub, upscale) => {
    setBusy(true);
    try {
      const source = sub.file || sub.raw;
      const r = await cloudEnhance(source, { upscale, removeBackground: true }, (m) => setStatus(`${sub.name} — ${m}`));
      if (!r.cutout) throw new Error('the cloud returned no cut-out');
      let raw = r.cutout;
      const bounds = alphaBounds(raw);
      if (trimWorthwhile(bounds)) raw = cropTo(raw, bounds);
      const graded = gradeCutout(raw);
      setState((st) => ({
        ...st,
        subjects: st.subjects.map((s) => (s.id === sub.id ? { ...s, raw, img: graded } : s)),
      }));
      setStatus(r.steps.join(' · '));
    } catch (err) {
      setStatus(`Enhance failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  const addLogo = async (file) => {
    const bmp = await createImageBitmap(file);
    const { canvas } = trimLogo(bmp);
    setState((st) => {
      const logo = { ...st.logo, img: canvas, name: file.name, show: true };
      return { ...st, logo: { ...logo, ...logoPlacement(st.ar, st.style, logo) }, text: creditFor(st.text, st.ar, st.style, true) };
    });
    setSel({ kind: 'logo' });
  };

  const setLogoShow = (on) =>
    setState((st) => {
      const logo = { ...st.logo, show: on };
      return { ...st, logo: on ? { ...logo, ...logoPlacement(st.ar, st.style, logo) } : logo, text: creditFor(st.text, st.ar, st.style, on) };
    });

  /* ---- export ---- */
  const download = async () => {
    setBusy(true);
    setStatus('Rendering full size');
    try {
      const blob = isWeb ? await exportWebPng(state, assets, state.ar, ASPECTS) : await exportPng(state, assets, state.ar);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(state.text.name.text) || 'hcn-card'}-${state.style}-${state.ar.replace(':', 'x')}.png`;
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
    const { subjects, logo, ...rest } = state;
    const preset = { ...rest, logo: { ...logo, img: null } };
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hcn-card-preset.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadPreset = async (file) => {
    const preset = JSON.parse(await file.text());
    setState((st) => ({
      ...st,
      ...preset,
      style: preset.style === 'web' ? 'web' : 'classic',
      web: { ...WEB_DEFAULTS, ...preset.web },
      // presets saved before the scrim gained depth/falloff only carry max+top
      scrim: { ...SCRIM_DEFAULTS, ...preset.scrim },
      subjects: st.subjects,
      logo: { ...preset.logo, img: st.logo.img },
    }));
  };

  /* Switching style re-templates text and scrim — the two layouts share
   * nothing, so carrying positions across would just be wrong. Headshots
   * stay where they are. The site's cards are 4:5; the classic default 3:4
   * follows it across, any other ratio is a choice and is kept. */
  const setStyle = (style) =>
    setState((st) => {
      if (st.style === style) return st;
      const ar = style === 'web' && st.ar === '3:4' ? '4:5' : style === 'classic' && st.ar === '4:5' ? '3:4' : st.ar;
      const text = creditFor(defaultText(ar, style), ar, style, st.logo.show);
      return { ...st, style, ar, text, scrim: defaultScrim(ar, style), logo: { ...st.logo, ...logoPlacement(ar, style, st.logo) } };
    });

  const upd = (path, value) =>
    setState((st) => {
      if (path[0] === 'text') return { ...st, text: { ...st.text, [path[1]]: { ...st.text[path[1]], [path[2]]: value } } };
      if (path[0] === 'logo') return { ...st, logo: { ...st.logo, [path[1]]: value } };
      if (path[0] === 'web') return { ...st, web: { ...st.web, [path[1]]: value } };
      if (path[0] === 'scrim') {
        const scrim = { ...st.scrim, [path[1]]: value };
        // the solid band lives inside the total height — pulling `top` down drags `full` with it
        if (scrim.full > scrim.top) scrim[path[1] === 'top' ? 'full' : 'top'] = value;
        return { ...st, scrim };
      }
      return { ...st, [path[0]]: value };
    });

  const setPalette = (i) => setState((st) => ({ ...st, web: { ...st.web, palette: i, ...PALETTES[i] } }));

  const updSubject = (id, key, value) =>
    setState((st) => ({ ...st, subjects: st.subjects.map((s) => (s.id === id ? { ...s, [key]: value } : s)) }));

  const reorder = (id, dir) =>
    setState((st) => {
      const byZ = [...st.subjects].sort((a, b) => a.z - b.z);
      const i = byZ.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= byZ.length) return st;
      [byZ[i], byZ[j]] = [byZ[j], byZ[i]];
      const zmap = new Map(byZ.map((s, k) => [s.id, k]));
      return { ...st, subjects: st.subjects.map((s) => ({ ...s, z: zmap.get(s.id) })) };
    });

  const selectedSubject = sel?.kind === 'subject' ? state.subjects.find((s) => s.id === sel.id) : null;
  const layerOrder = useMemo(() => [...state.subjects].sort((a, b) => b.z - a.z), [state.subjects]);
  const web = { ...WEB_DEFAULTS, ...state.web };
  const lineLabels = isWeb
    ? { eyebrow: 'EP chip', name: 'name', title: 'title, company' }
    : { eyebrow: 'announcement', name: 'headline', title: 'credit' };

  return (
    <div className="app">
      <header>
        <div className="mark">
          <span className="dot" style={{ background: isWeb ? web.glow : state.color }} />
          HCN CARD STUDIO
        </div>
        <Tabs path={path} />
        <div className="head-actions">
          <button className="ghost" onClick={savePreset}>Save preset</button>
          <button className="ghost" onClick={() => presetRef.current.click()}>Load preset</button>
          <button className="primary" onClick={download} disabled={busy || !assets}>
            Download PNG
          </button>
        </div>
        <input ref={presetRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files[0] && loadPreset(e.target.files[0])} />
      </header>

      <main>
        <section className="stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="card"
            style={{ aspectRatio: `${W} / ${H}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
          />
          {editingField && editorStyle && (
            <textarea
              ref={editorRef}
              className="inline-edit"
              style={editorStyle}
              value={String(editingField.text).replace(/\|\|/g, '\n')}
              spellCheck={false}
              wrap="off"
              onChange={(e) => upd(['text', editing, 'text'], e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                  e.preventDefault();
                  setEditing(null);
                }
                e.stopPropagation();
              }}
            />
          )}
          <p className="hint">
            {status ||
              (editing
                ? 'Editing on the card — Esc or ⌘Enter to finish.'
                : `Drag anything on the card${snap.on ? ' — it snaps to the grid, centre and margins; hold ⌥ to drag freely' : ''}. Double-click text to edit it in place.`)}
          </p>
        </section>

        <aside className="panel">
          <Group title="Card" defaultOpen>
            <Segmented label="Style" value={state.style} onChange={setStyle}
              options={[{ value: 'classic', label: 'Classic' }, { value: 'web', label: 'Website' }]} />
            <Row label="Aspect ratio">
              <select value={state.ar} onChange={(e) => upd(['ar'], e.target.value)}>
                {Object.keys(ASPECTS).map((k) => (
                  <option key={k} value={k}>
                    {k} — {ASPECTS[k][0]}x{ASPECTS[k][1]}
                  </option>
                ))}
              </select>
            </Row>
            {!isWeb && <ColorRow label="Accent" value={state.color} onChange={(hex) => upd(['color'], hex)} />}
          </Group>

          {isWeb && (
            <Group title="Website look" defaultOpen>
              <Row label="Palette">
                <select value={web.palette} onChange={(e) => setPalette(Number(e.target.value))}>
                  {PALETTES.map((p, i) => (
                    <option key={p.name} value={i}>{p.name}</option>
                  ))}
                </select>
              </Row>
              <ColorRow label="Backdrop" value={web.bg} onChange={(hex) => upd(['web', 'bg'], hex)} />
              <ColorRow label="Glow" value={web.glow} onChange={(hex) => upd(['web', 'glow'], hex)} />
              <ColorRow label="Type" value={web.ink} onChange={(hex) => upd(['web', 'ink'], hex)} />
              <ColorRow label="Chip" value={web.chip} onChange={(hex) => upd(['web', 'chip'], hex)} />
              <Slider label="Glow strength" value={web.glowStrength} min={0} max={1} step={0.01} onChange={(v) => upd(['web', 'glowStrength'], v)} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Row label="Halftone dots">
                <input type="checkbox" checked={web.halftone} onChange={(e) => upd(['web', 'halftone'], e.target.checked)} />
              </Row>
              <Row label="Headshot shadow">
                <input type="checkbox" checked={web.shadow} onChange={(e) => upd(['web', 'shadow'], e.target.checked)} />
              </Row>
              <Row label="HCN mark">
                <input type="checkbox" checked={web.mark} onChange={(e) => upd(['web', 'mark'], e.target.checked)} />
              </Row>
              <p className="empty">The glow and the halftone centre on the front headshot's head, as the site's do.</p>
            </Group>
          )}

          <Group title="Bottom gradient">
            <Slider label="Darkness" value={state.scrim.max} min={0} max={1} step={0.01} onChange={(v) => upd(['scrim', 'max'], v)} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="Total height" value={state.scrim.top} min={0} max={2400} step={10} onChange={(v) => upd(['scrim', 'top'], v)} />
            <Slider label="Solid depth" value={state.scrim.full} min={0} max={2400} step={10} onChange={(v) => upd(['scrim', 'full'], v)} />
            <Slider label="Falloff" value={state.scrim.falloff} min={0.2} max={4} step={0.05} onChange={(v) => upd(['scrim', 'falloff'], v)} fmt={(v) => v.toFixed(2)} />
            <p className="empty">
              Height is the whole gradient, depth the solid band at the base — both measured up from the card edge.
              {isWeb ? ' In the website style the gradient is the backdrop colour, as on the site.' : ' Falloff below 1 fades early and lingers dark; above 1 holds clear then drops fast.'}
            </p>
          </Group>

          <Group title="Headshots" defaultOpen>
            {cloud.configured && (
              <Segmented label="Cutout engine" value={engine} onChange={setEngine}
                options={[{ value: 'browser', label: 'In browser' }, { value: 'cloud', label: 'Cloud (fal)' }]} />
            )}
            {useCloud && (
              <>
                <Row label="Upscale first">
                  <input type="checkbox" checked={cloudUpscale} onChange={(e) => setCloudUpscale(e.target.checked)} />
                </Row>
                <p className="empty">
                  The website's pipeline: Topaz Gigapixel ($0.08) then Bria RMBG 2.0 ($0.018) per headshot, billed to the fal
                  account. Cleaner edges than the in-browser model, and it runs on the server.
                </p>
              </>
            )}
            <DropZone label={busy ? 'Working…' : 'Add headshots'} multiple disabled={busy} onFiles={addHeadshots} />
            {layerOrder.length === 0 && <p className="empty">Add a headshot to start. Backgrounds come off automatically.</p>}
            <ul className="layers">
              {layerOrder.map((s) => (
                <li key={s.id} className={sel?.kind === 'subject' && sel.id === s.id ? 'on' : ''} onClick={() => setSel({ kind: 'subject', id: s.id })}>
                  <span className="lname">{s.name}</span>
                  <span className="lbtns">
                    <button onClick={(e) => (e.stopPropagation(), reorder(s.id, 1))} title="Forward">↑</button>
                    <button onClick={(e) => (e.stopPropagation(), reorder(s.id, -1))} title="Back">↓</button>
                    <button onClick={(e) => (e.stopPropagation(), setState((st) => ({ ...st, subjects: st.subjects.filter((x) => x.id !== s.id) })))} title="Remove">×</button>
                  </span>
                </li>
              ))}
            </ul>
            {selectedSubject && (
              <>
                <Slider label="Size" value={selectedSubject.scale} min={0.05} max={2} step={0.005} onChange={(v) => updSubject(selectedSubject.id, 'scale', v)} fmt={(v) => `${Math.round(v * 100)}%`} />
                {cloud.configured && (
                  <div className="seg">
                    <button disabled={busy} onClick={() => enhanceSubject(selectedSubject, true)} title="Topaz upscale, then Bria cut-out — $0.10">
                      Enhance in cloud
                    </button>
                    <button disabled={busy} onClick={() => enhanceSubject(selectedSubject, false)} title="Bria cut-out only — $0.018">
                      Re-cut in cloud
                    </button>
                  </div>
                )}
              </>
            )}
          </Group>

          {['eyebrow', 'name', 'title'].map((key, i) => (
            <Group key={key} title={`Line ${i + 1} — ${lineLabels[key]}`} openSignal={openSig[key] || 0}>
              <textarea
                rows={key === 'title' ? 2 : 1}
                value={state.text[key].text}
                placeholder={key === 'title' ? 'Use || to force a line break' : ''}
                onChange={(e) => upd(['text', key, 'text'], e.target.value)}
                onFocus={() => setSel({ kind: 'text', key })}
              />
              <Slider label="Size" value={state.text[key].size} min={30} max={420} step={1} onChange={(v) => upd(['text', key, 'size'], v)} />
              <Row label="Align">
                <div className="seg">
                  {['left', 'center', 'right'].map((a) => (
                    <button key={a} className={state.text[key].align === a ? 'on' : ''} onClick={() => upd(['text', key, 'align'], a)}>
                      {a[0].toUpperCase()}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Show">
                <input type="checkbox" checked={state.text[key].show} onChange={(e) => upd(['text', key, 'show'], e.target.checked)} />
              </Row>
              <Row label="Shrink to fit width">
                <input type="checkbox" checked={state.text[key].fit !== false} onChange={(e) => upd(['text', key, 'fit'], e.target.checked)} />
              </Row>
            </Group>
          ))}

          <Group title="Company logo">
            <Row label="Include">
              <input type="checkbox" checked={state.logo.show} onChange={(e) => setLogoShow(e.target.checked)} />
            </Row>
            <p className="empty">Sits bottom-left on the credit line; the credit moves to the right to make room. Drag either to adjust.</p>
            <DropZone label={state.logo.img ? `Replace — ${state.logo.name}` : 'Add logo'} onFiles={([f]) => addLogo(f)} />
            <Slider label="Plate height" value={state.logo.height} min={100} max={420} step={2} onChange={(v) => upd(['logo', 'height'], v)} />
            <Slider label="Padding" value={state.logo.pad} min={0} max={140} step={1} onChange={(v) => upd(['logo', 'pad'], v)} />
            <Slider label="Corner radius" value={state.logo.radius} min={0} max={2.4} step={0.05} onChange={(v) => upd(['logo', 'radius'], v)} fmt={(v) => `${Math.round(v * REF.PLATE_RADIUS)}px`} />
          </Group>

          <Group title="Layout">
            <Row label="Snap while dragging">
              <input type="checkbox" checked={snap.on} onChange={(e) => setSnap((x) => ({ ...x, on: e.target.checked }))} />
            </Row>
            <Row label="Grid step">
              <select value={snap.step} onChange={(e) => setSnap((x) => ({ ...x, step: Number(e.target.value) }))}>
                {GRID_STEPS.map((g) => (
                  <option key={g} value={g}>{g} units</option>
                ))}
              </select>
            </Row>
            <p className="empty">Snaps the dragged item's edges and centre to the grid, the card's centre lines and the inner margins. Hold ⌥ for a free drag.</p>
            <button
              className="wide ghost"
              onClick={() =>
                setState((st) => ({
                  ...st,
                  text: creditFor(defaultText(st.ar, st.style), st.ar, st.style, st.logo.show),
                  scrim: defaultScrim(st.ar, st.style),
                  logo: { ...defaultLogo(st.ar, st.style), ...logoPlacement(st.ar, st.style, st.logo), img: st.logo.img, name: st.logo.name, show: st.logo.show },
                }))
              }
            >
              Reset text to template
            </button>
          </Group>
        </aside>
      </main>
    </div>
  );
}

async function dims(file) {
  try {
    const bmp = await createImageBitmap(file);
    return [bmp.width, bmp.height];
  } catch {
    return [9999, 9999];
  }
}
