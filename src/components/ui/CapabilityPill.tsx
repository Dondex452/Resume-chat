/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * CapabilityPill — surfaces the probed model tier (PRD §5.2, §19.6).
 * full = success · fallback = warning · chat-only = danger · unknown = muted.
 *
 * State is a solid dot (or leading icon) in the semantic colour plus plain
 * text; the key phrase carries weight, not colour. There is no tinted fill —
 * a pale green/amber/red wash is the banned "AI shade" and fails contrast
 * (PRD §19.9.9). Rows are separated by a hairline divider at the call site.
 */

import React from 'react';
import { Zap } from 'lucide-react';
import { CapabilityTier } from '../../types';
import { cn } from './cn';

export const CAPABILITY_LABELS: Record<CapabilityTier, string> = {
  full: 'Native tool calling: full workflow',
  fallback: 'No native tool calling: structured updates use the JSON-block path',
  'chat-only': 'Conversation only: structured updates unavailable',
  unknown: 'Capability not checked yet'
};

const DOT_CLASS: Record<CapabilityTier, string> = {
  full: 'bg-success',
  fallback: 'bg-warning',
  'chat-only': 'bg-danger',
  unknown: 'bg-text-disabled'
};

const ICON_CLASS: Record<CapabilityTier, string> = {
  full: 'text-success',
  fallback: 'text-warning',
  'chat-only': 'text-danger',
  unknown: 'text-text-muted'
};

export interface CapabilityPillProps extends React.HTMLAttributes<HTMLDivElement> {
  tier: CapabilityTier;
  /** Overrides the default label for the tier. */
  label?: string;
  /** Optional ISO timestamp of the last probe. */
  checkedAt?: string | null;
  /** Show the Zap glyph in the tier colour instead of a status dot. */
  icon?: boolean;
}

export default function CapabilityPill({
  tier,
  label,
  checkedAt,
  icon = false,
  className,
  ...rest
}: CapabilityPillProps) {
  const text = label ?? CAPABILITY_LABELS[tier];
  // "Native tool calling: full workflow" — the phrase before the colon carries
  // the emphasis; the detail stays in body weight.
  const colon = text.indexOf(':');
  const head = colon === -1 ? text : text.slice(0, colon);
  const detail = colon === -1 ? '' : text.slice(colon + 1).trim();

  return (
    <div className={cn('flex items-start gap-2.5 py-2', className)} {...rest}>
      {icon ? (
        <span className={cn('mt-0.5 shrink-0', ICON_CLASS[tier])} aria-hidden="true">
          <Zap size={15} />
        </span>
      ) : (
        <span
          className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-button', DOT_CLASS[tier])}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0">
        <p className="font-body text-meta text-text-body">
          <span className="font-semibold text-text-heading">{head}</span>
          {detail ? `: ${detail}` : ''}
        </p>
        {checkedAt && (
          <p className="type-meta mt-0.5">Checked {new Date(checkedAt).toLocaleString()}</p>
        )}
      </div>
    </div>
  );
}
