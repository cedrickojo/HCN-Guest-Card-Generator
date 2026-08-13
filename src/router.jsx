/* A two-page router, hand-rolled because two pages do not justify a
 * dependency. Real paths rather than hashes, so `vercel.json` rewrites
 * everything that isn't a file on disk back to index.html. */
import React, { useEffect, useState } from 'react';

export const ROUTES = [
  { path: '/', label: 'Guest cards' },
  { path: '/thumbnail', label: 'Thumbnails' },
];

export function navigate(path) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function Tabs({ path }) {
  return (
    <nav className="tabs">
      {ROUTES.map((r) => (
        <a
          key={r.path}
          href={r.path}
          className={path === r.path ? 'on' : ''}
          onClick={(e) => {
            // let cmd/ctrl-click open a real new tab
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(r.path);
          }}
        >
          {r.label}
        </a>
      ))}
    </nav>
  );
}
