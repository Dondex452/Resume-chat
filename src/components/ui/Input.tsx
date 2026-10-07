/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Input — 4px radius, hairline border, token-driven focus ring.
 */

import React, { forwardRef } from 'react';
import { cn } from './cn';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-button border border-border bg-surface px-3 py-2 text-sm text-text-body',
        'placeholder:text-text-disabled transition-colors duration-200 ease-in-out',
        'disabled:cursor-not-allowed disabled:bg-page-alt disabled:opacity-60',
        className
      )}
      {...rest}
    />
  );
});

export default Input;
