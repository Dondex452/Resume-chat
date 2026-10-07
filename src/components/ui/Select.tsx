/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Select — native select styled to match Input. `tone="dark"` is for the navy
 * preview band. `className` applies to the wrapper, so layout/visibility
 * utilities (`w-40`, `xl:hidden`) hide the control *and* its chevron.
 */

import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  tone?: 'light' | 'dark';
  /** Classes for the <select> element itself. */
  selectClassName?: string;
}

const TONE_CLASS: Record<'light' | 'dark', string> = {
  light: 'border-border bg-surface text-text-body',
  // Opaque on-dark field — translucency is banned (PRD §19.9.4).
  dark: 'border-on-dark-field bg-on-dark-field text-white hover:bg-on-dark-field-hover'
};

const CHEVRON_CLASS: Record<'light' | 'dark', string> = {
  light: 'text-text-muted',
  dark: 'text-white/70'
};

const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { tone = 'light', className, selectClassName, children, ...rest },
  ref
) {
  return (
    <div className={cn('relative w-full', className)}>
      <select
        ref={ref}
        className={cn(
          'w-full appearance-none rounded-button border px-3 py-2 pr-9 text-sm',
          'cursor-pointer transition-colors duration-200 ease-in-out',
          'disabled:cursor-not-allowed disabled:opacity-60',
          TONE_CLASS[tone],
          selectClassName
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden="true"
        className={cn('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2', CHEVRON_CLASS[tone])}
      />
    </div>
  );
});

export default Select;
