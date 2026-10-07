/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TemplateShowcase — the home page's template gallery, as a live carousel.
 *
 * Rebuilt (M8.5i) to match the measured reference (DESIGN.md "Carousel spec",
 * PRD §19.9.11–13). The previous implementation was a one-card focus carousel
 * with peeking, dimmed neighbours; it read nothing like the reference, whose
 * track shows five cards and moves exactly one slot at a time.
 *
 * Geometry contract:
 *  - 5 cards visible at ≥1024px · 3 at 768–1023 · 1 below 768. The count is
 *    measured in JS from the viewport (and re-measured on resize), as the
 *    reference does. Each slide is `100% / visible` wide with a 12px inset
 *    (24px gutter), 24px below 480px.
 *  - The track is `overflow: hidden` and moves **only** by `transform`. No
 *    native scrolling anywhere.
 *
 * Motion contract (PRD §19.9.12):
 *  - Auto-advance one card every 4000ms with `transform 0.6s ease-in-out`.
 *  - The loop **rotates the slide array on `transitionend`** and resets the
 *    index with the transition off, so the rewind is never visible. The track
 *    is never duplicated.
 *  - Pauses on hover AND on focus; arrows stop autoplay outright; arrows still
 *    work and the step is instant under `prefers-reduced-motion: reduce`.
 *  - No `aria-live` region: auto-advancing content must not talk over a screen
 *    reader.
 *
 * IMPORTANT: the mock-ups are **decorative divs**, not the real renderer.
 * Mounting `PreviewPaper`/`ResumeRenderer` here would add extra
 * `[data-resume-paper]` elements, and the studio's PDF export picks the first
 * *visible* one — the wrong paper (GOTCHA #24). The home page must keep zero.
 *
 * The designs come from `src/templates.ts`; the list is never duplicated here.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { TEMPLATES, TemplateDefinition } from '../../templates';
import { cn } from '../ui';

type MockVariant = 'centered' | 'sidebar-left' | 'sidebar-right' | 'header-band' | 'tabular';

const VARIANT_BY_ID: Record<string, MockVariant> = {
  minimal: 'centered',
  executive: 'centered',
  tech: 'tabular',
  creative: 'sidebar-left',
  ivory: 'centered',
  slate: 'header-band',
  bold: 'header-band',
  sidebar: 'sidebar-right',
  compact: 'tabular',
  startup: 'centered'
};

/** One card every four seconds (DESIGN.md "Carousel spec"). */
const AUTO_ADVANCE_MS = 4000;

/** Cards visible by viewport width — the reference's own thresholds. */
function visibleFor(width: number): number {
  if (width >= 1024) return 5;
  if (width >= 768) return 3;
  return 1;
}

function rotateLeft<T>(items: T[], by = 1): T[] {
  return [...items.slice(by), ...items.slice(0, by)];
}

function rotateRight<T>(items: T[], by = 1): T[] {
  return [...items.slice(items.length - by), ...items.slice(0, items.length - by)];
}

/* -------------------------------------------------------------------------- */
/* Decorative mock — square inner shapes: the card is rounded, so nothing nested
   inside it is (DESIGN.md nested-rounding rule). */
/* -------------------------------------------------------------------------- */

function TextLines({ dense = false }: { dense?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <div className={cn('h-1 w-2/5 bg-border', dense && 'w-1/3')} />
      <div className="h-1 w-full bg-border" />
      <div className="h-1 w-11/12 bg-border" />
      {!dense && <div className="h-1 w-4/5 bg-border" />}
    </div>
  );
}

function MiniLayout({ variant }: { variant: MockVariant }) {
  if (variant === 'sidebar-left' || variant === 'sidebar-right') {
    return (
      <div className="flex h-full w-full gap-2 overflow-hidden border border-border bg-surface p-2">
        {variant === 'sidebar-left' && <div className="w-1/4 bg-tint" />}
        <TextLines />
        {variant === 'sidebar-right' && <div className="w-1/4 bg-tint" />}
      </div>
    );
  }

  if (variant === 'header-band') {
    return (
      <div className="flex h-full w-full flex-col gap-2 overflow-hidden border border-border bg-surface p-2">
        <div className="h-3 w-full bg-primary" />
        <TextLines dense />
      </div>
    );
  }

  if (variant === 'tabular') {
    return (
      <div className="flex h-full w-full gap-2 overflow-hidden border border-border bg-surface p-2">
        {[0, 1].map((col) => (
          <div key={col} className="flex flex-1 flex-col gap-1">
            <div className={cn('h-1 w-1/2', col === 0 ? 'bg-primary' : 'bg-border')} />
            <div className="h-1 w-full bg-border" />
            <div className="h-1 w-full bg-border" />
            <div className="h-1 w-4/5 bg-border" />
            <div className="h-1 w-full bg-border" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center gap-1.5 overflow-hidden border border-border bg-surface p-2">
      <div className="h-2 w-1/2 bg-primary" />
      <div className="h-1.5 w-1/3 bg-border" />
      <div className="mt-1 w-full space-y-1">
        <div className="h-1 w-full bg-border" />
        <div className="h-1 w-full bg-border" />
        <div className="h-1 w-2/3 bg-border" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface TemplateCardProps {
  template: TemplateDefinition;
  onOpenStudio: () => void;
}

/**
 * One carousel card: a decorative mock, the template name, and a CTA to the
 * studio. The long description is deliberately dropped — at five-up these cards
 * are only ~230px wide (its place is the studio's template list).
 *
 * Hover (≥768px) tints the card over 200ms and slides-fades the CTA up over
 * 400ms. Below 768px the CTA is always visible, because there is no hover.
 */
function TemplateCard({ template, onOpenStudio }: TemplateCardProps) {
  return (
    <a
      href="#/studio"
      onClick={onOpenStudio}
      data-template-card
      aria-label={`Open the studio with the ${template.name} template`}
      className={cn(
        'group flex h-full w-full flex-col rounded-card border border-border-soft bg-tint p-3',
        'transition-colors duration-200 ease-in-out hover:bg-border-cool'
      )}
    >
      <div className="h-24 w-full" aria-hidden="true">
        <MiniLayout variant={VARIANT_BY_ID[template.id] ?? 'centered'} />
      </div>
      <p className="mt-3 truncate font-body text-sm font-medium text-text-heading">{template.name}</p>
      <span
        className={cn(
          'mt-auto inline-flex items-center gap-1 pt-2 font-body text-xs font-medium text-primary',
          'md:translate-y-1.5 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100',
          'md:group-focus-visible:translate-y-0 md:group-focus-visible:opacity-100'
        )}
        style={{
          transition:
            'transform var(--motion-cta) var(--ease-default), opacity var(--motion-cta) var(--ease-default)'
        }}
      >
        Open in studio
        <ArrowRight size={12} aria-hidden="true" />
      </span>
    </a>
  );
}

/* -------------------------------------------------------------------------- */

export interface TemplateShowcaseProps {
  onOpenStudio: () => void;
}

export default function TemplateShowcase({ onOpenStudio }: TemplateShowcaseProps) {
  const [visible, setVisible] = useState(() =>
    typeof window === 'undefined' ? 5 : visibleFor(window.innerWidth)
  );
  const [order, setOrder] = useState<TemplateDefinition[]>(TEMPLATES);
  const [offset, setOffset] = useState(0);
  const [noTransition, setNoTransition] = useState(false);
  const [activeDot, setActiveDot] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  /** Once an arrow is used the reference stops autoplay; we keep that. */
  const [autoplay, setAutoplay] = useState(true);

  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const animatingRef = useRef(false);
  const offsetRef = useRef(0);
  const directionRef = useRef<1 | -1>(1);
  const visibleRef = useRef(visible);
  const touchStartX = useRef<number | null>(null);

  const count = TEMPLATES.length;

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  /* Honour the OS motion preference, and keep honouring it if it changes. */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  /* Rotate the array and reset to rest with the transition off. The visual is
     identical before and after, so the rewind is never visible. */
  const settleNext = useCallback(() => {
    setNoTransition(true);
    setOrder((current) => rotateLeft(current));
    setOffset(0);
    offsetRef.current = 0;
    animatingRef.current = false;
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => setNoTransition(false))
    );
  }, []);

  /* Advance exactly one card. `dir = 1` animates and rotates on `transitionend`;
     `dir = -1` pre-shifts the array (transition off), then animates back to rest
     so the previous card slides in from the left. */
  const advance = useCallback((dir: 1 | -1) => {
    if (animatingRef.current) return;
    animatingRef.current = true;
    directionRef.current = dir;
    setActiveDot((current) => (current + dir + count) % count);

    if (dir === 1) {
      offsetRef.current = 1;
      setOffset(1);
      return;
    }

    setNoTransition(true);
    setOrder((current) => rotateRight(current));
    setOffset(-1);
    offsetRef.current = -1;
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        setNoTransition(false);
        setOffset(0);
      })
    );
  }, [count]);

  const handleTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.target !== trackRef.current) return;
      if (event.propertyName !== 'transform') return;
      if (!animatingRef.current) return;
      if (directionRef.current === 1) {
        settleNext();
      } else {
        offsetRef.current = 0;
        animatingRef.current = false;
      }
    },
    [settleNext]
  );

  /* Re-measure the visible count on resize, and settle any in-flight step
     instantly so a width change never lands mid-animation. */
  useEffect(() => {
    const onResize = () => {
      const next = visibleFor(window.innerWidth);
      if (next === visibleRef.current) return;
      if (animatingRef.current && offsetRef.current === 1) {
        setOrder((current) => rotateLeft(current));
      }
      offsetRef.current = 0;
      animatingRef.current = false;
      setNoTransition(true);
      setOffset(0);
      setVisible(next);
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => setNoTransition(false))
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* Auto-advance. Paused whenever the user is hovering or focused inside, once
     an arrow has been used, or under `prefers-reduced-motion: reduce`. */
  const paused = hovered || focused || reduced || !autoplay;
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => advance(1), AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [paused, advance]);

  /* Arrows stop autoplay (the reference's behaviour, and a stricter guarantee
     than pausing: the user has taken control of the strip). */
  const manual = useCallback(
    (dir: 1 | -1) => {
      setAutoplay(false);
      advance(dir);
    },
    [advance]
  );

  /* Mobile swipe — 30px drag threshold. */
  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start == null) return;
    const end = event.changedTouches[0]?.clientX;
    if (end == null) return;
    const dx = end - start;
    if (dx <= -30) advance(1);
    else if (dx >= 30) advance(-1);
  };

  const trackStyle: React.CSSProperties = {
    transform: `translateX(${(-100 / visible) * offset}%)`,
    transition: noTransition
      ? 'none'
      : 'transform var(--motion-carousel) var(--ease-default)',
    willChange: 'transform'
  };

  const arrowClass = cn(
    'group absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center',
    'rounded-button text-text-muted'
  );
  const arrowFaceClass = cn(
    'flex h-10 w-10 items-center justify-center rounded-modal border border-border bg-surface',
    'transition-colors duration-200 ease-in-out',
    'group-hover:border-border-cool group-hover:bg-tint group-hover:text-text-heading'
  );

  return (
    <section id="templates" className="scroll-mt-header border-y border-border-soft bg-page-alt py-10 md:py-14 lg:py-16">
      <div className="mx-auto max-w-content-xl px-4">
        <div className="max-w-content-sm">
          <h2 className="type-h2">Ten designs, one click apart</h2>
          <p className="mt-2 font-body text-base leading-relaxed text-text-muted">
            Every resume renders through the same engine, so switching a template never reorders or
            drops your content.
          </p>
        </div>

        {/* The carousel. `aria-roledescription` names the widget; there is
            deliberately no `aria-live` region, because auto-advancing content
            must not interrupt a screen reader (PRD §19.9.12). */}
        <div
          role="region"
          aria-roledescription="carousel"
          aria-label="Resume template designs"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <div className="relative mt-5">
            <div ref={viewportRef} className="overflow-hidden">
              <div
                ref={trackRef}
                data-carousel-track
                onTransitionEnd={handleTransitionEnd}
                className="flex items-stretch"
                style={trackStyle}
              >
                {order.map((template) => (
                  <div
                    key={template.id}
                    data-carousel-slide
                    className="shrink-0 px-3 max-[479px]:px-6"
                    style={{ width: `calc(100% / ${visible})` }}
                  >
                    <TemplateCard template={template} onOpenStudio={onOpenStudio} />
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              aria-label="Previous template"
              onClick={() => manual(-1)}
              className={cn(arrowClass, 'left-0')}
            >
              <span className={arrowFaceClass}>
                <ChevronLeft size={18} aria-hidden="true" />
              </span>
            </button>
            <button
              type="button"
              aria-label="Next template"
              onClick={() => manual(1)}
              className={cn(arrowClass, 'right-0')}
            >
              <span className={arrowFaceClass}>
                <ChevronRight size={18} aria-hidden="true" />
              </span>
            </button>
          </div>

          {/* Non-interactive indicators: the active dot is the largest. Not a
              numeric counter, and not clickable (DESIGN.md carousel spec). */}
          <div className="mt-5 flex items-center justify-center gap-2" aria-hidden="true">
            {TEMPLATES.map((template, dotIndex) => (
              <span
                key={template.id}
                data-carousel-dot
                className={cn(
                  'rounded-button transition-colors duration-200 ease-in-out',
                  dotIndex === activeDot ? 'h-2 w-2 bg-primary' : 'h-1.5 w-1.5 bg-border'
                )}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
