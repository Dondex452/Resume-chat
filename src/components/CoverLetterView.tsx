/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Session, CoverLetterJSON } from '../types';
import { Download, Sparkles, FileCode, Printer, Loader2 } from 'lucide-react';
import jsPDF from 'jspdf';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { Banner, Button, EmptyState } from './ui';

interface CoverLetterViewProps {
  session: Session | null;
  onSendMessage: (content: string) => void;
  /** A chat turn is in flight — generation is a chat turn, so this is progress. */
  isSending?: boolean;
}

export default function CoverLetterView({ session, onSendMessage, isSending = false }: CoverLetterViewProps) {
  // Export failures surface as an inline Banner, never a blocking alert
  // (PRD §19.10). The hook is declared before the early return so it is
  // unconditional.
  const [exportError, setExportError] = useState<string | null>(null);

  if (!session) return null;

  let clData: CoverLetterJSON = {};
  try {
    clData = JSON.parse(session.cover_letter_json || '{}');
  } catch (e) {
    console.error('Failed to parse cover letter json', e);
  }

  const hasLetter = clData.intro || clData.body || clData.closing || session.cover_letter_text;

  const handleRequestLetter = () => {
    onSendMessage("Can you draft a personalized, impact-focused cover letter for me based on my active CV? If I pasted a job description, please align it with those requirements.");
  };

  const getFullText = () => {
    if (session.cover_letter_text) return session.cover_letter_text;

    const parts = [
      clData.recipient?.name,
      clData.recipient?.company,
      clData.recipient?.role,
      new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      clData.intro,
      clData.body,
      clData.closing,
      'Sincerely,\n\n[Your Name]'
    ].filter(Boolean);
    return parts.join('\n\n');
  };

  // Export 1: Plain Markdown
  const handleExportMarkdown = () => {
    const text = getFullText();
    const markdownContent = `# Cover Letter\n\n${text}`;

    const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${session.title.replace(/\s+/g, '_')}_Cover_Letter.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export 2: Microsoft Word DOCX
  const handleExportDOCX = async () => {
    setExportError(null);
    try {
      const recipientName = clData.recipient?.name || '';
      const company = clData.recipient?.company || '';
      const role = clData.recipient?.role || '';
      const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

      const doc = new Document({
        sections: [
          {
            properties: {},
            children: [
              // Header Details
              new Paragraph({
                children: [new TextRun({ text: recipientName, bold: true, size: 24 })]
              }),
              new Paragraph({
                children: [new TextRun({ text: company, size: 22 })]
              }),
              new Paragraph({
                children: [new TextRun({ text: role, italics: true, size: 22 })],
                spacing: { after: 200 }
              }),
              // Date
              new Paragraph({
                children: [new TextRun({ text: dateStr, size: 22 })],
                spacing: { after: 300 }
              }),
              // Intro
              new Paragraph({
                children: [new TextRun({ text: clData.intro || '', size: 22 })],
                spacing: { after: 200 }
              }),
              // Body
              new Paragraph({
                children: [new TextRun({ text: clData.body || '', size: 22 })],
                spacing: { after: 200 }
              }),
              // Closing
              new Paragraph({
                children: [new TextRun({ text: clData.closing || '', size: 22 })],
                spacing: { after: 400 }
              }),
              // Sign-off
              new Paragraph({
                children: [new TextRun({ text: 'Sincerely,', size: 22 })]
              }),
              new Paragraph({
                children: [new TextRun({ text: '[Your Name]', bold: true, size: 22 })],
                spacing: { before: 200 }
              })
            ]
          }
        ]
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${session.title.replace(/\s+/g, '_')}_Cover_Letter.docx`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Failed to export DOCX:', err);
      setExportError('Could not generate the Word document. Check the browser console for details and try again.');
    }
  };

  // Export 3: PDF
  const handleExportPDF = () => {
    setExportError(null);
    try {
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      doc.setFont('Times', 'normal');
      doc.setFontSize(11);

      let yPos = 25;
      const margin = 20;
      const wrapWidth = 170; // A4 is 210mm wide, margin 20 on both sides leaves 170mm

      // Add Title
      doc.setFont('Times', 'bold');
      doc.setFontSize(14);
      doc.text('COVER LETTER', margin, yPos);
      yPos += 10;

      doc.setFont('Times', 'normal');
      doc.setFontSize(11);

      // Recipient Address
      if (clData.recipient?.name) {
        doc.text(clData.recipient.name, margin, yPos);
        yPos += 5;
      }
      if (clData.recipient?.company) {
        doc.text(clData.recipient.company, margin, yPos);
        yPos += 5;
      }
      if (clData.recipient?.role) {
        doc.setFont('Times', 'italic');
        doc.text(clData.recipient.role, margin, yPos);
        yPos += 5;
        doc.setFont('Times', 'normal');
      }

      const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.text(dateStr, margin, yPos);
      yPos += 12;

      // Intro
      if (clData.intro) {
        const introLines = doc.splitTextToSize(clData.intro, wrapWidth);
        doc.text(introLines, margin, yPos);
        yPos += introLines.length * 5 + 6;
      }

      // Body
      if (clData.body) {
        const bodyLines = doc.splitTextToSize(clData.body, wrapWidth);
        doc.text(bodyLines, margin, yPos);
        yPos += bodyLines.length * 5 + 6;
      }

      // Closing
      if (clData.closing) {
        const closingLines = doc.splitTextToSize(clData.closing, wrapWidth);
        doc.text(closingLines, margin, yPos);
        yPos += closingLines.length * 5 + 12;
      }

      // Sign-off
      doc.text('Sincerely,', margin, yPos);
      yPos += 12;
      doc.setFont('Times', 'bold');
      doc.text('[Your Name]', margin, yPos);

      doc.save(`${session.title.replace(/\s+/g, '_')}_Cover_Letter.pdf`);
    } catch (err) {
      console.error('Failed to export PDF:', err);
      setExportError('Could not generate the cover-letter PDF. Check the browser console for details and try again.');
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-page-app text-text-body">
      {/* Title block with export menu */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-soft bg-surface px-5 py-4">
        <div className="min-w-0">
          <h2 className="type-h3 truncate">Cover letter</h2>
          <p className="type-meta mt-1">Its own simple, printable layout, separate from the resume templates.</p>
        </div>

        {hasLetter && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" startIcon={<Download size={13} />} onClick={handleExportPDF}>
              Export PDF
            </Button>
            <Button size="xs" variant="outline" startIcon={<Printer size={13} />} onClick={handleExportDOCX}>
              Word DOCX
            </Button>
            <Button size="xs" variant="outline" startIcon={<FileCode size={13} />} onClick={handleExportMarkdown}>
              Markdown
            </Button>
          </div>
        )}
      </div>

      {exportError && (
        <div className="shrink-0 px-5 pt-3">
          <Banner
            tone="danger"
            role="alert"
            onDismiss={() => setExportError(null)}
            dismissLabel="Dismiss export error"
          >
            {exportError}
          </Banner>
        </div>
      )}

      {/* Main Container */}
      <div className="scroll-quiet flex flex-1 justify-center overflow-y-auto p-6">
        {!hasLetter ? (
          <div className="my-auto">
            <EmptyState
              icon={<Sparkles size={20} aria-hidden="true" />}
              title="No cover letter drafted yet"
              description="Based on your interview, the assistant can write a targeted cover letter matching your record and the job specifics."
              action={
                <Button loading={isSending} disabled={isSending} onClick={handleRequestLetter}>
                  Generate tailored cover letter
                </Button>
              }
            />
            {/* Generation is a chat turn; without this the pane looked frozen
                for the whole round trip (PRD §6). */}
            {isSending && (
              <p
                className="mt-3 flex items-center justify-center gap-2 text-sm text-text-muted"
                role="status"
              >
                <Loader2 size={14} className="animate-spin text-primary" aria-hidden="true" />
                Writing your cover letter — this can take a moment.
              </p>
            )}
          </div>
        ) : (
          <div className="paper-sheet h-fit w-full max-w-content-sm self-start rounded-card p-10 font-serif text-sm leading-relaxed text-gray-800 md:p-12">
            {/* Sender / Date */}
            <div className="mb-8 text-right text-xs text-gray-400 font-sans">
              {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </div>

            {/* Recipient block */}
            {(clData.recipient?.name || clData.recipient?.company || clData.recipient?.role) && (
              <div className="mb-8 space-y-0.5 font-sans text-xs text-gray-500">
                {clData.recipient.name && <div className="text-sm font-bold text-gray-800">{clData.recipient.name}</div>}
                {clData.recipient.role && <div className="font-medium italic text-blue-600">{clData.recipient.role}</div>}
                {clData.recipient.company && <div className="font-semibold">{clData.recipient.company}</div>}
              </div>
            )}

            {/* Letter subject / greetings */}
            <div className="mb-6 font-bold text-gray-900">
              RE: Application for {clData.recipient?.role || 'Target Role'}
            </div>

            <div className="mb-4">
              Dear {clData.recipient?.name ? clData.recipient.name.split(' ').pop() : 'Hiring Manager'},
            </div>

            {/* Paragraph blocks */}
            <div className="space-y-4 text-justify">
              {clData.intro && <p>{clData.intro}</p>}
              {clData.body && <p>{clData.body}</p>}
              {clData.closing && <p>{clData.closing}</p>}
            </div>

            {/* Sign-off */}
            <div className="mt-8">
              <p>Sincerely,</p>
              <p className="mt-6 font-bold text-gray-900">[Your Name]</p>
              <p className="mt-1 text-xs text-gray-400 font-sans">AI structured profile attachment</p>
            </div>
          </div>
        )}
      </div>

      {/* Hint bottom bar */}
      {hasLetter && (
        <div className="shrink-0 border-t border-border-soft bg-surface px-5 py-3">
          <p className="type-meta text-center">
            Tip: refine this cover letter in the chat, for example “make the tone warmer” or “shorten it”.
          </p>
        </div>
      )}
    </div>
  );
}
