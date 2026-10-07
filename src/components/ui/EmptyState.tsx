/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * EmptyState — a bordered 8px panel with a leading glyph beside the title.
 * The glyph is not a decorative tile floating above the heading (a banned
 * pattern, PRD §19.9). No shadow: it is a static surface.
 */

import React from 'react';
import { cn } from './cn';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  children,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'w-full max-w-sm rounded-card border border-border-soft bg-surface px-5 py-5',
        className
      )}
      {...rest}
    >
      <div className="flex items-center gap-2.5">
        {icon && <span className="shrink-0 text-primary">{icon}</span>}
        <h3 className="type-h6 min-w-0">{title}</h3>
      </div>
      {description && <p className="type-body mt-2 text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
      {children}
    </div>
  );
}
