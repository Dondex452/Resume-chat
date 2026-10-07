/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M15 — the print view (PRD §11, amended 2026-09-21 for M16).
 *
 * The exported PDF used to be a rasterised bitmap: 6,818,220 B for one A4 page,
 * zero text operators, and the app's own `/api/upload-resume` rejected it as a
 * scanned document (`422 EXTRACT_EMPTY`). A resume's PDF exists to be parsed by
 * machines (GOTCHA #56).
 *
 * The fix is to print **our own** page with a browser already installed on the
 * machine. `POST /api/export/resume-pdf` finds a Chrome/Edge, opens
 * `http://localhost:<PORT>/?session=<id>#/print`, and prints it with
 * `--headless=new --print-to-pdf`. This module is that page.
 *
 * Three rules keep it honest:
 *
 *  1. **It renders through the same resolved values as the preview.** Template
 *     resolution (built-in → custom → `minimal`), the country preset **and the
 *     user's own page size/orientation** are folded by
 *     `resolveSessionRenderSchema` — the same function the studio calls — so
 *     preview and export cannot drift (PRD §11, §5.4 amended).
 *  2. **It paginates with the browser, not by measuring.** The document is one
 *     flowing sheet — exactly what the preview draws — and the **page** supplies
 *     the margins (`@page { margin }`), so every page carries the same margins by
 *     construction. The renderer's block markers take `break-inside: avoid`, so a
 *     work entry or education row moves whole rather than being cut in half.
 *     An earlier revision measured this DOM and packed page boxes in React; it
 *     was abandoned because the result was viewport-dependent and it silently
 *     clipped content (PRD §11, Decision #27, GOTCHA #60). Do not bring it back.
 *  3. **It signals when it is worth printing.** Once the sheet is committed and
 *     `document.fonts.ready` has settled, it sets
 *     `document.documentElement.dataset.printReady = 'true'`, exposes the
 *     resolved format as `dataset.printPageSize` and the orientation as
 *     `dataset.printPageOrientation`.
 *
 * It can also drive the browser's own print dialog (M16): reached as
 * `/?session=<id>&print=1#/print`, it calls `window.print()` **once**, and only
 * after the sheet has rendered and the fonts have settled. The headless export
 * deliberately does not pass `print=1`, so it can never open a dialog.
 *
 * There is no app chrome here — no header, sidebar, chat pane, rail, banner,
 * drawer or ambient blob art. Nothing but the resume sheet (or, on failure, a
 * short message the resulting PDF will contain instead of being blank).
 *
 * `[data-resume-paper]`: this page is reached by an early return in `App.tsx`, so
 * the studio is never mounted alongside it and the studio's export helper
 * (`getVisibleResumePaper`) can never be confused by it (GOTCHA #24). The sheet
 * carries the marker once, as a single flowing document.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ResumeJSON, Session } from '../types';
import { DEFAULT_PRINT_MARGIN_PX, MIN_FIT_SCALE, fitScaleFor, paperDimensions, printablePageDimensions } from './PreviewPaper';
import SchemaResumeRenderer from '../templates/render';
import { Button } from './ui';
import {
  parseStoredTemplates,
  resolveSessionRenderSchema,
} from '../templates/customTemplates';
import type { PaperFormat, PageOrientation } from '../templates/customTemplates';
import type { TemplateSchema } from '../templates/schema';

/** The exact hash route this view serves (GOTCHA #47 — the match is exact). */
export const PRINT_ROUTE_HASH = '#/print';

/**
 * The vertical page margin used when a design's own page inset cannot be
 * measured (its root carries no padding). Re-exported from `PreviewPaper`, which
 * the preview also uses to draw its page separators — one number, two consumers,
 * so what the preview shows is what the page prints.
 */
export { DEFAULT_PRINT_MARGIN_PX };

type PrintStatus = 'loading' | 'ready' | 'error';

function readSessionId(): string {
  try {
    return new URLSearchParams(window.location.search).get('session') || '';
  } catch {
    return '';
  }
}

/** `?print=1` — set only by the studio's Print action, never by the engine. */
function readPrintFlag(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('print') === '1';
  } catch {
    return false;
  }
}

function parseResumeJson(raw: string | undefined): ResumeJSON {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ResumeJSON) : {};
  } catch {
    return {};
  }
}

/**
 * Fetch the session being printed. Shape-first, never `res.ok` alone: in dev
 * Vite's SPA fallback answers an unmatched `/api/*` path with `index.html` at
 * HTTP 200 (GOTCHA #15), which would otherwise look like a valid session.
 */
async function fetchSessionById(sessionId: string): Promise<Session | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok && data && typeof data.id === 'string' && data.id === sessionId) {
    return data as Session;
  }
  return null;
}

