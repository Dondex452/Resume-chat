/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ResumeJSON } from './types';

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  fontClass: string;
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'minimal',
    name: 'Minimalist Modern',
    description: 'Clean sans-serif layout, generous spacing, and subtle lines. Excellent for general job applications.',
    fontClass: 'font-sans'
  },
  {
    id: 'executive',
    name: 'Executive Classic',
    description: 'Formal top-centered layout with elegant serif headings. Best for banking, legal, and managerial roles.',
    fontClass: 'font-serif'
  },
  {
    id: 'tech',
    name: 'Tech / Mono',
    description: 'Brutalist monospace structure with clean gray borders. Highly recommended for developer and technical roles.',
    fontClass: 'font-mono'
  },
  {
    id: 'creative',
    name: 'Creative Teal',
    description: 'Modern two-column asymmetric layout with a persistent teal left-hand sidebar for personal details.',
    fontClass: 'font-sans'
  },
  {
    id: 'ivory',
    name: 'Elegant Ivory',
    description: 'Soft cream background, serif display fonts, and warm golden headings. Perfect for editorial or design careers.',
    fontClass: 'font-serif'
  },
  {
    id: 'slate',
    name: 'Metro Slate',
    description: 'Features a dark grey header block, bold contact icons, and high information density. Great for engineering.',
    fontClass: 'font-sans'
  },
  {
    id: 'bold',
    name: 'Bold Border',
    description: 'Features a thick, stylish left border block with striking black-and-white headers.',
    fontClass: 'font-sans'
  },
  {
    id: 'sidebar',
    name: 'Sidebar Classic',
    description: 'Two-column standard with a persistent right-hand column for compact info like skills and awards.',
    fontClass: 'font-sans'
  },
  {
    id: 'compact',
    name: 'Compact Standard',
    description: 'High-density, neat tabular columns optimized for putting 2+ pages of content on a single printable sheet.',
    fontClass: 'font-sans'
  },
  {
    id: 'startup',
    name: 'Startup Warm',
    description: 'Modern rounded tag pills, friendly coral orange highlights, and clean display headers. Fits tech startups.',
    fontClass: 'font-sans'
  }
];

/**
 * Helper to check if resume data is completely empty.
 *
 * The M10 country fields count as content. A resume populated *solely* from an
 * uploaded CV for DE / JP / IN — personal details plus a signature line, no
 * work or education — used to read as empty, so the studio showed its
 * "blueprint pending" state over a resume that carried real data, and the
 * upload prompt's "populate it" block kept re-firing because the condition never
 * cleared (GOTCHA #58.2). `basics.photo` is included for the same reason.
 *
 * The predicate stays pure and takes no extra arguments; every field it already
 * checked keeps its existing semantics.
 */
export function isResumeEmpty(data: ResumeJSON): boolean {
  if (!data) return true;
  const basicsEmpty =
    !data.basics ||
    (!data.basics.fullName &&
      !data.basics.email &&
      !data.basics.phone &&
      !data.basics.location &&
      !data.basics.summary &&
      !data.basics.photo);
  const workEmpty = !data.work || data.work.length === 0;
  const eduEmpty = !data.education || data.education.length === 0;
  const skillsEmpty = !data.skills || data.skills.length === 0;
  const projEmpty = !data.projects || data.projects.length === 0;
  const certEmpty = !data.certifications || data.certifications.length === 0;
  const langEmpty = !data.languages || data.languages.length === 0;
  const personalEmpty =
    !data.personal ||
    (!data.personal.dob &&
      !data.personal.nationality &&
      !data.personal.maritalStatus &&
      !data.personal.visaStatus &&
      !data.personal.fatherName &&
      !data.personal.gender);
  const signatureEmpty =
    !data.signature ||
    (!data.signature.place && !data.signature.date && data.signature.signed !== true);
  return (
    basicsEmpty &&
    workEmpty &&
    eduEmpty &&
    skillsEmpty &&
    projEmpty &&
    certEmpty &&
    langEmpty &&
    personalEmpty &&
    signatureEmpty
  );
}
