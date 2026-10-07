/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Session } from '../types';
import { Plus, Trash2, Edit3, MessageSquare, ChevronRight, Check, Loader2 } from 'lucide-react';
import { Banner, Button, EmptyState, IconTile, Input, cn } from './ui';

interface SessionListProps {
  sessions: Session[];
  activeSessionId: string | null;
  /** The list is being fetched. */
  isLoading?: boolean;
  /** The list could not be fetched — `sessions` is empty because of a failure. */
  error?: string | null;
  onRetry?: () => void;
  onSelectSession: (id: string) => void;
  onCreateSession: (title?: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
}

export default function SessionList({
  sessions,
  activeSessionId,
  isLoading = false,
  error = null,
  onRetry,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRenameSession
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const handleStartRename = (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveRename = (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (editTitle.trim()) {
      onRenameSession(id, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleCancelRename = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-surface">
      {/* Header */}
      <div className="shrink-0 border-b border-border-soft px-4 pb-4 pt-5">
        <h2 className="type-h5">My resumes</h2>
        <p className="type-meta mt-1">Stored locally · one session per resume</p>
        <Button
          className="mt-3 w-full"
          startIcon={<Plus size={16} />}
          onClick={() => onCreateSession()}
          title="Create a new resume"
        >
          New resume
        </Button>
      </div>

      {/* Session list items.
          The three zero-row states are distinct and must not be conflated: a
          list that is still loading, a list that failed to load, and a list that
          genuinely holds nothing. Rendering "No resume sessions found" for the
          first two tells the user something false about their data. */}
      <div className="scroll-quiet flex-1 space-y-2 overflow-y-auto p-3">
        {sessions.length > 0 ? (
          sessions.map((s, index) => {
            const isActive = s.id === activeSessionId;
            const isEditing = s.id === editingId;

            return (
              <div
                key={s.id || `session-${index}`}
                role="button"
                tabIndex={0}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => !isEditing && onSelectSession(s.id)}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectSession(s.id);
                  }
                }}
                className={cn(
                  'group flex cursor-pointer items-center justify-between gap-2 rounded-nav border p-3 transition-colors duration-200 ease-in-out',
                  isActive
                    ? 'border-primary-border bg-primary-soft'
                    : 'border-border-soft bg-surface hover:border-border hover:bg-page-app'
                )}
              >
                {/* Selection is a background tint plus a weight change on the
                    title — never a coloured side stripe (PRD §19.9.5). */}
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <IconTile size="sm" tone={isActive ? 'accent' : 'primary'} interactive>
                    <MessageSquare size={15} />
                  </IconTile>

                  {isEditing ? (
                    <div className="flex flex-1 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveRename(s.id, e);
                          if (e.key === 'Escape') handleCancelRename(e);
                        }}
                        className="h-7 px-2 py-0 text-xs"
                        autoFocus
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        iconOnly
                        aria-label="Save name"
                        title="Save"
                        className="text-success hover:text-success"
                        onClick={(e) => handleSaveRename(s.id, e)}
                      >
                        <Check size={14} />
                      </Button>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <p
                        className={cn(
                          'truncate font-body text-sm leading-tight',
                          isActive
                            ? 'font-medium text-text-heading'
                            : 'font-normal text-text-body group-hover:text-text-heading'
                        )}
                      >
                        {s.title}
                      </p>
                      <p className="type-meta mt-0.5">{new Date(s.updated_at).toLocaleDateString()}</p>
                    </div>
                  )}
                </div>

                {!isEditing && (
                  <div className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      size="xs"
                      variant="ghost"
                      iconOnly
                      aria-label={`Rename ${s.title}`}
                      title="Rename"
                      onClick={(e) => handleStartRename(s, e)}
                    >
                      <Edit3 size={12} />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      iconOnly
                      aria-label={`Delete ${s.title}`}
                      title="Delete"
                      className="hover:text-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm('Delete this resume and its chat history? This cannot be undone.')) {
                          onDeleteSession(s.id);
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </Button>
                    <ChevronRight size={14} className="text-text-disabled" />
                  </div>
                )}
              </div>
            );
          })
        ) : isLoading ? (
          <p className="mt-4 flex items-center justify-center gap-2 text-meta" role="status">
            <Loader2 size={14} className="animate-spin text-primary" aria-hidden="true" />
            Loading sessions…
          </p>
        ) : error ? (
          <Banner
            tone="danger"
            role="alert"
            action={
              onRetry ? (
                <Button size="xs" variant="ghost" onClick={onRetry}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {error}
          </Banner>
        ) : (
          <EmptyState
            className="mt-6 border-0 shadow-none"
            icon={<MessageSquare size={18} />}
            title="No resume sessions found"
            description="Start a session and the assistant will interview you."
            action={
              <Button size="xs" variant="outline" onClick={() => onCreateSession()}>
                Start one now
              </Button>
            }
          />
        )}
      </div>

      {/* Footer metadata info */}
      <div className="shrink-0 border-t border-border-soft bg-page-alt px-4 py-3">
        <p className="type-meta">Sessions are stored on this machine</p>
        <p className="type-meta mt-0.5">{new Date().toLocaleDateString()}</p>
      </div>
    </div>
  );
}
