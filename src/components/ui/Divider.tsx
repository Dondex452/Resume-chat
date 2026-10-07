/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Divider — hairline rule (horizontal or vertical).
 */

import React from 'react';
import { cn } from './cn';

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
  /** Use the softer border tone. */
  soft?: boolean;
}

export default function Divider({ orientation = 'horizontal', soft = false, className, ...rest }: DividerProps) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        soft ? 'bg-border-soft' : 'bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className
      )}
      {...rest}
    />
  );
}
