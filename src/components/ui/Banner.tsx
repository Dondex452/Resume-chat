/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Banner — inline info / warn / danger / success notice with an optional action.
 *
 * Tone is carried by a leading icon in the semantic colour plus a 1px rule, on
 * a neutral surface. There is no tinted fill: a pale semantic wash is the banned
 * "AI shade" and pastel-on-pastel fails contrast (PRD §19.9.9). Message text is
 * always `--text-body`.
 */

import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from './cn';

export type BannerTone = 'info' | 'warn' | 'danger' | 'success';

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: BannerTone;
  /** Extra controls rendered before the dismiss button. */
  action?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

// The tone is the 1px rule and the icon, never a fill.
const TONE_CLASS: Record<BannerTone, string> = {
  info: 'border-info',
  warn: 'border-warning',
  danger: 'border-danger',
  success: 'border-success'
};

const ICON_CLASS: Record<BannerTone, string> = {
  info: 'text-info',
  warn: 'text-warning',
  danger: 'text-danger',
  success: 'text-success'
};

function ToneIcon({ tone }: { tone: BannerTone }) {
  const size = 15;
  if (tone === 'warn') return <AlertTriangle size={size} className={ICON_CLASS[tone]} aria-hidden="true" />;
  if (tone === 'success') return <CheckCircle2 size={size} className={ICON_CLASS[tone]} aria-hidden="true" />;
  if (tone === 'info') return <Info size={size} className={ICON_CLASS[tone]} aria-hidden="true" />;
  return <AlertCircle size={size} className={ICON_CLASS[tone]} aria-hidden="true" />;
}

export default function Banner({
  tone = 'info',
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  className,
  children,
  ...rest
}: BannerProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-2.5 rounded-nav border bg-page-alt px-3.5 py-2.5 text-sm text-text-body',
        TONE_CLASS[tone],
        className
      )}
      {...rest}
    >
      <span className="mt-0.5 shrink-0">
        <ToneIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1 leading-snug">{children}</div>
      {(action || onDismiss) && (
        // The controls sit right-aligned beside the message when there is room,
        // and drop to their own full-width line below `sm`. Without this the
        // action steals the row and squeezes the copy into a ~10px column —
        // unreadable on a 390px screen.
        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
          {action}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel}
              title={dismissLabel}
              className="shrink-0 rounded-button p-0.5 text-text-muted transition-colors duration-200 hover:text-text-heading cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
