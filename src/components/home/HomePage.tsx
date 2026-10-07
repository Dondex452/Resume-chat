/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HomePage — the landing page (PRD §5.12).
 *
 * Built entirely from the M8.5 design-system primitives and tokens (PRD §19).
 * It deliberately carries no data-fetching and never mounts `PreviewPaper` or
 * `ResumeRenderer`: no extra `[data-resume-paper]` element can exist while the
 * home page is showing, so the studio's PDF export can never capture it
 * (GOTCHA #24).
 *
 * No auth, no sign-up, no form posts. Every CTA is a hash navigation to
 * `#/studio` (PRD §6).
 */

import React, { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { BlobBackdrop, Button, Eyebrow, IconTile } from '../ui';
import TemplateShowcase from './TemplateShowcase';
import { FactsBand, FeatureRows } from './HomeSections';
import HomeHowItWorks from './HomeHowItWorks';
import HomeFaq, { HomeFooter } from './HomeFaq';

const NAV_LINKS = [
  { label: 'Product', id: 'product' },
  { label: 'Templates', id: 'templates' },
  { label: 'How it works', id: 'how' },
  { label: 'FAQ', id: 'faq' }
];

export interface HomePageProps {
  onOpenStudio: () => void;
}

function HomeNav({ onNavigate, onOpenStudio }: { onNavigate: (id: string) => void; onOpenStudio: () => void }) {
  return (
    <header className="fixed inset-x-0 top-0 z-30 h-header border-b border-border-soft bg-surface shadow-app-header">
      <span className="gradient-ramp absolute inset-x-0 top-0 h-0.5" aria-hidden="true" />
      <div className="mx-auto flex h-full max-w-content-xl items-center gap-3 px-4">
        <a
          href="#/"
          className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-nav px-1 py-1 transition-colors duration-200 hover:bg-tint"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-button bg-primary text-white">
            <Sparkles size={16} aria-hidden="true" />
          </span>
          <span className="truncate font-heading text-sm font-medium text-text-heading">
            AI Conversational CV Suite
          </span>
        </a>

        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Page sections">
          {NAV_LINKS.map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(link.id);
              }}
              className="rounded-nav px-3 py-2 font-heading text-sm font-medium text-text-muted transition-colors duration-200 hover:bg-tint hover:text-text-heading"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button size="md" className="min-h-11" onClick={onOpenStudio}>
            Open studio
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * Decorative hero composition — abstract UI, built from token classes only.
 *
 * Kept as a light surface (option (a) of the drench brief): an opaque light card
 * pops against the navy and represents the product's actual UI honestly, where a
 * second dark panel on a dark surface would nest dark-on-dark and read as mud.
 * No translucency, no shadow, no pastel fill.
 */
function HeroVisual() {
  return (
    /* Hidden below `lg`: at those widths the hero is a single column, so the
       mock only ever stacked a large decorative panel under the copy and nearly
       doubled the hero (PRD §19.9.11). From `lg` it sits beside the copy. */
    <div className="relative mx-auto hidden w-full max-w-[520px] lg:block" aria-hidden="true">
      <div className="rounded-card border border-border-soft bg-page p-4">
        <div className="flex items-center gap-2">
          <IconTile size="sm" tone="primary">
            <Sparkles size={15} />
          </IconTile>
          <span className="font-body text-meta font-medium uppercase tracking-eyebrow text-text-muted">
            AI career assistant
          </span>
        </div>
        <div className="mt-4 space-y-2.5">
          <div className="ml-auto w-3/4 rounded-button bg-primary px-3 py-2 font-body text-xs leading-relaxed text-white">
            I led the checkout team at Northwind for three years.
          </div>
          <div className="w-5/6 rounded-button border border-border-soft bg-surface px-3 py-2 font-body text-xs leading-relaxed text-text-muted">
            Saved to your experience section. What did the team ship?
          </div>
          <div className="flex items-center gap-2 rounded-button border border-border-soft bg-page-alt px-3 py-2">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-button bg-success" />
            <span className="font-body text-xs text-text-muted">Updating your resume…</span>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-8 -right-2 hidden w-44 rotate-2 rounded-card border border-border-soft bg-paper p-3 shadow-raised sm:block">
        <div className="h-2 w-2/3 rounded-button bg-text-heading" />
        <div className="mt-1.5 h-1.5 w-1/2 rounded-button bg-border" />
        <div className="mt-3 space-y-1.5">
          <div className="h-1.5 w-full rounded-button bg-border" />
          <div className="h-1.5 w-11/12 rounded-button bg-border" />
          <div className="h-1.5 w-4/5 rounded-button bg-border" />
          <div className="h-1.5 w-full rounded-button bg-border" />
        </div>
      </div>
    </div>
  );
}

function Hero({ onOpenStudio, onBrowse }: { onOpenStudio: () => void; onBrowse: () => void }) {
  return (
    /* The drenched surface (PRD §19.3 "The drench"). The `.dark-band` class is
       the same token-driven gradient the mid-page navy band uses, so the two
       bookends are the same shade by construction — never a hand-mixed
       approximation. Ambient blob art is deliberately absent here. */
    <section className="dark-band relative overflow-hidden">
      <div className="mx-auto grid max-w-content-xl items-center gap-10 px-4 pb-10 pt-24 md:gap-12 md:pb-12 lg:min-h-[560px] lg:grid-cols-2 lg:gap-16 lg:pb-10">
        <div>
          {/* The one deliberate kicker on the page — not a label repeated above
              every section heading (a banned pattern, PRD §19.9). */}
          <Eyebrow onDark>Local-first resume studio</Eyebrow>
          <h1 className="type-display on-dark-heading mt-4 max-w-[640px]">
            Build a resume by chatting, not by filling forms
          </h1>
          <p className="on-dark-body mt-5 max-w-[560px] font-body text-base leading-relaxed">
            An AI interviews you about your experience, writes it into a structured resume as you
            talk, and renders it through ten ready-made designs. Bring any model you like: a hosted
            API, or one running on your own machine.
          </p>
          {/* On the ramp a `--primary` button disappears into the blue end, so
              the pair is white solid + white outline (PRD §19.3). */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button size="lg" variant="white" onClick={onOpenStudio}>
              Open studio
            </Button>
            <Button size="lg" variant="white-outline" onClick={onBrowse}>
              Browse templates
            </Button>
          </div>
          <p className="on-dark-body mt-5 font-body text-xs leading-relaxed">
            No account. No sign-up. Your sessions stay on this machine.
          </p>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

export default function HomePage({ onOpenStudio }: HomePageProps) {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="relative min-h-screen overflow-x-clip bg-page-app font-body text-text-body">
      <HomeNav onNavigate={scrollTo} onOpenStudio={onOpenStudio} />
      <main className="relative z-10">
        <Hero onOpenStudio={onOpenStudio} onBrowse={() => scrollTo('templates')} />
        {/* The ambient art is confined to the light run below the hero: a colour
            wash over the drenched gradient reads as mud (PRD §19.3). The layer
            is section-scoped so no blob's box reaches the hero. */}
        <div className="relative">
          <BlobBackdrop placement="section" />
          <div className="relative z-10">
            <TemplateShowcase onOpenStudio={onOpenStudio} />
            <FactsBand />
            <FeatureRows />
            <HomeHowItWorks />
            <HomeFaq />
          </div>
        </div>
      </main>
      <HomeFooter onOpenStudio={onOpenStudio} onNavigate={scrollTo} />
    </div>
  );
}