/**
 * The user's stored templates, indexed for `resolveSessionRenderSchema`.
 *
 * A failure degrades to "built-ins only" and is deliberately silent: this page
 * must contain nothing but the sheet, and an unresolvable custom id still
 * renders a real `minimal` sheet rather than an error (PRD §5.5, GOTCHA #15).
 */
async function fetchCustomTemplateIndex(): Promise<Record<string, TemplateSchema>> {
  const index: Record<string, TemplateSchema> = {};
  try {
    const res = await fetch('/api/templates');
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !Array.isArray(data)) return index;
    for (const template of parseStoredTemplates(data)) index[template.id] = template.schema;
  } catch {
    /* built-ins only */
  }
  return index;
}

/**
 * Print-only CSS.
 *
 * **Margins belong to the page, not to the sheet.** The sheet's own vertical
 * padding is zeroed in print and the same amount is declared as the `@page`
 * margin, so *every* page — first and continuation alike — gets it. That is the
 * whole fix: the sheet has no way to repeat its padding on a later page, and a
 * page with no top margin is a page a printer clips.
 *
 * **Horizontal margin stays 0** on purpose. Several designs (slate, creative,
 * sidebar) are edge-to-edge: their columns carry their own inset and their
 * backgrounds are meant to reach the paper edge. A horizontal `@page` margin
 * would draw a white border around the design the user chose.
 *
 * **Blocks are kept whole by the browser**, which is the one fragmentation engine
 * that is deterministic: `break-inside: avoid` on the renderer's existing
 * `data-paginate-block` markers (a work entry, education row, project,
 * certification, language row) and `break-after: avoid` on headings so a heading
 * is never orphaned at the foot of a page. Nothing here measures anything.
 *
 * The vertical overrides use `!important` because the design's geometry is set by
 * Tailwind classes on the renderer root.
 *
 * No raw colour values: the backgrounds come from tokens (`--paper`, `--page-app`)
 * so a theme change reaches this page too (PRD §19 / Decision #20).
 */
/**
 * Which edge element of the design justifies moving the page's top inset onto
 * the content (see `PrintStyles` → `bleedCss`).
 *
 *  - `column`      — a full-height coloured sidebar flush to a paper edge
 *                    (`creative`, `sidebar`).
 *  - `root-border` — a coloured border down one side of the renderer root
 *                    (`bold`'s 16 px black left rule).
 *
 * Both are measured from the rendered sheet; neither is hardcoded, and no
 * template id is consulted.
 */
type BleedSource = 'column' | 'root-border';

