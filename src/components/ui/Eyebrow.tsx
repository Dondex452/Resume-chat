/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Eyebrow — 12/20 uppercase overline, .5px tracking, 50% opacity (PRD §19.2).
 */

import React from 'react';
import { cn } from './cn';

export interface EyebrowProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /** Renders in a light tone for use on the dark navy band. */
  onDark?: boolean;
}

export default function Eyebrow({ onDark = false, className, children, ...rest }: EyebrowProps) {
  return (
    <p
      className={cn('type-eyebrow whitespace-nowrap', onDark && 'on-dark-eyebrow', className)}
      {...rest}
    >
      {children}
    </p>
  );
}
