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
  textRect,
  trimLogo,
} from './card.js';
import { cutout } from './removeBg.js';

const MAX_PREVIEW = 820;

function defaultText(ar) {
  const [W, H] = ASPECTS[ar];
  const s = scaleFor(W, H);
  const bottom = H - REF.MARGIN * s;
  return {
    eyebrow: {
      show: true,
      text: "NEXT WEEK'S GUEST:",
      size: REF.EYEBROW_SIZE,
      nx: 0.5,
      ny: (bottom - REF.EYEBROW_DY * s) / H,
      align: 'center',
      font: 'mono',
      upper: false,
    },
    name: {
      show: true,
      text: 'Guest Name',
      size: REF.NAME_SIZE,
      nx: 0.5,
      ny: (bottom - REF.NAME_DY * s) / H,
      align: 'center',
      font: 'display',
      upper: true,
    },
    title: {
      show: true,
      text: 'Title | Company',
      size: REF.TITLE_SIZE,
      nx: 0.5,
      ny: (bottom - REF.TITLE_DY * s) / H,
      align: 'center',
      font: 'mono',
      upper: false,
    },
  };
}

function defaultLogo(ar) {
  const [W, H] = ASPECTS[ar];
  const s = scaleFor(W, H);
  return {
    show: false,
    img: null,
    name: '',
    height: REF.PLATE_H,
    pad: REF.PLATE_PAD,
    radius: 1,
    nx: (REF.MARGIN * s + 155 * s) / W,
    ny: (H - REF.MARGIN * s - 380 * s) / H,
  };
}

const initialState = (ar = '3:4') => ({
  ar,
  color: '#FF6555',
  subjects: [],
  text: defaultText(ar),
  logo: defaultLogo(ar),
  scrim: { max: REF.SCRIM_MAX, top: REF.SCRIM_TOP, full: REF.SCRIM_FULL, falloff: REF.SCRIM_FALLOFF },
});

const SCRIM_DEFAULTS = { max: REF.SCRIM_MAX, top: REF.SCRIM_TOP, full: REF.SCRIM_FULL, falloff: REF.SCRIM_FALLOFF };

let nextId = 1;

