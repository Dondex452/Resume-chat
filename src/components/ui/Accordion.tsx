/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Accordion — native <details>/<summary> with a circular +/− toggle in the
 * accent colour; the open state tints the title (PRD §19.6).
 */

import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from './cn';

export interface AccordionProps extends Omit<React.DetailsHTMLAttributes<HTMLDetailsElement>, 'title'> {
  title: React.ReactNode;
  defaultOpen?: boolean;
}

export default function Accordion({
  title,
  defaultOpen = false,
  className,
  children,
  ...rest
}: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className={cn('group rounded-card border border-border-soft bg-surface', className)}
      {...rest}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 select-none">
        <span
          className={cn(
            'font-heading text-base font-medium transition-colors duration-300 ease-in-out',
            open ? 'text-accent' : 'text-text-heading'
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-button border transition-colors duration-300 ease-in-out',
            open ? 'border-accent bg-accent text-white' : 'border-border bg-transparent text-accent'
          )}
          aria-hidden="true"
        >
          {open ? <Minus size={13} /> : <Plus size={13} />}
        </span>
      </summary>
      <div className="type-body px-4 pb-4">{children}</div>
    </details>
  );
}
