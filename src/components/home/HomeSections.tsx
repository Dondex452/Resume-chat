/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HomeSections — the facts band and the feature rows for the home page.
 *
 * Composition note: this used to be a four-up band of oversized numerals over
 * small labels, followed by five near-identical icon + heading + paragraph
 * cards. Both are banned patterns (PRD §19.9.2, §19.9.3). The facts are now a
 * quiet definition-row list, and the features are one larger lead treatment
 * plus a compact list.
 *
 * Provider coverage used to be a wrapped cloud of nine bordered chips. That is
 * the "badge and logo cloud" tell (PRD §19.9.13), so it is now a definition
 * list grouped by adapter: the structure carries the meaning, not the boxes.
 *
 * The honesty rule applies: every shipped claim describes something that exists
 * today. Country formats, chat-generated templates and the visual editor are
 * listed separately under a heading that states they are not built yet (M10–M12).
 */

import React from 'react';
import { CheckCircle2, Download, FileText, Lock, Mail, Plug } from 'lucide-react';
import { CapabilityPill, StatBox } from '../ui';

const FACTS = [
  { label: 'AI provider adapters', value: '3', hint: 'OpenAI-compatible · Anthropic · Gemini' },
  { label: 'Ready-made templates', value: '10', hint: 'Switch any time, lose nothing' },
  { label: 'Data stored off your machine', value: 'None', hint: 'Sessions live in a local file' },
  { label: 'Accounts required', value: 'Zero', hint: 'No sign-up, no tracking' }
];

/* -------------------------------------------------------------------------- */

/**
 * Real adapter coverage, grouped the way the server groups it (`server/ai/adapters/`).
 * Kept as plain data and rendered as type — never as a chip cloud (PRD §19.9.13).
 */
const ADAPTER_COVERAGE = [
  {
    adapter: 'openai-compatible',
    providers:
      'OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Ollama, LM Studio, vLLM, llama.cpp, LocalAI, or any custom base URL'
  },
  { adapter: 'anthropic', providers: 'Claude' },
  { adapter: 'gemini', providers: 'Gemini' }
];

