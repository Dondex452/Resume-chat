/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PillTab — the one place a full pill is allowed, alongside avatars
 * (PRD §19.4). Tab buttons: active = primary background + white text.
 * Inactive: `dark` tone = opaque raised navy (for the navy band);
 *           `light` tone = soft neutral for light surfaces.
 */

import React from 'react';
import { cn } from './cn';

export interface PillTabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  tone?: 'light' | 'dark';
}

export default function PillTab({
  active = false,
  tone = 'light',
  className,
  children,
  type = 'button',
  ...rest
}: PillTabProps) {
  const inactive =
    tone === 'dark'
      ? 'bg-on-dark-field text-gray-200 hover:bg-on-dark-field-hover hover:text-white'
      : 'bg-gray-100 text-text-muted hover:bg-gray-200 hover:text-text-heading';

  return (
    <button
      type={type}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-tab font-body font-medium whitespace-nowrap',
        'px-3 py-1.5 text-btn-xs transition-all duration-200 ease-in-out cursor-pointer',
        active ? 'bg-primary text-white' : inactive,
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
