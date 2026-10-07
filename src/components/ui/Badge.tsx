/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Badge — small status/label chip. 4px radius; pills are reserved for tab
 * buttons and avatars (PRD §19.4).
 *
 * A toned badge carries a leading dot at full semantic strength and keeps its
 * text neutral. No tinted fill: a pale semantic wash is the banned "AI shade"
 * (PRD §19.9.9).
 */

import React from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'border-border bg-surface text-text-muted',
  primary: 'border-primary-border bg-surface text-text-body',
  success: 'border-border bg-surface text-text-body',
  warning: 'border-border bg-surface text-text-body',
  danger: 'border-border bg-surface text-text-body',
  info: 'border-border bg-surface text-text-body',
  accent: 'border-border bg-surface text-text-body'
};

const DOT_CLASS: Record<BadgeTone, string | null> = {
  neutral: null,
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent'
};

export default function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  const dot = DOT_CLASS[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-button border px-2.5 py-0.5 text-meta font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        className
      )}
      {...rest}
    >
      {dot && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-button', dot)} aria-hidden="true" />}
      {children}
    </span>
  );
}
