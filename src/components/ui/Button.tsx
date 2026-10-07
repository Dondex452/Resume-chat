/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Button — PRD §19.2 / §19.6.
 * Inter 500 (product register: buttons and labels use the body face — Rubik is
 * reserved for headings), 4px radius, `all .2s ease-in-out`. Primary hover is a
 * *lighter* shade, active a darker one. Outline variants subtract 2px of padding.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'white' | 'white-outline' | 'danger';
export type ButtonSize = 'lg' | 'md' | 'xs';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Square padding only — for icon-only buttons. */
  iconOnly?: boolean;
  /** Icon rendered before the label. */
  startIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  endIcon?: React.ReactNode;
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  lg: 'px-btn-lg-x py-btn-lg-y text-btn-lg',
  md: 'px-btn-x py-btn-y text-btn',
  xs: 'px-btn-xs-x py-btn-xs-y text-btn-xs'
};

const OUTLINE_SIZE_CLASS: Record<ButtonSize, string> = {
  lg: 'px-btn-lg-ox py-btn-lg-oy text-btn-lg',
  md: 'px-btn-ox py-btn-oy text-btn',
  xs: 'px-btn-xs-ox py-btn-xs-oy text-btn-xs'
};

const ICON_SIZE_CLASS: Record<ButtonSize, string> = {
  lg: 'p-3',
  md: 'p-2',
  xs: 'p-1.5'
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover active:bg-primary-active',
  outline: 'border border-primary bg-transparent text-primary hover:bg-primary-soft active:bg-primary-soft',
  ghost: 'bg-transparent text-text-body hover:bg-tint hover:text-text-heading active:bg-tint',
  white: 'border border-border bg-surface text-text-heading hover:bg-page-alt active:bg-page-alt',
  /* For the drenched surface (PRD §19.3 "The drench"): a `--primary` outline
     vanishes against the blue end of the ramp, so the secondary is a white
     outline. Hover is an opaque on-dark fill — never a translucent panel. */
  'white-outline':
    'border border-page bg-transparent text-page hover:bg-on-dark-field-hover active:bg-on-dark-field',
  danger: 'bg-danger text-white hover:bg-danger/90 active:bg-danger/80'
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  iconOnly = false,
  startIcon,
  endIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isOutline = variant === 'outline' || variant === 'white' || variant === 'white-outline';

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-button font-body font-medium',
        'transition-all duration-200 ease-in-out select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        iconOnly ? ICON_SIZE_CLASS[size] : isOutline ? OUTLINE_SIZE_CLASS[size] : SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className
      )}
      {...rest}
    >
      {iconOnly ? (
        loading ? (
          <Loader2
            size={size === 'lg' ? 18 : size === 'xs' ? 13 : 15}
            className="animate-spin"
            aria-hidden="true"
          />
        ) : (
          children
        )
      ) : (
        <>
          {loading ? (
            <Loader2
              size={size === 'lg' ? 18 : size === 'xs' ? 13 : 15}
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            startIcon
          )}
          {children}
          {!loading && endIcon}
        </>
      )}
    </button>
  );
}
