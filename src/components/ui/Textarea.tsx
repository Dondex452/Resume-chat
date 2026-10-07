/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Textarea — matches Input, with a comfortable body-size default.
 */

import React, { forwardRef } from 'react';
import { cn } from './cn';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
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

export default Textarea;
