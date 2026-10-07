/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PreviewPaper — the white sheet floating on the app background.
 *
 * The resume is authored at true page-pixel dimensions (A4 794 × 1123; Letter
 * 816 × 1056; Legal 816 × 1344; A5 559 × 794, all at 96 dpi) so the PDF export
 * stays faithful; the preview scales that canvas down to whatever width the pane
 * actually has. The format and the orientation both come from
 * `resolveSessionRenderSchema`, so the sheet on screen and the printed pages
 * cannot disagree (PRD §5.4 amended).
 *
 * **M16 (PRD §11 + Decision #27).** Pagination is done by the **browser's own
 * fragmentation engine**, not by measuring the DOM: the print path sets
 * `@page { size; margin }` so every page carries the same margins by
 * construction, and `break-inside: avoid` on the renderer's block markers keeps a
 * work entry or education row whole. This component therefore renders **one
 * flowing sheet that grows with its content** — exactly the document the browser
 * will break — which is what makes the preview and the export the same thing.
 *
 * An earlier attempt measured this DOM and packed explicit page boxes in React.
 * It was abandoned on evidence (viewport-dependent output — 4 / 2 / 1 pages for
 * identical content — and it silently clipped a whole project entry). See
 * `PRD.md` §11 and GOTCHA #60. Do not reintroduce it.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PaperFormat, PageOrientation } from '../templates/customTemplates';
import type { TemplateSchema } from '../templates/schema';
import type { ResumeJSON } from '../types';
import SchemaResumeRenderer from '../templates/render';

export interface PaperDimensions {
  width: number;
  height: number;
}

/**
 * Portrait authoring pixels per page format, at **96 dpi**.
 *
 * A4 and Letter are the pre-M16 values and must not move: the ten built-in
 * templates are pixel-verified (SHA256) against frozen baselines and a single
 * changed pixel is a regression. The two additions are derived from the same DPI:
 *
 *   Legal  8.5 × 14 in  → 8.5 × 96 = 816  · 14 × 96 = 1344
 *   A5     148 × 210 mm → 148/25.4 × 96 = 559.37 → 559 · 210/25.4 × 96 = 793.70 → 794
 *
 * (Letter is exactly the same derivation: 8.5 in × 96 = 816, 11 in × 96 = 1056.)
 */
export const PAPER_SIZES: Record<PaperFormat, PaperDimensions> = {
  A4: { width: 794, height: 1123 },
  Letter: { width: 816, height: 1056 },
  Legal: { width: 816, height: 1344 },
  A5: { width: 559, height: 794 },
};

/** A4 remains the default authoring size. */
export const A4_WIDTH = PAPER_SIZES.A4.width;
export const A4_HEIGHT = PAPER_SIZES.A4.height;

/**
 * The printable height of a nominal page, in CSS px.
 *
 * Chrome's printable area for a nominal A4 sheet is **1122.5 px**, so a box of
 * exactly 1123 px spills a sliver onto a second sheet. The trim is applied
 * consistently wherever the page height is used to author content, so the
 * preview and the export agree on how much room a page has.
 */
export const PAGE_BOX_HEIGHT_TRIM_PX = 2;

/** A nominal page height, trimmed to the printable area. */
export function printablePageHeight(nominalHeight: number): number {
  return Math.max(1, Math.floor(nominalHeight) - PAGE_BOX_HEIGHT_TRIM_PX);
}

/**
 * The vertical page margin used when a design provides no inset of its own, in
 * CSS px (~12.7 mm — comfortably inside the unprintable margin of any desktop
 * printer). Defined here rather than in the print view because the **preview**
 * needs the same number to draw its page separators where the print engine will
 * actually break; the print path imports it from this module so the two cannot
 * disagree.
 */
export const DEFAULT_PRINT_MARGIN_PX = 48;

/**
 * The smallest text reduction the app will apply to make a resume fit one page.
 * 0.70 ≈ body text at 7.4 pt, which is small but still legible; below that it is
 * not worth printing.
 */
/**
 * The smallest text reduction the app will apply to make a resume fit one page.
 *
 * **Raised from 0.70 to 0.80 on 2026-09-23** (print path only - this constant is used by
 * `PrintView`; the studio preview does not shrink at all).
 *
 * At 0.70 the fit would rather crush a document onto one sheet than paginate: measured, a
 * **three-page** CV (10,058 chars, 16 roles) exported as **one** page at exactly 0.70, which
 * renders body text at **6.3 pt** - parseable by a machine, unreadable by a person. The
 * floor exists to protect legibility, and 0.70 did not do that job. At 0.80 a document that
 * cannot be fitted at a readable size **paginates instead**, which is what a CV that runs
 * long should do.
 */
export const MIN_FIT_SCALE = 0.8;

/**
 * How much to reduce the text so the document fits one page.
 *
 * A resume that overruns a page by a little is the common case, and the user's
 * instruction was explicit: *"just reduce the font … for the pdf not by trimming
 * the content"*. So the whole document is made smaller **uniformly, by reducing
 * the layout width and scaling it back up** — which is what makes this different
 * from the earlier attempt that was rejected:
 *
 *  - scaling alone shrinks the box as well, leaving white bands down the sides;
 *  - **laying the content out on a wider canvas and then scaling it down** keeps
 *    the page completely full. The text gets smaller AND more words fit on each
 *    line, so the height falls twice over: measured, a 9 % reduction is enough
 *    where scaling alone needed 17 %.
 *
 * `sqrt` is the right first guess because both effects are proportional: laying
 * out at `width / k` divides the height by roughly `k`, and the transform
 * multiplies it by `k` — so the scaled height falls by about `k²`. The caller
 * re-measures and corrects, which handles the approximation.
 */
export function fitScaleFor(visualHeight: number, budget: number, current: number): number {
  if (visualHeight <= budget || visualHeight <= 0) return 1;
  const next = current * Math.sqrt(budget / visualHeight);
  return Math.max(MIN_FIT_SCALE, Math.min(1, next));
}

/**
 * The effective dimensions of a page, orientation included (PRD §5.4 amended).
 *
 * `landscape` swaps width and height: the sheet is re-laid-out at the wider
 * width, so the content genuinely reflows onto a landscape page rather than
 * being a rotated portrait sheet. Unknown formats degrade to A4 — the same
 * "a bad stored value still renders a real sheet" property `resolveTemplateSchema`
 * has (the server normalises on write; this is the read-side guard).
 */
export function paperDimensions(
  format: PaperFormat,
  orientation: PageOrientation = 'portrait'
): PaperDimensions {
  const base = PAPER_SIZES[format] ?? PAPER_SIZES.A4;
  return orientation === 'landscape' ? { width: base.height, height: base.width } : base;
}

/** `paperDimensions` with the printable trim applied to the height. */
export function printablePageDimensions(
  format: PaperFormat,
  orientation: PageOrientation = 'portrait'
): PaperDimensions {
  const { width, height } = paperDimensions(format, orientation);
  return { width, height: printablePageHeight(height) };
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 0.95;

export interface PreviewPaperProps {
  /** The resolved, country-preset-and-user-aware schema (PRD §11). */
  schema: TemplateSchema;
  /** The resume data the schema renders. */
  data: ResumeJSON;
  /** Effective page format (country preset + user choice aware). Defaults to A4. */
  pageSize?: PaperFormat;
  /** Effective orientation. Defaults to portrait. */
  orientation?: PageOrientation;
  /**
   * An **estimate** of the page count, from the sheet's own rendered height
   * divided by the printable page height. It is what drives the §5.4
   * max-pages advice, and it deliberately makes no claim when the sheet has not
   * been measured (the advice is a `Banner`, never a block).
   */
  onPageCount?: (count: number) => void;
}

/**
 * The floating preview: a scroll viewport that scales one flowing sheet to the
 * pane, and reports how many pages that sheet will occupy once printed.
 *
 * The `ResizeObserver` measures the pane and derives one `scale`; the sheet's own
 * height is measured separately so the scaled wrapper can reserve the right
 * amount of vertical space.
 */
export default function PreviewPaper({
  schema,
  data,
  pageSize = 'A4',
  orientation = 'portrait',
  onPageCount
}: PreviewPaperProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.62);
  const [contentHeight, setContentHeight] = useState(0);
  const { width: pageWidth, height: pageHeight } = paperDimensions(pageSize, orientation);
  const printableHeight = printablePageHeight(pageHeight);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      const styles = window.getComputedStyle(viewport);
      const padding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const available = viewport.clientWidth - padding;
      if (available <= 0) return;
      setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / pageWidth)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [pageWidth]);

  // The sheet's own height, so the page count below is honest. Re-measured when
  // the web fonts settle, because a font swap changes every line box (GOTCHA #51).
  useLayoutEffect(() => {
    const measure = () => {
      const el = paperRef.current;
      if (!el) return;
      const next = el.scrollHeight;
      if (next > 0) setContentHeight(next);
    };

    measure();
    const raf = requestAnimationFrame(measure);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts && typeof fonts.ready?.then === 'function') fonts.ready.then(measure, measure);
    return () => cancelAnimationFrame(raf);
  }, [schema, data, pageSize, orientation, scale]);

  // For the §5.4 page-count advice only. Nothing here reshapes the document: the
  // preview renders the resume at its authored size, exactly as it always has.
  const pageCount = Math.max(1, Math.ceil((contentHeight || 1) / printableHeight));

  useEffect(() => {
    if (!onPageCount) return;
    if (contentHeight <= 0) return;
    onPageCount(pageCount);
  }, [contentHeight, pageCount, onPageCount]);

  // The wrapper reserves the *scaled* space for the unscaled sheet it contains:
  // the sheet's layout box stays at its true pixel size while `transform: scale`
  // does the visual work, so without this the pane would scroll to the wrong
  // height. `max(..., pageHeight)` keeps a short resume on a full-sized page.
  const sheetHeight = Math.max(contentHeight, pageHeight);

  return (
    <div
      ref={viewportRef}
      className="scroll-quiet flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-transparent p-5"
    >
      <div className="shrink-0" style={{ width: pageWidth * scale, height: sheetHeight * scale }}>
        <div
          className="paper-sheet"
          style={{
            width: pageWidth,
            minHeight: pageHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
        >
          <div ref={paperRef} data-resume-paper="true" className="select-text text-gray-800">
            <SchemaResumeRenderer schema={schema} data={data} />
          </div>
        </div>
      </div>
    </div>
  );
}