export default function App() {
  const [state, setState] = useState(() => initialState());
  const [assets, setAssets] = useState(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null); // {kind:'subject'|'text'|'logo', id|key}
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const fileRef = useRef(null);
  const logoRef = useRef(null);
  const presetRef = useRef(null);

  const [W, H] = ASPECTS[state.ar];
  const previewW = W >= H ? MAX_PREVIEW : Math.round((MAX_PREVIEW * W) / H);
  const previewH = Math.round((previewW * H) / W);

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
    (async () => {
      const faces = [
        new FontFace('F37Analog', 'url(/assets/F37Analog-SemiBold.otf)'),
        new FontFace('RLOkima', 'url(/assets/RL-Okima-Ink-102.otf)'),
      ];
      await Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l))));
      setFontsReady(true);
    })();
  }, []);

  /* ---- draw ---- */
  const selectionRect = useCallback(
    (ctx) => {
      if (!sel) return null;
      const s = scaleFor(previewW, previewH);
      if (sel.kind === 'subject') {
        const sub = state.subjects.find((x) => x.id === sel.id);
        return sub ? subjectRect(sub, previewW, previewH) : null;
      }
      if (sel.kind === 'text') {
        return textRect(ctx, state.text[sel.key], previewW, previewH, s);
      }
      return plateRect(state.logo, previewW, previewH, s);
    },
    [sel, state, previewW, previewH]
  );

  useEffect(() => {
    if (!assets || !fontsReady) return;
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = previewW;
    cv.height = previewH;
    const ctx = cv.getContext('2d');
    const raf = requestAnimationFrame(() => {
      drawCard(ctx, previewW, previewH, state, assets, { selection: selectionRect(ctx) });
    });
    return () => cancelAnimationFrame(raf);
  }, [state, assets, fontsReady, previewW, previewH, selectionRect]);

  /* ---- hit testing ---- */
  const pick = (px, py) => {
    const ctx = canvasRef.current.getContext('2d');
    const s = scaleFor(previewW, previewH);
    for (const key of ['title', 'name', 'eyebrow']) {
      const r = textRect(ctx, state.text[key], previewW, previewH, s);
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

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const [px, py] = toCanvas(e);
    const dnx = (px - d.startX) / previewW;
    const dny = (py - d.startY) / previewH;
    const nx = d.ref.nx + dnx;
    const ny = d.ref.ny + dny;
    setState((st) => {
      if (d.hit.kind === 'subject') {
        return { ...st, subjects: st.subjects.map((s) => (s.id === d.hit.id ? { ...s, nx, ny } : s)) };
      }
      if (d.hit.kind === 'text') {
        return { ...st, text: { ...st.text, [d.hit.key]: { ...st.text[d.hit.key], nx, ny } } };
      }
      return { ...st, logo: { ...st.logo, nx, ny } };
    });
  };

  const endDrag = (e) => {
    if (dragRef.current) canvasRef.current.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
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

  /* ---- adding images ---- */
  const addHeadshots = async (files) => {
    setBusy(true);
    try {
      const list = Array.from(files);
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setStatus(`${file.name} — starting`);
        if (file.size > 0 && Math.min(...(await dims(file))) < 500) {
          setStatus(`${file.name} — low resolution, will look soft at full size`);
        }
        const blob = await cutout(file, (m) => setStatus(`${file.name} — ${m}`));
        const bmp = await createImageBitmap(blob);
        const graded = gradeCutout(bmp);
        setState((st) => {
          const z = st.subjects.length ? Math.max(...st.subjects.map((s) => s.z)) + 1 : 0;
          const n = st.subjects.length;
          const scale = 0.62;
          return {
            ...st,
            subjects: [
              ...st.subjects,
              {
                id: nextId++,
                name: file.name,
                img: graded,
                nx: n === 0 ? 0.5 : 0.5 + (n % 2 === 1 ? -0.16 : 0.16) * Math.ceil(n / 2),
                ny: 0.66,
                scale,
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

  const addLogo = async (file) => {
    const bmp = await createImageBitmap(file);
    const { canvas } = trimLogo(bmp);
    setState((st) => ({ ...st, logo: { ...st.logo, img: canvas, name: file.name, show: true } }));
    setSel({ kind: 'logo' });
  };

  /* ---- export ---- */
  const download = async () => {
    setBusy(true);
    setStatus('Rendering full size');
    try {
      const blob = await exportPng(state, assets, state.ar);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(state.text.name.text) || 'hcn-card'}-${state.ar.replace(':', 'x')}.png`;
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
      // presets saved before the scrim gained depth/falloff only carry max+top
      scrim: { ...SCRIM_DEFAULTS, ...preset.scrim },
      subjects: st.subjects,
      logo: { ...preset.logo, img: st.logo.img },
    }));
  };

  const upd = (path, value) =>
    setState((st) => {
      if (path[0] === 'text') return { ...st, text: { ...st.text, [path[1]]: { ...st.text[path[1]], [path[2]]: value } } };
      if (path[0] === 'logo') return { ...st, logo: { ...st.logo, [path[1]]: value } };
      if (path[0] === 'scrim') {
        const scrim = { ...st.scrim, [path[1]]: value };
        // the solid band lives inside the total height — pulling `top` down drags `full` with it
        if (scrim.full > scrim.top) scrim[path[1] === 'top' ? 'full' : 'top'] = value;
        return { ...st, scrim };
      }
      return { ...st, [path[0]]: value };
    });

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

  return (
    <div className="app">
      <header>
        <div className="mark">
          <span className="dot" style={{ background: state.color }} />
          HCN CARD STUDIO
        </div>
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
        <section className="stage">
          <canvas
            ref={canvasRef}
            className="card"
            style={{ aspectRatio: `${W} / ${H}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
          <p className="hint">
            {status || 'Drag anything on the card. Scroll to scale a selected headshot. Arrow keys nudge.'}
          </p>
        </section>

        <aside className="panel">
          <Group title="Card">
            <Row label="Aspect ratio">
              <select value={state.ar} onChange={(e) => upd(['ar'], e.target.value)}>
                {Object.keys(ASPECTS).map((k) => (
                  <option key={k} value={k}>
                    {k} — {ASPECTS[k][0]}x{ASPECTS[k][1]}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Accent">
              <div className="colorline">
                <input type="color" value={state.color} onChange={(e) => upd(['color'], e.target.value)} />
                <input className="hex" value={state.color} onChange={(e) => upd(['color'], e.target.value)} />
              </div>
            </Row>
          </Group>

          <Group title="Bottom gradient">
            <Slider label="Darkness" value={state.scrim.max} min={0} max={1} step={0.01} onChange={(v) => upd(['scrim', 'max'], v)} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="Total height" value={state.scrim.top} min={0} max={2400} step={10} onChange={(v) => upd(['scrim', 'top'], v)} />
            <Slider label="Solid depth" value={state.scrim.full} min={0} max={2400} step={10} onChange={(v) => upd(['scrim', 'full'], v)} />
            <Slider label="Falloff" value={state.scrim.falloff} min={0.2} max={4} step={0.05} onChange={(v) => upd(['scrim', 'falloff'], v)} fmt={(v) => v.toFixed(2)} />
            <p className="empty">
              Height is the whole gradient, depth the solid band at the base — both measured up from the card edge.
              Falloff below 1 fades early and lingers dark; above 1 holds clear then drops fast.
            </p>
          </Group>

          <Group title="Headshots">
            <button className="wide" onClick={() => fileRef.current.click()} disabled={busy}>
              {busy ? 'Working…' : 'Add headshots'}
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files.length && addHeadshots(e.target.files)} />
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
              <Slider label="Size" value={selectedSubject.scale} min={0.05} max={2} step={0.005} onChange={(v) => updSubject(selectedSubject.id, 'scale', v)} fmt={(v) => `${Math.round(v * 100)}%`} />
            )}
          </Group>

          {['eyebrow', 'name', 'title'].map((key, i) => (
            <Group key={key} title={`Line ${i + 1} — ${key === 'eyebrow' ? 'announcement' : key === 'name' ? 'headline' : 'credit'}`}>
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
            </Group>
          ))}

          <Group title="Company logo">
            <Row label="Include">
              <input type="checkbox" checked={state.logo.show} onChange={(e) => upd(['logo', 'show'], e.target.checked)} />
            </Row>
            <button className="wide" onClick={() => logoRef.current.click()}>
              {state.logo.img ? `Replace — ${state.logo.name}` : 'Add logo'}
            </button>
            <input ref={logoRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && addLogo(e.target.files[0])} />
            <Slider label="Plate height" value={state.logo.height} min={100} max={420} step={2} onChange={(v) => upd(['logo', 'height'], v)} />
            <Slider label="Padding" value={state.logo.pad} min={0} max={140} step={1} onChange={(v) => upd(['logo', 'pad'], v)} />
            <Slider label="Corner radius" value={state.logo.radius} min={0} max={2.4} step={0.05} onChange={(v) => upd(['logo', 'radius'], v)} fmt={(v) => `${Math.round(v * REF.PLATE_RADIUS)}px`} />
          </Group>

          <Group title="Layout">
            <button className="wide ghost" onClick={() => setState((st) => ({ ...st, text: defaultText(st.ar), logo: { ...defaultLogo(st.ar), img: st.logo.img, name: st.logo.name, show: st.logo.show } }))}>
              Reset text to template
            </button>
          </Group>
        </aside>
      </main>
    </div>
  );
}

/* ---- small UI pieces ---- */

function Group({ title, children }) {
  return (
    <section className="group">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="row">
      <label>{label}</label>
      {children}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <div className="row slider">
      <label>
        {label} <b>{fmt ? fmt(value) : Math.round(value)}</b>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function dims(file) {
  try {
    const bmp = await createImageBitmap(file);
    return [bmp.width, bmp.height];
  } catch {
    return [9999, 9999];
  }
}
