/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ToolTab — the studio's text tool rail (PRD §19.10 rule 2).
 *
 * A tool is text, not a chip: Rubik-500 at 16/22, normal tracking, no fill and
 * no border box. `active` is primary text plus a 2px primary underline;
 * inactive is the muted neutral and turns primary on hover. `PillTab` remains
 * the `#/` tab-bar primitive (PRD §19.4) — the two never swap roles.
 */

import React, { forwardRef } from 'react';
import { cn } from './cn';

export interface ToolTabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Primary text plus a 2px primary underline. */
  active?: boolean;
  /** Optional leading glyph. */
  icon?: React.ReactNode;
  /** Optional trailing glyph (e.g. a disclosure chevron). */
  endIcon?: React.ReactNode;
}

const ToolTab = forwardRef<HTMLButtonElement, ToolTabProps>(function ToolTab(
  { active = false, icon, endIcon, className, children, type = 'button', disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        // `min-w-11` keeps an icon-only tool at the 44px touch floor; `py-3`
        // reaches a 48px box from the 22px leading (vertical padding, not a
        // min-height hack).
        'inline-flex min-w-11 shrink-0 items-center justify-center gap-2 px-3 py-3',
        'border-b-2 bg-transparent',
        // `type-label` is Rubik 500 at 16/22 with normal tracking, and it sets
        // no colour — so the colour utilities below apply (GOTCHAS #28).
        'type-label whitespace-nowrap transition-colors duration-200 ease-in-out',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        // The branches are mutually exclusive: a border-colour collision
        // (`border-transparent` vs `border-primary`) would resolve by generated
        // CSS order, not by class order.
        active
          ? 'border-primary text-primary'
          : disabled
            ? 'border-transparent text-text-disabled'
            : 'border-transparent text-text-muted hover:text-primary',
        className
      )}
      {...rest}
    >
      {icon}
      {children}
      {endIcon}
    </button>
  );
});

export default ToolTab;
