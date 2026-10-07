/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modal — 12px radius (the container ceiling), deep soft shadow (PRD §19.4,
 * §19.6, §19.7).
 * Escape and backdrop close; focus is trapped while open and returned to the
 * trigger when it closes.
 */

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Renders a sticky header bar with this title. */
  title?: React.ReactNode;
  /** Optional glyph shown before the title. */
  icon?: React.ReactNode;
  /** Accessible name when no visible title is rendered. */
  ariaLabel?: string;
  children: React.ReactNode;
  /** Sticky footer content. */
  footer?: React.ReactNode;
  /** Panel width utility classes. */
  widthClassName?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  title,
  icon,
  ariaLabel,
  children,
  footer,
  widthClassName = 'max-w-lg'
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Remember the trigger, focus the panel, restore on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(raf);
      restoreRef.current?.focus();
    };
  }, [open]);

  // Escape closes; Tab cycles within the dialog.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Scrim, not a frosted panel — the only intentional translucency. */}
      <div data-scrim="true" className="absolute inset-0 bg-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-modal border border-border-soft bg-surface shadow-modal outline-none',
          widthClassName
        )}
      >
        {(title || icon) && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-soft bg-surface px-5 py-4">
            <div className="flex min-w-0 items-center gap-2">
              {icon && <span className="text-primary shrink-0">{icon}</span>}
              <h2 className="type-h6 truncate text-base">{title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              title="Close"
              className="rounded-nav p-1.5 text-text-muted transition-colors duration-200 hover:bg-page-alt hover:text-text-heading cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-soft bg-page-alt px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
