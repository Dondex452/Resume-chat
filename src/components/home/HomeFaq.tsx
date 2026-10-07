/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HomeFaq + HomeFooter — the closing sections of the home page (PRD §5.12).
 * The FAQ is a stacked list of native <details> via the Accordion primitive.
 */

import React from 'react';
import { Sparkles } from 'lucide-react';
import { Accordion } from '../ui';

const FAQ_ITEMS = [
  {
    question: 'Which AI models can I use?',
    answer:
      'Any model you can reach. Three adapters ship today: an OpenAI-compatible adapter that covers OpenAI, OpenRouter, Groq, DeepSeek, Mistral and most others, a native Anthropic adapter, and a native Gemini adapter. The same OpenAI-compatible path also talks to models running on your machine (Ollama, LM Studio, vLLM or llama.cpp), which need no API key.'
  },
  {
    question: 'Does an unusual or local model still work?',
    answer:
      'The app probes your model before relying on it. A model with native tool calling gets the full workflow; one without is driven through a JSON-block fallback path; a model that can only chat is flagged in the interface so you are never left guessing why the resume stopped updating.'
  },
  {
    question: 'Where is my data stored?',
    answer:
      'On your machine, and nowhere else. Sessions, resumes, cover letters and your provider configuration are written to a local store. The only network request the app makes is the one to the AI provider you configured yourself.'
  },
  {
    question: 'Do I need to create an account?',
    answer:
      'No. There is no sign-up, no login, no email field and no password anywhere in the product. Opening the studio takes you straight to your sessions.'
  },
  {
    question: 'What can I export?',
    answer:
      'PDF, DOCX and Markdown for the resume, and a separate export for the cover letter. The PDF is rendered from the same preview you were looking at, so what you download matches what you saw.'
  },
  {
    question: 'Can it read my old resume?',
    answer:
      'Yes: upload a PDF, DOCX or TXT and the text is extracted and used to pre-fill your details. If a document will not parse, for example a scan with no text layer, the app tells you and you can paste the text by hand instead of sending garbage to the model.'
  }
];

export default function HomeFaq() {
  return (
    <section id="faq" className="scroll-mt-header border-t border-border-soft bg-page-alt py-10 md:py-14 lg:py-16">
      <div className="mx-auto max-w-content-md px-4">
        <h2 className="type-h2">Questions, answered plainly</h2>
        <p className="mt-3 font-body text-base leading-relaxed text-text-muted">
          If something here is aspirational rather than shipped, we say so. The roadmap above is the
          only forward-looking part of this page.
        </p>

        {/* Two columns from `lg`: six short disclosures in one tall column is
            wasted width on a wide screen. `items-start` keeps each row its own
            natural height when one is opened. */}
        <div className="mt-4 grid gap-2.5 lg:grid-cols-2 lg:items-start">
          {FAQ_ITEMS.map((item) => (
            <Accordion key={item.question} title={item.question}>
              {item.answer}
            </Accordion>
          ))}
        </div>
      </div>
    </section>
  );
}

export interface HomeFooterProps {
  onOpenStudio: () => void;
  onNavigate: (id: string) => void;
}

function AnchorLink({
  href,
  label,
  onNavigate
}: {
  href: string;
  label: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <a
      href={`#${href}`}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(href);
      }}
      className="font-body text-sm text-text-muted transition-colors duration-200 hover:text-text-heading"
    >
      {label}
    </a>
  );
}

export function HomeFooter({ onOpenStudio, onNavigate }: HomeFooterProps) {
  return (
    <footer className="relative z-10 border-t border-border-soft bg-surface">
      <div className="mx-auto max-w-content-xl px-4 py-10 md:py-12">
        <div className="grid gap-6 md:grid-cols-4 md:gap-8">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-button bg-primary text-white">
                <Sparkles size={16} aria-hidden="true" />
              </span>
              <span className="font-heading text-sm font-medium text-text-heading">
                AI Conversational CV Suite
              </span>
            </div>
            <p className="mt-4 max-w-[280px] font-body text-sm leading-relaxed text-text-muted">
              A local-first resume studio. Chat your way to a finished CV, then export it in the
              format the application asks for.
            </p>
          </div>

          <nav aria-label="Product" className="flex flex-col gap-3">
            <p className="font-heading text-meta font-medium uppercase tracking-eyebrow text-text-heading">
              Product
            </p>
            <button
              type="button"
              onClick={onOpenStudio}
              className="text-left font-body text-sm text-text-muted transition-colors duration-200 hover:text-text-heading"
            >
              Open studio
            </button>
            <AnchorLink href="templates" label="Templates" onNavigate={onNavigate} />
            <AnchorLink href="how" label="How it works" onNavigate={onNavigate} />
            <AnchorLink href="faq" label="FAQ" onNavigate={onNavigate} />
          </nav>

          <nav aria-label="Capabilities" className="flex flex-col gap-3">
            <p className="font-heading text-meta font-medium uppercase tracking-eyebrow text-text-heading">
              Capabilities
            </p>
            <AnchorLink href="product" label="Provider-agnostic AI" onNavigate={onNavigate} />
            <AnchorLink href="templates" label="Ten ready-made templates" onNavigate={onNavigate} />
            <AnchorLink href="how" label="Cover letters and exports" onNavigate={onNavigate} />
          </nav>

          <div className="flex flex-col gap-3">
            <p className="font-heading text-meta font-medium uppercase tracking-eyebrow text-text-heading">
              Local-first
            </p>
            <p className="font-body text-sm leading-relaxed text-text-muted">
              Your sessions and settings stay on this machine. There are no accounts, no cloud sync
              and no telemetry.
            </p>
            <p className="font-body text-sm leading-relaxed text-text-muted">
              You supply your own model and key. Nothing is sent anywhere you did not choose.
            </p>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-border-soft pt-5 sm:flex-row sm:items-center sm:justify-between md:mt-12 md:pt-6">
          <p className="font-body text-xs text-text-muted">
            AI Conversational CV Suite: runs locally, no account required.
          </p>
          <p className="font-body text-xs text-text-muted">
            Built with the design tokens in this repository.
          </p>
        </div>
      </div>
    </footer>
  );
}
