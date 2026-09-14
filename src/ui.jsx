import React, { useCallback, useEffect, useRef, useState } from 'react';

/* The two brand OTFs, plus the two OFL variable fonts the website substitutes
 * for them (Archivo for F37 Analog, Doto for RL Okima) so the "Website" card
 * style sets exactly as the site does. Variable faces carry a weight range. */
const FACES = [
  ['F37Analog', '/assets/F37Analog-SemiBold.otf', {}],
  ['RLOkima', '/assets/RL-Okima-Ink-102.otf', {}],
  ['Archivo', '/assets/Archivo-Variable.woff2', { weight: '100 900' }],
  ['Doto', '/assets/Doto-Variable.woff2', { weight: '100 900' }],
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
      FACES.map(([family, url, desc]) => new FontFace(family, `url(${url})`, desc).load().then((f) => document.fonts.add(f)))
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

/* Sections collapse to keep the panel scannable; everything starts closed.
 * The whole header is the toggle; `right` (e.g. a remove button) stops
 * propagation so it doesn't double as one. */
export function Group({ title, right, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="group">
      <h2 className="ghead" onClick={() => setOpen((o) => !o)}>
        <span className="gtitle">{title}</span>
        {right && <span className="gright" onClick={(e) => e.stopPropagation()}>{right}</span>}
        <span className="tog" aria-hidden="true">{open ? '−' : '+'}</span>
      </h2>
      {open && children}
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

/* Three ways in: the button, a drop, or a paste.
 *
 * Paste needs a target, because a bare window-level paste handler can't tell
 * whether you meant the headshots, the backdrop or an overlay. Focusing the
 * zone is that target — click it (or tab to it) and it says so, then ⌘V lands
 * there. The listener is on the window because paste only fires on focused
 * editable elements, and this is a div. */
export function DropZone({ label, hint, multiple, onFiles, disabled, children }) {
  const [armed, setArmed] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  const take = useCallback(
    (list) => {
      const files = Array.from(list || []).filter((f) => f.type.startsWith('image/'));
      if (files.length) onFiles(multiple ? files : [files[0]]);
    },
    [multiple, onFiles]
  );

  useEffect(() => {
    if (!armed || disabled) return;
    const onPaste = (e) => {
      // an image copied from a browser or Preview arrives as a file; one copied
      // as a URL does not, and we let that fall through untouched
      const files = Array.from(e.clipboardData?.files || []);
      if (!files.some((f) => f.type.startsWith('image/'))) return;
      e.preventDefault();
      take(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [armed, disabled, take]);

  return (
    <div
      className={`drop${over ? ' over' : ''}${armed ? ' armed' : ''}${disabled ? ' off' : ''}`}
      tabIndex={disabled ? -1 : 0}
      onFocus={() => setArmed(true)}
      onBlur={() => setArmed(false)}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      <button className="wide" disabled={disabled} onClick={() => inputRef.current.click()}>
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
      <p className="dhint">{armed ? 'Ready — press ⌘V to paste' : hint || 'or drop a file, or click here then ⌘V'}</p>
      {children}
    </div>
  );
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