function PrintStyles({
  pageSize,
  orientation,
  marginTop,
  bleed,
  bleedHeight,
}: {
  pageSize: PaperFormat;
  orientation: PageOrientation;
  marginTop: number;
  bleed: boolean;
  bleedHeight: number | null;
}) {
  const { width: pageWidth } = paperDimensions(pageSize, orientation);
  // THE USER'S OWN IDEA, and the only thing that works (probe-verified). A page
  // margin is real paper edge: measured, *nothing* paints in it — not an element
  // background, not the root/canvas background, not a `position: fixed` element
  // (three isolated probes, each printed through this same engine). So a design
  // with an edge-to-edge coloured element showed a bare white notch above it on
  // every continuation page.
  //
  // The fix is to stop putting the inset in the page margin for these designs and
  // put it back on the content, where `box-decoration-break: clone` repeats a
  // fragment's padding on every page. The coloured element keeps its background
  // (padding is painted over, so a column's colour still reaches the paper edge;
  // a left/right border is drawn on every fragment anyway) and the element carrying
  // the text inset — `p-10` on creative's main column, `p-10` on bold's root —
  // repeats it identically on pages 1..n. Probe result: column flush to the top on
  // pages 1/2/3, text first ink identical at 44.5 pt on all three.
  const bleedCss = bleed
    ? [
        '/* Repeat each fragment\'s own padding, so the text keeps its inset on every',
        '   page while the coloured edge reaches the paper edge (see note above). */',
        '[data-resume-paper] > *, [data-paginate-column], [data-resume-sidebar] {',
        '  -webkit-box-decoration-break: clone;',
        '  box-decoration-break: clone;',
        '}',
      ].join('\n  ')
    : '';
  // THE BOTTOM EDGE — the mirror of the note above. The sheet is only as tall as its
  // content, so a 2.5-page document ends halfway down its last page and the coloured
  // column stops there too (measured on `creative`: last page's column ended at 523 pt
  // of 842). Padding the sheet's box to a whole number of pages lets the design's own
  // background/border and its coloured column fill that last page, exactly as the
  // `@page` margin removal lets them reach the top.
  const bleedHeightCss =
    bleed && bleedHeight
      ? [
          `.paper-sheet, [data-resume-paper], [data-resume-paper] > * {`,
          `  min-height: ${bleedHeight}px !important;`,
          `}`,
        ].join('\n  ')
      : '';
  return (
    <style>{`
@page {
  size: ${pageSize} ${orientation};
  margin: ${bleed ? 0 : marginTop}px 0 0 0;
}
/* Page 1 is the ONLY page that already carries the design's own top inset — the
   sheet's padding is applied once, at the top of the flow. Later pages have no
   padding of their own, which is the whole defect: they used to start 9 pt from
   the paper edge. So the page margin is suppressed on the FIRST page only, and
   page 1 renders exactly as the design authored it — including a full-bleed
   header band that reaches the paper edge (slate). Continuation pages get the
   margin from the rule above. Measured with a probe before use. */
@page :first { margin-top: 0; }
html, body { background-color: var(--paper); }
* {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  animation: none !important;
  transition: none !important;
}
.print-root { display: flex; justify-content: center; }

/* Density pass — taken BEFORE the text is reduced.
   Height can be recovered from two places: the gaps between blocks and the leading
   inside them (which nobody reads), or the glyphs themselves (which everybody
   does). Measured, this template renders body copy at 9 pt and the first fit cost
   15 % of it to reach one page; tightening the layout first means less has to come
   off the text. Deliberately OUTSIDE the print block: the fit is measured in screen
   media in this view, so a print-only rule would not be seen by the measurement and
   the fit would over-shrink. This page is chrome-free, so it cannot leak into the
   app, and the studio preview is not touched. */
[data-resume-paper] { --spacing: 0.2rem !important; }
[data-resume-paper] p,
[data-resume-paper] li { line-height: 1.4 !important; }
@media screen {
  /* The sheet is at its TRUE size (794 x 1123 A4, and so on) and is never scaled
     here — that is the whole point of this view. Below that width the root would
     otherwise push the whole document wider than the viewport, so the screen
     version scrolls the sheet instead. Print media is untouched (GOTCHA #59). */
  .print-root { padding: 24px; background-color: var(--page-app); overflow-x: auto; justify-content: flex-start; }
  /* Safe centring: a plain justify-content: center pushes the overflow off BOTH
     ends, so on a narrow window the sheet's left edge became unreachable (-13px).
     Auto inline margins centre normally and collapse to 0 when there is no room. */
  .print-sheet { margin-inline: auto; }
  /* The toolbar exists ONLY on screen. It must never reach the paper, or every
     exported PDF would carry our own button (the headless engine prints this
     same page). */
  .print-toolbar { display: flex; }
}
@media print {
  /* index.css sets html/body/#root to height:100%. A paginated print must be
     allowed to grow past the first page box. */
  html, body, #root { height: auto !important; }
  .print-root { display: block; padding: 0; background-color: var(--paper); }
  .paper-sheet {
    width: auto !important;
    min-height: 0 !important;
    box-shadow: none !important;
  }
  /* A flowing document must grow past the first page box. A document whose text
     has been reduced to fit one page must NOT: its box is the printable page, and
     letting it auto-size made the *unscaled* layout height (1204 px) drive the
     pagination, so the export broke onto a second sheet even though the visible
     content fitted. That was the last defect in the one-page fit. */
  .paper-sheet:not(.print-sheet--fit) { height: auto !important; }
  .print-sheet--fit {
    height: var(--print-fit-height) !important;
    overflow: hidden !important;
  }
  /* Carry a DEFINITE page height down to the renderer root (2026-09-23).
     Every built-in's root carries h-full, so with a definite height here the design
     stretches to the page's bottom edge - a sidebar panel, a band, a tinted column -
     instead of stopping where the text stops. That cut is what the user photographed: a
     teal sidebar ending ~55 px above the paper edge, leaving a white band under it.
     A 100% height against an auto-height parent resolves to auto, so this stays inert for
     a document that overruns and must grow onto a second page. */
  [data-resume-paper] { width: auto !important; height: 100% !important; }
  /* The design's own padding is NOT zeroed anywhere: page 1 must keep its
     authored inset and any full-bleed band. The page margin above only ever
     applies to pages that have no padding of their own (2, 3, ...). */

  /* PRINT USES THE DESKTOP LAYOUT.
     Measured with a probe: inside media-print, NONE of the min-width queries
     match - a 768px query is false on an A4 page in Chrome's headless print. So
     every responsive class a template uses falls back to its NARROW-SCREEN form
     in the export: the header stacks, a two/three-column body collapses to one
     column, and the document grows taller - which is what pushed the user's lower
     sections onto page 2. The preview, seen in a wide window, did match and showed
     the intended layout, hence "the pdf looks nothing like the preview".

     The templates use only five responsive classes in total (measured from the
     template data). They are re-applied here unconditionally for print, restoring
     the layout the design was authored to show at desktop width. A new template
     using another responsive utility needs one line added here - the list is tiny
     and deliberately explicit. */
  [class*='md:flex-row'] { flex-direction: row !important; }
  [class*='md:grid-cols-2'] { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  [class*='md:grid-cols-3'] { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
  [class*='md:col-span-2'] { grid-column: span 2 / span 2 !important; }
  [class*='md:items-center'] { align-items: center !important; }

  /* Keep blocks whole; keep headings with the content they introduce. */
  [data-paginate-block] { break-inside: avoid; }
  [data-paginate-heading] { break-after: avoid; }
  /* A long section may still flow — its blocks are individually protected. */
  [data-paginate-section] { break-inside: auto; }

  /* The two-column body needs no workaround now that its grid classes are
     restored above. Earlier the grid had collapsed to 'grid-cols-1' (because the
     print breakpoints do not match), which stacked the sidebar below the main
     column — a tall row that Chrome then relocated entirely to page 2, leaving a
     blank column where the preview shows Education and Skills. Restoring
     'md:grid-cols-3' / 'md:col-span-2' puts the sidebar back in its own narrow
     cell and the cell stays where it starts. An absolute-positioned workaround was
     used in between and is deliberately gone: with the grid correct it is
     unnecessary, and it would fight the layout. */
  h1, h2, h3, h4 { break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  /* A trailing bottom margin extends the document past the last page box and
     renders a BLANK final sheet. Measured on the user's own resume: content
     filled page 2 and an empty page 3 appeared. Only the last child is touched,
     and only its bottom margin — nothing that separates real content. */
  [data-resume-paper] *:last-child { margin-bottom: 0 !important; }

  ${bleedCss}
  ${bleedHeightCss}
}
/* A safety net for the screen view only: at the nominal page width the sheet is
   as wide as the paper, so no extra rule is needed here. */
.print-sheet { width: ${pageWidth}px; }
`}</style>
  );
}

