/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * StatBox — a quiet definition row: the fact on the left, its value on the
 * right, at body size. Deliberately not a giant numeral over a small label
 * (the hero-metric pattern is banned, PRD §19.9.2).
 */

import React from 'react';
import { cn } from './cn';

export interface StatBoxProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  hint?: string;
}

export default function StatBox({ label, value, hint, className, ...rest }: StatBoxProps) {
  return (
    <div className={cn('flex items-start justify-between gap-6 py-2.5', className)} {...rest}>
      <div className="min-w-0">
        <p className="font-body text-sm font-medium text-text-heading">{label}</p>
        {hint && <p className="type-meta mt-0.5">{hint}</p>}
      </div>
      <p className="shrink-0 font-body text-sm font-medium tabular-nums text-text-heading">{value}</p>
    </div>
  );
}