function ProviderVisual() {
  return (
    /* One column below `md` means this panel would only stack under the copy,
       so it is omitted there rather than doubling the block (PRD §19.9.11). */
    <div className="hidden bg-page-app p-4 md:block md:p-5">
      {/* Provider coverage as a definition list: the adapter is the term, the
          providers are comma-separated plain text, and the grouping carries the
          meaning. This replaces a nine-chip bordered cloud, which is a banned
          pattern (PRD §19.9.13). No boxes, no per-name marks. */}
      <dl className="divide-y divide-border-soft">
        {ADAPTER_COVERAGE.map((row) => (
          <div key={row.adapter} className="grid gap-0.5 py-2.5 first:pt-0 last:pb-0 lg:grid-cols-[9.5rem_1fr] lg:gap-3">
            <dt className="font-body text-meta font-medium text-text-heading">{row.adapter}</dt>
            <dd className="min-w-0 font-body text-sm leading-snug text-text-muted">{row.providers}</dd>
          </div>
        ))}
      </dl>
      {/* Capability rows: dot + text, separated by a hairline rule — never a
          tinted fill (PRD §19.9.9). */}
      <div className="mt-3 divide-y divide-border">
        <CapabilityPill tier="full" />
        <CapabilityPill tier="fallback" />
        <CapabilityPill tier="chat-only" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface Feature {
  id?: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  /** Only the lead feature carries a bullet list; the compact rows do not. */
  bullets?: string[];
}

const LEAD_FEATURE: Feature = {
  id: 'product',
  icon: <Plug size={18} />,
  title: 'Bring any model you already use',
  body: 'Three adapters (OpenAI-compatible, Anthropic and Gemini) cover hosted APIs and local runtimes alike. A model running on your machine needs no API key at all.',
  bullets: [
    'One neutral interface for every provider',
    'Base URL, model and key configured at runtime',
    'Local endpoints such as Ollama and LM Studio work keyless'
  ]
};

const FEATURES: Feature[] = [
  {
    icon: <FileText size={18} />,
    title: 'Ten ready-made templates',
    body: 'From a strict minimalist layout to a two-column sidebar design. Switching a template re-renders instantly and never reorders or drops your content.'
  },
  {
    icon: <Mail size={18} />,
    title: 'A cover letter, drafted and revised by chat',
    body: 'The assistant writes a tailored letter from your resume and, if you provide it, the job posting. Ask for it warmer or shorter and it rewrites, the same way it edits your CV.'
  },
  {
    icon: <Download size={18} />,
    title: 'Export to PDF, DOCX and Markdown',
    body: 'One render path feeds the preview and the exports, so the PDF you download is the document you were looking at. DOCX stays editable in Word.'
  },
  {
    icon: <FileText size={18} />,
    title: 'Reads an old resume: text only, by design',
    body: 'Upload a PDF, DOCX or TXT and the app extracts plain text, then pre-fills what it can and interviews you about the gaps. No vision model is required, which keeps cheap and local models viable.'
  },
  {
    icon: <Lock size={18} />,
    title: 'Local-first, with no account',
    body: 'Sessions, resumes, cover letters and your provider settings stay on your machine. The only network call is to the AI provider you chose.'
  }
];

const ROADMAP = [
  {
    title: 'Country formats',
    body: 'Ten presets (US, Germany, Japan and more) layering page size, section order and localised headings over any template.'
  },
  {
    title: 'Templates from chat',
    body: 'Describe a design and have it generated as a validated template document you can reuse in any session.'
  },
  {
    title: 'Visual template editor',
    body: 'Reorder sections, move them between columns, and tune fonts and colours with a live preview.'
  }
];

export function FactsBand() {
  return (
    <section className="mx-auto max-w-content-md px-4 py-8 md:py-10">
      <div className="divide-y divide-border-soft rounded-card border border-border-soft bg-surface px-4 md:px-5">
        {FACTS.map((fact) => (
          <StatBox key={fact.label} label={fact.label} value={fact.value} hint={fact.hint} />
        ))}
      </div>
    </section>
  );
}

export function FeatureRows() {
  return (
    <section className="pb-12 md:pb-16 lg:pb-16">
      <div className="mx-auto max-w-content-lg space-y-10 px-4 md:space-y-14 lg:space-y-8">
        {/* Lead feature — the one full treatment with a visual */}
        <div id={LEAD_FEATURE.id} className="grid scroll-mt-header items-center gap-5 md:grid-cols-2 md:gap-10 lg:gap-14">
          <div>
            <h3 className="type-h3">{LEAD_FEATURE.title}</h3>
            <p className="mt-3 font-body text-base leading-relaxed text-text-muted">{LEAD_FEATURE.body}</p>
            <ul className="mt-5 space-y-2">
              {LEAD_FEATURE.bullets?.map((bullet) => (
                <li
                  key={bullet}
                  className="flex items-start gap-2.5 font-body text-sm leading-relaxed text-text-body"
                >
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                  {bullet}
                </li>
              ))}
            </ul>
          </div>
          <ProviderVisual />
        </div>

        {/* The rest — a compact list, not five more identical cards */}
        <ul className="divide-y divide-border-soft border-t border-border-soft">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="flex gap-4 py-4">
              <span className="mt-0.5 shrink-0 text-primary" aria-hidden="true">
                {feature.icon}
              </span>
              <div className="min-w-0">
                <h3 className="font-body text-base font-medium text-text-heading">{feature.title}</h3>
                <p className="mt-1.5 font-body text-sm leading-relaxed text-text-muted">{feature.body}</p>
              </div>
            </li>
          ))}
        </ul>

        {/* Honesty rule (PRD §5.12): not-built capabilities are labelled, never
            presented as shipped. */}
        <div className="rounded-card border border-dashed border-border-cool bg-page-alt p-5">
          <h3 className="type-h6">Designed, not built yet</h3>
          <p className="mt-2 max-w-content-sm font-body text-sm leading-relaxed text-text-muted">
            These capabilities are specified and scheduled, but they are not in the app today. We
            would rather say so than advertise them.
          </p>
          <div className="mt-4 grid gap-4 md:mt-5 md:grid-cols-3 md:gap-5">
            {ROADMAP.map((item) => (
              <div key={item.title}>
                <p className="font-body text-sm font-medium text-text-heading">{item.title}</p>
                <p className="mt-1 font-body text-sm leading-relaxed text-text-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
