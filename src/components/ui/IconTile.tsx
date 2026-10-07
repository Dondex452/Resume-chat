/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * IconTile — the reference's glyph tile (PRD §19.6).
 * 40×40 (md) or 32×32 (sm), 4px radius. Light tones are a hairline outline
 * carrying the glyph in its semantic colour; the fill is reserved for the
 * dark-band variant. A static `-soft` tint is banned (PRD §19.9.9).
 * `interactive` lifts the tile onto the gradient ramp on hover (§19.3/D).
 */

import React from 'react';
import { cn } from './cn';

export type IconTileSize = 'md' | 'sm';
export type IconTileTone = 'primary' | 'accent' | 'dark' | 'success' | 'warning' | 'danger';

export interface IconTileProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: IconTileSize;
  tone?: IconTileTone;
  /** Adds the gradient-ramp hover treatment. */
  interactive?: boolean;
  children: React.ReactNode;
}

const SIZE_CLASS: Record<IconTileSize, string> = {
  md: 'h-10 w-10',
  sm: 'h-8 w-8'
};

const TONE_CLASS: Record<IconTileTone, string> = {
  primary: 'border border-border bg-transparent text-primary',
  accent: 'border border-border bg-transparent text-accent',
  dark: 'bg-on-dark-surface text-white',
  success: 'border border-border bg-transparent text-success',
  warning: 'border border-border bg-transparent text-warning',
  danger: 'border border-border bg-transparent text-danger'
};

export default function IconTile({
  size = 'md',
  tone = 'primary',
  interactive = false,
  className,
  children,
  ...rest
}: IconTileProps) {
  return (
    <span
      data-icon-tile="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-button',
        SIZE_CLASS[size],
        TONE_CLASS[tone],
        interactive && 'icon-tile-interactive',
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
