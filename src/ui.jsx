import React, { useEffect, useState } from 'react';

const FACES = [
  ['F37Analog', '/assets/F37Analog-SemiBold.otf'],
  ['RLOkima', '/assets/RL-Okima-Ink-102.otf'],
];

/* Memoised at module scope so switching pages doesn't re-add a FontFace for
 * each family. Note styles.css also declares both @font-face rules, so
 * document.fonts holds a CSS-declared copy alongside these; that copy stays
 * "unloaded" until some DOM node actually uses it, which is why
 * document.fonts.check() can report false while canvas draws the face fine. */
let brandFonts = null;

export function loadBrandFonts() {
  if (!brandFonts) {
    brandFonts = Promise.all(
      FACES.map(([family, url]) => new FontFace(family, `url(${url})`).load().then((f) => document.fonts.add(f)))
    );
  }
  return brandFonts;
}

export function useBrandFonts() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    loadBrandFonts().then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

export function Group({ title, right, children }) {
  return (
    <section className="group">
      <h2>
        {title}
        {right}
      </h2>
      {children}
    </section>
  );
}

export function Row({ label, children }) {
  return (
    <div className="row">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <div className="row slider">
      <label>
        {label} <b>{fmt ? fmt(value) : Math.round(value)}</b>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

export function ColorRow({ label, value, onChange }) {
  return (
    <Row label={label}>
      <div className="colorline">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <input className="hex" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Row>
  );
}

export function Segmented({ label, value, options, onChange }) {
  return (
    <Row label={label}>
      <div className="seg">
        {options.map((o) => (
          <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
