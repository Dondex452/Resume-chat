/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Card — bordered surface at the 8px container step. No shadow: static cards
 * sit flat, and depth is reserved for things that genuinely float (PRD §19.4 /
 * DESIGN.md elevation).
 */

import React from 'react';
import { cn } from './cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds the default inner padding. Defaults to true. */
  padded?: boolean;
}

export default function Card({ padded = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn('rounded-card border border-border-soft bg-surface', padded && 'p-4', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