export default function PrintView() {
  const [status, setStatus] = useState<PrintStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [customIndex, setCustomIndex] = useState<Record<string, TemplateSchema>>({});
  const [margins, setMargins] = useState({
    top: DEFAULT_PRINT_MARGIN_PX,
    bottom: DEFAULT_PRINT_MARGIN_PX,
  });
  const sheetRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);
  // Mirrors `readyRef` as state so the print-dialog effect can react to
  // readiness. A ref alone would never re-run it, and the dialog must not open
  // before the sheet has settled.
  const [ready, setReady] = useState(false);
  // Web fonts change every line box, so a height measured before they land is
  // simply wrong. Measured evidence: with fallback metrics the resume appeared to
  // fit one page, so the fit computed `scale: 1`, the real font then loaded and
  // grew the text, and the export ran to two pages. The fit must therefore be
  // (re)computed once the fonts have settled — GOTCHA #51 in a new place.
  const [fontsSettled, setFontsSettled] = useState(false);
  // How much the text is reduced so the document fits one page (1 = not reduced).
  const [fitScale, setFitScale] = useState(1);
  // Bounded so a scale change that alters the measured height cannot loop.
  const fitPassRef = useRef(0);
  // Fill state: after a fitting scale is found, widen it until the page is full.
  // `best` is the last scale that still fitted; `steps` bounds the climb so a page
  // that oscillates cannot stall the print engine.
  const fillRef = useRef({ best: 0, steps: 0, done: false });
  // True once no further reduction is needed (or the cap is reached). The print
  // must not be taken before this: the engine prints the moment the page is ready,
  // and an unfitted page exports as two sheets while the fitted one is a single
  // sheet - which is exactly what went wrong.
  const [fitSettled, setFitSettled] = useState(false);
  // Whether the fitted document actually fits one page. Drives the definite page box in
  // the render below, which is what lets the design fill the page — a document that
  // overruns must keep `min-height` instead so it can grow and paginate.
  const [fitsPage, setFitsPage] = useState(true);
  // True when the fit has been ABANDONED because the document cannot be made to fit at a
  // legible size. The sheet then renders at its natural height and the browser paginates
  // it onto as many sheets as it needs — the path a genuinely long CV takes.
  const [paginating, setPaginating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sessionId = readSessionId();

    if (!sessionId) {
      setError('No resume was specified for this print view.');
      setStatus('error');
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      const [loadedSession, index] = await Promise.all([
        fetchSessionById(sessionId).catch(() => null),
        fetchCustomTemplateIndex(),
      ]);
      if (cancelled) return;

      if (!loadedSession) {
        setError('This resume could not be loaded for printing.');
        setStatus('error');
        return;
      }
      setSession(loadedSession);
      setCustomIndex(index);
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // One resolution, exactly as the studio does it (PRD §11): the template
  // (built-in → custom → `minimal`), the country preset, and the user's own page
  // size + orientation applied last. `minimal` (A4, portrait) is the idle value
  // while the session loads.
  const { schema, pageSize, orientation } = useMemo(
    () =>
      resolveSessionRenderSchema(
        session?.template_id,
        session?.country_code,
        customIndex,
        session,
      ),
    [
      session?.template_id,
      session?.country_code,
      session?.page_size,
      session?.page_orientation,
      customIndex,
    ],
  );

  const data = useMemo(() => parseResumeJson(session?.resume_json), [session?.resume_json]);

  // Which vertical inset the design already provides. Read from the renderer root
  // (the direct child of `[data-resume-paper]`) — the same element the print CSS
  // zeroes — so the two cannot disagree. When the design has no root padding
  // (slate, creative and sidebar put their inset inside a region), a uniform
  // default is used instead and every page gets a real margin.
  useLayoutEffect(() => {
    if (status !== 'ready') return;
    const root = sheetRef.current?.querySelector<HTMLElement>('[data-resume-paper] > *');
    if (!root) return;
    const styles = window.getComputedStyle(root);
    const top = parseFloat(styles.paddingTop) || 0;
    const bottom = parseFloat(styles.paddingBottom) || 0;
    setMargins({
      top: top > 0 ? Math.round(top) : DEFAULT_PRINT_MARGIN_PX,
      bottom: bottom > 0 ? Math.round(bottom) : DEFAULT_PRINT_MARGIN_PX,
    });
  }, [status, schema]);

  // `undefined` = not measured yet (the print-readiness signal waits for it);
  // `null` = measured, and this design has no edge element that needs the bleed path.
  const [bleed, setBleed] = useState<BleedSource | null | undefined>(undefined);
  // Height, in px, that the sheet must be padded to so the last page is complete.
  // `null` = not needed (single page, or no edge element).
  const [bleedHeight, setBleedHeight] = useState<number | null>(null);

  /**
   * Decide whether this design needs the bleed path in `PrintStyles` (page margin
   * moved onto the content, so `box-decoration-break: clone` can repeat it and the
   * coloured edge can reach the paper edge on every page).
   *
   * The gate is deliberately conservative and **self-verifying**: the bleed path is
   * taken only when the element that would have to carry the repeating inset
   * *actually has a top padding of its own*. A design with a coloured edge but no
   * inset of its own would otherwise print its text flush to the paper edge — the
   * pre-M16 defect — so it keeps the page margin instead.
   *
   * Everything is measured from the rendered sheet: no template id, no colour and no
   * width is hardcoded. Geometry is divided by `[data-resume-paper]`'s own scale so
   * the one-page fit's `transform: scale()` cannot skew it.
   */
  useLayoutEffect(() => {
    if (status !== 'ready') return;
    const paper = sheetRef.current?.querySelector<HTMLElement>('[data-resume-paper]');
    if (!paper) {
      setBleed(null);
      return;
    }
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    // A colour is opaque unless it is `transparent` or carries a zero alpha.
    // NOTE: the alpha channel must be identified as an *alpha*, not as "the last
    // number in the string" — a naive `/,\s*0\)$/` test also matches `rgb(0, 0, 0)`,
    // i.e. black, which is exactly the colour of bold's rule and made it look
    // transparent (measured: page 2 stayed 24 pt short for this reason alone).
    const isOpaque = (colour: string) => {
      if (!colour || colour === 'transparent') return false;
      const slash = colour.match(/\/\s*([\d.]+%?)\s*\)$/); // oklch(… / a), color(… / a)
      if (slash) return Number.parseFloat(slash[1]) > 0;
      const comma = colour.match(/^(?:rgba|hsla)\([^)]*,\s*([\d.]+)\s*\)$/); // rgba(r,g,b,a)
      if (comma) return Number.parseFloat(comma[1]) > 0;
      return true;
    };

    let source: BleedSource | null = null;

    // 1. A full-height coloured column flush to a paper edge (creative, sidebar).
    const column = paper.querySelector<HTMLElement>('[data-resume-sidebar]');
    const main = paper.querySelector<HTMLElement>('[data-paginate-column="main"]');
    if (column && main) {
      const paperRect = paper.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      const scale = paperRect.width > 0 ? paperRect.width / paperDimensions(pageSize, orientation).width : 1;
      if (paperRect.width > 0 && columnRect.width > 0) {
        const left = (columnRect.left - paperRect.left) / scale;
        const right = (paperRect.width - columnRect.width) / scale - left;
        const flush = left <= 1 || right <= 1;
        if (flush && isOpaque(window.getComputedStyle(column).backgroundColor) && pixels(window.getComputedStyle(main).paddingTop) > 0) {
          source = 'column';
        }
      }
    }

    // 2. A coloured border down one side of the renderer root (bold's black rule).
    const root = paper.firstElementChild instanceof HTMLElement ? paper.firstElementChild : null;
    if (!source && root) {
      const rootStyle = window.getComputedStyle(root);
      const edge =
        (pixels(rootStyle.borderLeftWidth) > 0 && isOpaque(rootStyle.borderLeftColor)) ||
        (pixels(rootStyle.borderRightWidth) > 0 && isOpaque(rootStyle.borderRightColor));
      if (edge && pixels(rootStyle.paddingTop) > 0) source = 'root-border';
    }

    setBleed(source);

    // Pad the sheet to a whole number of pages, so the design's coloured column and
    // its background/border reach the BOTTOM of the last page too. Only when the
    // document overruns one page — the fitted single-page path already gives the sheet
    // a definite full-page height.
    if (source && paginating) {
      const page = paperDimensions(pageSize, orientation);
      const content = paper.scrollHeight;
      // `- 1` so a box that already ends exactly on a page boundary is not rounded up
      // into an extra, blank page (this measurement re-runs after the padding is
      // applied, so an exact multiple is a real case, not a hypothetical one).
      const pages = Math.max(1, Math.ceil((content - 1) / page.height));
      setBleedHeight(pages * page.height);
    } else {
      setBleedHeight(null);
    }
  }, [status, schema, pageSize, orientation, fitSettled, fitScale, paginating]);

  // The PDF's own title. The server derives the download filename from the
  // session title separately, so this is deliberately not coupled to it.
  useEffect(() => {
    const name = data.basics?.fullName?.trim();
    document.title = name ? `${name} - Resume` : 'Resume';
  }, [data]);

  /**
   * Kept as a **documented negative result**. Marking whole sections
   * `break-inside: avoid` (so a section could never be split, and a continuation
   * page would therefore always start with a heading) was implemented, measured
   * and **removed**:
   *
   *  - it moved the `PROJECTS` section onto page 2 whole, which left ~250 pt of
   *    dead space at the foot of page 1;
   *  - the document then needed *just* more than two pages, and because the
   *    `slate` layout paints a full-height coloured sidebar, the overflow produced
   *    a **third page containing six painted rectangles and no text** — a blank
   *    sheet with the template's background on it;
   *  - two follow-up attempts (excluding empty section wrappers; zeroing the last
   *    child's bottom margin) produced **byte-identical** exports, i.e. they
   *    changed nothing.
   *
   * The trade is therefore explicit: entries are never split (guaranteed by
   * `break-inside: avoid` on the block markers), headings are never orphaned, and
   * every page carries a real margin — but a section CAN continue onto a later
   * page without repeating its heading, because CSS has no way to repeat a
   * heading per page and the alternative costs a blank sheet. Revisit only with
   * evidence, and re-measure the blank-page case first.
   */


  /** Track the web fonts; the fit above is re-measured when they land. */
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.ready?.then !== 'function') {
      setFontsSettled(true);
      return;
    }
    let cancelled = false;
    fonts.ready.then(
      () => { if (!cancelled) setFontsSettled(true); },
      () => { if (!cancelled) setFontsSettled(true); },
    );
    return () => { cancelled = true; };
  }, []);

  /**
   * The print-readiness signal the engine measures from: the sheet is committed
   * and the web fonts have settled. Signalling before the fonts land would let
   * the engine capture different line boxes from the ones the page ends up with
   * (GOTCHA #51). It fires for the error state too, so a failure prints its
   * message instead of waiting out the engine's virtual-time budget.
   */
  useEffect(() => {
    if (status === 'loading') return;
    // Wait for the text reduction AND the bleed measurement to settle before
    // telling the engine we are ready — the bleed path changes the page box.
    if (status === 'ready' && (!fitSettled || bleed === undefined)) return;    const resolvedSize: PaperFormat = status === 'ready' ? pageSize : 'A4';
    const resolvedOrientation: PageOrientation = status === 'ready' ? orientation : 'portrait';
    let cancelled = false;

    const signalReady = () => {
      if (cancelled || readyRef.current) return;
      readyRef.current = true;
      const root = document.documentElement;
      root.dataset.printPageSize = resolvedSize;
      root.dataset.printPageOrientation = resolvedOrientation;
      root.dataset.printReady = 'true';
      setReady(true);
      // Release the `load`-event hold taken in `main.tsx`. Until this fires the
      // browser has not finished loading, so the PDF engine cannot print — which
      // is what makes the exported page deterministic instead of a race.
      void window.__printHoldRelease?.();
    };

    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const wait = fonts && typeof fonts.ready?.then === 'function' ? fonts.ready : Promise.resolve();
    // One frame after the fonts settle, so the box the engine measures is the box
    // the browser has actually laid out.
    wait.then(() => requestAnimationFrame(signalReady), signalReady);

    return () => {
      cancelled = true;
    };
  }, [status, pageSize, orientation, fontsSettled, fitSettled, bleed, bleedHeight]);

  /**
   * Reduce the text so the document fits ONE page — the same arithmetic the
   * preview runs (`fitScaleFor`), so the two cannot describe different documents.
   *
   * The layout width is `pageWidth / fitScale` and the sheet is scaled by
   * `fitScale`: the printed page stays completely full, the text is smaller, and
   * more words fit on each line, so the height falls by roughly the square of the
   * scale. One or two passes converge; the loop is bounded and only ever moves
   * `fitScale` down to `MIN_FIT_SCALE`.
   *
   * Drawing a smaller copy of a wider layout is what keeps this acceptable: scaling
   * alone would have had to shrink the text by 17 % to fit, and would have left
   * white bands down the sides; a measured 9 % is enough here and the page stays
   * full.
   */
  useEffect(() => {
    if (status !== 'ready' || !fontsSettled) return;
    const paper = sheetRef.current?.querySelector<HTMLElement>('[data-resume-paper]');
    if (!paper) return;
    const h = paper.scrollHeight;
    if (h <= 0) return;
    const page = printablePageDimensions(pageSize, orientation);
    // The page's own bottom margin is zero (see the @page rule), so the content may use
    // almost the whole sheet — reserving the full `margins.bottom` here left a band of end
    // white space that nothing could fill, which is the one thing the user asked to go.
    //
    // But not *exactly* the whole sheet: the fit is measured in screen media and then
    // printed, and the two lay out a hair differently. Targeting the edge exactly put
    // `sidebar` on a second page (measured 2026-09-23, where it had been one). A small
    // reserve removes that failure mode for about a line's worth of white.
    const PAGE_EDGE_RESERVE_PX = 6;
    const budget = page.height - PAGE_EDGE_RESERVE_PX;
    const visual = h * fitScale;
    const fill = fillRef.current;
    // Recorded for the render: does the content currently fit inside the page box?
    setFitsPage((prev) => (prev === visual <= budget ? prev : visual <= budget));

    // FILL THE PAGE (2026-09-23). The loop below used to stop at the FIRST scale that
    // fitted, so whatever height was left over printed as end white space — measured at
    // 88-118 px on the user's own CV, and it is the one thing they asked for: *"all i
    // wanted was for you to remove the end white space from only the pdfs"*.
    //
    // So after a fitting scale is found, climb in small steps while it still fits, and
    // fall back to the last fitting scale on the first overshoot. Bounded at 1.35 (a
    // document that already fits without shrinking still leaves its slack as white, so
    // filling it means enlarging the text a little) and at 40 steps. PDF only —
    // `PreviewPaper` is not touched by any of this.
    if (fill.done) {
      setFitSettled(true);
      return;
    }

    const fits = visual <= budget;
    if (fits) {
      fill.best = fitScale;
      const grown = +(fitScale * 1.015).toFixed(4);
      if (grown <= 1.35 && grown > fitScale && fill.steps < 40 && budget - visual > 3) {
        fill.steps += 1;
        setFitScale(grown);
        return;
      }
      fill.done = true;
      setFitSettled(true);
      return;
    }

    // It does not fit.
    if (fill.steps > 0) {
      // We were climbing and went one step too far — fall back BELOW the last good
      // scale, not onto it. Landing exactly on the edge tipped `sidebar` onto a second
      // page (measured 2026-09-23: it exported 2 pages where the audit expects 1), and
      // the measurement that declared "fits" is taken before the print engine lays the
      // page out. A 1 % cushion costs ~11 px of white and removes that failure mode.
      fill.done = true;
      const safe = fill.best > 0 ? +(fill.best * 0.99).toFixed(4) : 0;
      if (safe > 0 && Math.abs(safe - fitScale) > 0.0005) setFitScale(safe);
      else setFitSettled(true);
      return;
    }

    // GIVE UP ON FITTING AND PAGINATE (2026-09-23).
    //
    // The shrink has reached MIN_FIT_SCALE and the document still does not fit. Rendering
    // the fixed page box here would CLIP it - content silently lost, which is the worst
    // outcome available. So the fit is abandoned entirely for this document: the sheet
    // goes back to natural height and the browser paginates it onto as many sheets as it
    // needs.
    //
    // This is the path a genuinely long CV takes. Before it existed, a **three-page** CV
    // exported as ONE page at exactly the 0.70 floor - body text at 6.3 pt. The floor is
    // now 0.80 (a legibility limit), so a document that cannot fit readably paginates
    // instead, which is what a long CV should do.
    if (fitScale <= MIN_FIT_SCALE) {
      setPaginating(true);
      setFitSettled(true);
      return;
    }

    // Shrink to find a fitting scale at all (unchanged behaviour, monotone and bounded).
    const fitPass = fitPassRef.current;
    if (fitScale > MIN_FIT_SCALE && fitPass < 6) {
      fitPassRef.current = fitPass + 1;
      const next = fitScaleFor(visual, budget, fitScale);
      if (next < fitScale - 0.005) setFitScale(next);
      else setFitSettled(true);
    } else {
      setFitSettled(true);
    }
  }, [status, fontsSettled, schema, data, pageSize, orientation, margins.top, margins.bottom, fitScale]);

  /**
   * The browser's own print dialog, once, for the **Print / Save as PDF** action
   * only.
   *
   * Two rules make it safe: `autoPrint` comes from `?print=1`, which the headless
   * export never passes (`buildPrintViewUrl` builds `/?session=<id>#/print`), so
   * the engine's render can never hang on a modal dialog; and it waits for the
   * readiness signal above before calling `window.print()`, so the dialog
   * snapshots a fully-styled sheet rather than a half-laid-out one.
   *
   * `printedRef` (not a cleanup flag) is the once-guard: React 18 StrictMode runs
   * this effect twice in development — effect → cleanup → effect — so a
   * cancel-on-cleanup guard would cancel the second run and print nothing.
   */
  const autoPrint = useMemo(readPrintFlag, []);
  const printedRef = useRef(false);

  useEffect(() => {
    if (!autoPrint || status !== 'ready' || !ready || printedRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || printedRef.current) return;
      printedRef.current = true;
      window.print();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [autoPrint, status, ready, margins]);

  return (
    <div className="print-root">
      <PrintStyles
        pageSize={pageSize}
        orientation={orientation}
        marginTop={margins.top}
        bleed={bleed !== null && bleed !== undefined}
        bleedHeight={bleedHeight}
      />
      {/* Screen-only. The user asked to print from the browser, so the tab is
          useful on its own: this button opens the browser's own dialog (paper
          size, scale, margins, printer — all theirs), and Ctrl/Cmd+P works
          without it. It is hidden in print media so the exported PDF can never
          contain our own toolbar. */}
      <div className="print-toolbar fixed top-4 right-4 z-10 hidden items-center gap-3 rounded-card border border-border bg-surface p-2 pl-3 shadow-raised">
        <p className="type-meta">
          Choose <strong className="font-medium">Save as PDF</strong> as the destination.
        </p>
        <Button size="xs" onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>
      {status === 'ready' && session ? (
        <div
          ref={sheetRef}
          className={!paginating && fitScale !== 1 ? 'paper-sheet print-sheet print-sheet--fit shrink-0' : 'paper-sheet print-sheet shrink-0'}
          style={
            !paginating && fitScale !== 1
              ? ({
                  // One page, completely full: the layout is authored on a wider
                  // canvas and scaled back down, so the text is smaller AND fits
                  // more per line, with no white bands. The explicit height is what
                  // stops the unscaled layout height from paginating the page — and it
                  // is the FULL printable sheet, because the page's own bottom margin is
                  // now zero and a shorter box simply left end white space behind.
                  //
                  // Gated on `!== 1`, not `< 1`: the fill climb ENLARGES a document that
                  // already fits (fitScale above 1) to consume its slack, and gating on
                  // `< 1` meant that climb had no rendering effect at all — the fitted
                  // page box and the transform were never applied, so creative and slate
                  // stayed 74-78 px short despite the climb running.
                  '--print-fit-height': `${printablePageDimensions(pageSize, orientation).height}px`,
                  width: printablePageDimensions(pageSize, orientation).width,
                  height: printablePageDimensions(pageSize, orientation).height,
                  overflow: 'hidden',
                  position: 'relative',
                } as React.CSSProperties)
              : undefined
          }
        >
          <div
            style={
              paginating
                ? // Fitting was abandoned: no imposed width, no scale, no box. The sheet is
                  // natural height and the browser fragments it onto as many pages as it
                  // needs. Anything else here would clip the document.
                  undefined
                : {
                    width: printablePageDimensions(pageSize, orientation).width / fitScale,
                    // A DEFINITE page height here is what lets the design fill the page: every
                    // built-in's root carries h-full, and the chain runs
                    // wrapper -> [data-resume-paper] (height 100%) -> root. Without it the chain
                    // dead-ends in an auto height, the root shrinks to the content, and a
                    // sidebar panel is cut ~55 px above the paper edge - the white band the user
                    // photographed. Only given when the document genuinely fits one page; a
                    // document that overruns keeps min-height so it can grow onto page 2.
                    height: fitsPage ? printablePageDimensions(pageSize, orientation).height / fitScale : undefined,
                    minHeight: printablePageDimensions(pageSize, orientation).height / fitScale,
                    ...(fitScale !== 1
                      ? {
                          transform: `scale(${fitScale})`,
                          transformOrigin: 'top left',
                        }
                      : {}),
                  }
            }
          >
            <div data-resume-paper="true" className="select-text text-gray-800">
              <SchemaResumeRenderer schema={schema} data={data} />
            </div>
          </div>
        </div>
      ) : status === 'error' ? (
        <p className="font-body text-text-body p-8">{error}</p>
      ) : (
        <p className="font-body text-text-body p-8">Preparing your resume…</p>
      )}
    </div>
  );
}
