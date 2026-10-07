/* Self-hosted fonts (PRD §19.2 — no third-party font request, PRD §6) */
import '@fontsource/rubik/400.css';
import '@fontsource/rubik/500.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Hold the window `load` event while the print view prepares itself.
 *
 * The PDF engine (`server/pdfExport.ts`) prints with
 * `--headless=new --print-to-pdf`, which fires **after the `load` event** (and
 * the virtual-time budget). It cannot be told to wait for an application flag —
 * the page's own `data-print-ready` marker is invisible to it. So a print could
 * be taken while the print view was still fetching the session, waiting for web
 * fonts, or computing its one-page fit: measured, the same document exported as
 * one page or two depending on the timing.
 *
 * The fix is to make the page genuinely not finished until it is ready: a pending
 * image request is part of the `load` event, so this holds `load` open until
 * `PrintView` signals readiness (a POST to `/api/print-hold/<token>`), or the
 * server's timeout releases it. That turns a race into a guarantee, and it is
 * why the marker image is added here — at module scope, before `load` — rather
 * than from the component, which by then may be too late.
 *
 * It only runs for the `#/print` route, so nothing else in the app pays for it.
 */
const PRINT_ROUTE_HASH = '#/print';

declare global {
  interface Window {
    __printHoldRelease?: () => Promise<void>;
  }
}

if (typeof window !== 'undefined' && window.location.hash === PRINT_ROUTE_HASH) {
  const token =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);

  const img = document.createElement('img');
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
  img.src = `/api/print-hold?token=${encodeURIComponent(token)}`;
  document.head.appendChild(img);

  let released = false;
  window.__printHoldRelease = async () => {
    if (released) return;
    released = true;
    try {
      await fetch(`/api/print-hold/${encodeURIComponent(token)}`, { method: 'POST' });
    } catch {
      /* the server timeout releases the hold anyway */
    }
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
