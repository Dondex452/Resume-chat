/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HomeHowItWorks — the dark-navy tabbed band (PRD §5.12, tonal punctuation per
 * §19.6). Pills switch a single panel; the panel carries a heading, a
 * paragraph and three IconTile bullets.
 */

import React, { useState } from 'react';
import {
  Download,
  Eye,
  KeyRound,
  Mail,
  MessageSquare,
  Plug,
  RefreshCw,
  Sparkles,
  Wand2,
  Zap
} from 'lucide-react';
import { IconTile, PillTab } from '../ui';

interface Step {
  id: string;
  tab: string;
  heading: string;
  body: string;
  points: Array<{ icon: React.ReactNode; text: string }>;
}

const STEPS: Step[] = [
  {
    id: 'connect',
    tab: 'Connect a model',
    heading: 'Point the studio at a model',
    body: 'Choose a provider, add a base URL and key if it needs one, and the app probes how capable that model is before it relies on it. A model running locally needs no key at all.',
    points: [
      { icon: <Plug size={15} />, text: 'OpenAI-compatible, Anthropic or Gemini adapter' },
      { icon: <KeyRound size={15} />, text: 'The key is stored locally and only ever shown masked' },
      { icon: <Zap size={15} />, text: 'A probe reports full, fallback or chat-only capability' }
    ]
  },
  {
    id: 'chat',
    tab: 'Chat with the assistant',
    heading: 'The assistant interviews you',
    body: 'It asks one or two questions at a time and adapts to where you are: project and education prompts when you are starting out, impact and metrics when you have years behind you.',
    points: [
      { icon: <MessageSquare size={15} />, text: 'Conversational interview, never a blank form' },
      { icon: <Sparkles size={15} />, text: 'Adapts its questions to your seniority' },
      { icon: <Eye size={15} />, text: 'Upload an old CV to pre-fill what it can' },
      { icon: <Mail size={15} />, text: 'Add a job description to tailor the wording' }
    ]
  },
  {
    id: 'build',
    tab: 'Watch the resume build',
    heading: 'Your resume updates as you talk',
    body: 'Every answer is merged into a structured resume document and the preview re-renders instantly. Nothing is retyped, and nothing is stored in the cloud.',
    points: [
      { icon: <RefreshCw size={15} />, text: 'Live A4 preview beside the conversation' },
      { icon: <Sparkles size={15} />, text: 'Switch templates without losing any content' },
      { icon: <MessageSquare size={15} />, text: 'Reopen the session later and keep editing by chat' }
    ]
  },
  {
    id: 'export',
    tab: 'Export',
    heading: 'Download the file you need',
    body: 'The preview and the PDF come from one render path, so they cannot drift apart. DOCX and Markdown are one click away, and a cover letter exports on its own.',
    points: [
      { icon: <Download size={15} />, text: 'PDF rendered from the same preview you see' },
      { icon: <Download size={15} />, text: 'Editable DOCX and plain Markdown' },
      { icon: <Wand2 size={15} />, text: 'Cover letter exported separately' }
    ]
  }
];

export default function HomeHowItWorks() {
  const [active, setActive] = useState(0);
  const step = STEPS[active];

  return (
    <section id="how" className="dark-band scroll-mt-header py-12 md:py-16 lg:py-16">
      <div className="mx-auto max-w-content-lg px-4">
        <h2 className="type-h2 on-dark-heading">From first message to finished CV</h2>
        <p className="on-dark-body mt-3 max-w-content-sm font-body text-base leading-relaxed">
          Four steps, no forms. The assistant does the structuring; you do the talking.
        </p>

        <div
          className="mt-4 flex flex-wrap gap-2"
          role="group"
          aria-label="How it works steps"
        >
          {STEPS.map((item, index) => (
            <PillTab
              key={item.id}
              tone="dark"
              active={index === active}
              onClick={() => setActive(index)}
              className="min-h-11"
            >
              {item.tab}
            </PillTab>
          ))}
        </div>

        <div className="mt-4 grid gap-6 rounded-card border border-on-dark-field bg-on-dark-surface p-5 md:grid-cols-2 md:gap-8 md:p-6">
          <div>
            <h3 className="type-h3 on-dark-heading">{step.heading}</h3>
            <p className="on-dark-body mt-3 font-body text-base leading-relaxed">{step.body}</p>
          </div>
          <ul className="space-y-2.5">
            {step.points.map((point) => (
              <li key={point.text} className="flex items-start gap-3">
                <IconTile size="sm" tone="dark">
                  {point.icon}
                </IconTile>
                <span className="on-dark-body font-body text-sm leading-relaxed">{point.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
