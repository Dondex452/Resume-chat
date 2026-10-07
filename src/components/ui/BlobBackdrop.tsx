/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * BlobBackdrop — the reference's ambient blur art (PRD §19.1, §19.3).
 *
 * Rendered as one fixed, full-viewport layer beneath every pane; the app's
 * surfaces are opaque so this art reads only in the gaps between them. Three
 * tones only — a blue, an indigo-blue and one warm counterpoint, at low
 * opacity. No pink, no lavender (PRD §19.9.10). Purely decorative: never
 * focusable, never structural, and disabled under `prefers-reduced-motion`.
 *
 * Positions are viewport-relative and deliberately seeded into the app's two
 * biggest voids — the lower chat region and behind the resume paper.
 */

import React from 'react';

interface BlobSpec {
  tone: 'blue' | 'indigo' | 'warm';
  style: React.CSSProperties;
}

/** Viewport seeds — the studio's panes and every fixed, full-screen layer. */
const VIEWPORT_BLOBS: BlobSpec[] = [
  {
    tone: 'blue',
    style: { top: '-150px', left: '-100px', width: '460px', height: '460px', opacity: 0.4 }
  },
  {
    tone: 'indigo',
    style: { top: '2%', right: '-130px', width: '420px', height: '420px', opacity: 0.34, animationDelay: '-6s' }
  },
  // Behind the resume paper — the preview pane's largest void.
  {
    tone: 'blue',
    style: { top: '34%', right: '2%', width: '410px', height: '410px', opacity: 0.3, animationDelay: '-14s' }
  },
  // One warm counterpoint, kept below the blue tones in weight.
  {
    tone: 'warm',
    style: { bottom: '-130px', right: '12%', width: '440px', height: '440px', opacity: 0.26, animationDelay: '-18s' }
  },
  // The chat pane's lower region.
  {
    tone: 'blue',
    style: { bottom: '5%', left: '24%', width: '400px', height: '400px', opacity: 0.3, animationDelay: '-12s' }
  },
  {
    tone: 'indigo',
    style: { bottom: '15%', left: '36%', width: '360px', height: '360px', opacity: 0.28, animationDelay: '-24s' }
  }
];

/**
 * Section seeds — the home page's light run, which begins *below* the drenched
 * hero (PRD §19.3 "The drench"). Same three tones at the same weights as the
 * viewport set, but every seed is anchored at a non-negative `top`, so no blob's
 * box can reach back up into the gradient. Percentages resolve against the
 * section wrapper, not the viewport, so the art spreads across the whole run.
 */
const SECTION_BLOBS: BlobSpec[] = [
  {
    tone: 'blue',
    style: { top: '4%', left: '-160px', width: '460px', height: '460px', opacity: 0.36 }
  },
  {
    tone: 'indigo',
    style: { top: '22%', right: '-140px', width: '420px', height: '420px', opacity: 0.32, animationDelay: '-6s' }
  },
  {
    tone: 'blue',
    style: { top: '48%', right: '2%', width: '410px', height: '410px', opacity: 0.28, animationDelay: '-14s' }
  },
  // One warm counterpoint, kept below the blue tones in weight.
  {
    tone: 'warm',
    style: { bottom: '-140px', right: '12%', width: '440px', height: '440px', opacity: 0.24, animationDelay: '-18s' }
  },
  {
    tone: 'blue',
    style: { bottom: '16%', left: '22%', width: '400px', height: '400px', opacity: 0.28, animationDelay: '-12s' }
  },
  {
    tone: 'indigo',
    style: { bottom: '2%', left: '38%', width: '360px', height: '360px', opacity: 0.26, animationDelay: '-24s' }
  }
];

export interface BlobBackdropProps {
  /** Multiplies every blob's opacity — use a low value in dense panes. */
  intensity?: number;
  /**
   * `viewport` (default) fixes the layer to the screen — right for the studio's
   * panes. `section` makes it absolute inside its container and swaps in seeds
   * that stay below the container's top edge, for the home page's light run
   * beneath the drenched hero (PRD §19.3).
   */
  placement?: 'viewport' | 'section';
  className?: string;
}

export default function BlobBackdrop({
  intensity = 1,
  placement = 'viewport',
  className
}: BlobBackdropProps) {
  const blobs = placement === 'section' ? SECTION_BLOBS : VIEWPORT_BLOBS;

  return (
    <div
      className={`blob-backdrop ${placement === 'section' ? 'blob-backdrop--section' : ''} ${className ?? ''}`}
      aria-hidden="true"
    >
      {blobs.map((blob, index) => (
        <span
          key={index}
          className={`blob blob--${blob.tone}`}
          style={{ ...blob.style, opacity: (Number(blob.style.opacity) || 0) * intensity }}
        />
      ))}
    </div>
  );
}
