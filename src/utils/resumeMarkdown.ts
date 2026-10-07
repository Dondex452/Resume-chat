/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Markdown export (PRD §11).
 *
 * Same defect class as the DOCX export it sits beside: the previous
 * implementation hardcoded four sections and read only `basics`, `work`,
 * `education` and `skills`, so `projects`, `certifications`, `languages`,
 * `personal` and `signature` were **silently dropped**, and the country preset's
 * localised section labels and the template's section order were ignored.
 *
 * It is now serialised from the **same resolved schema** the preview and the PDF
 * use, so a custom template and a country format both come out right — and a
 * template created from scratch needs no code here.
 */

import type { ResumeJSON } from '../types';
import type { SectionSpec, TemplateSchema } from '../templates/schema';

/**
 * Some presets leave a section label empty (the DE `signature` block has no
 * localised heading). Falling straight back to the raw key would print
 * `## signature`, so a small English default covers the gap — the same
 * "absent data must not render as an empty heading" rule the renderer follows.
 */
const DEFAULT_LABELS: Record<string, string> = {
  signature: 'Signature',
  personal: 'Personal Details',
};

function labelOf(section: SectionSpec): string {
  return section.label || DEFAULT_LABELS[section.key] || section.key;
}

function line(parts: (string | undefined | null)[], separator = ' | '): string {
  return parts.filter(Boolean).join(separator);
}

function renderSection(section: SectionSpec, data: ResumeJSON): string[] {
  const out: string[] = [];
  const label = labelOf(section);
  const heading = `## ${label}\n`;

  switch (section.key) {
    case 'basics': {
      const basics = data.basics || {};
      if (basics.fullName) out.push(`# ${basics.fullName}\n`);
      const contact = line([basics.email, basics.phone, basics.location]);
      if (contact) out.push(`${contact}\n`);
      if (basics.links?.length) {
        out.push(line(basics.links.map((l) => [l.label, l.url].filter(Boolean).join(': '))) + '\n');
      }
      break;
    }

    case 'summary': {
      const summary = data.basics?.summary;
      if (!summary) break;
      out.push(heading, `${summary}\n`);
      break;
    }

    case 'personal': {
      const personal = data.personal;
      if (!personal) break;
      const rows: [string, string | undefined][] = [
        ['Date of birth', personal.dob],
        ['Nationality', personal.nationality],
        ['Marital status', personal.maritalStatus],
        ['Visa status', personal.visaStatus],
        ["Father's name", personal.fatherName],
        ['Gender', personal.gender],
      ];
      const present = rows.filter(([, value]) => Boolean(value));
      if (!present.length) break;
      out.push(heading);
      for (const [name, value] of present) out.push(`- **${name}:** ${value}`);
      out.push('');
      break;
    }

    case 'work': {
      if (!data.work?.length) break;
      out.push(heading);
      for (const job of data.work) {
        out.push(`### ${line([job.role, job.company], ' — ')}`);
        const dates = line([job.start, job.end || 'Present'], ' - ');
        if (dates) out.push(`*${dates}*`);
        out.push('');
        for (const highlight of job.highlights || []) out.push(`- ${highlight}`);
        out.push('');
      }
      break;
    }

    case 'education': {
      if (!data.education?.length) break;
      out.push(heading);
      for (const entry of data.education) {
        out.push(`### ${line([line([entry.degree, entry.field], ', '), entry.school], ' — ')}`);
        const dates = line([entry.start, entry.end], ' - ');
        if (dates) out.push(`*${dates}*`);
        out.push('');
      }
      break;
    }

    case 'skills': {
      if (!data.skills?.length) break;
      out.push(heading);
      for (const group of data.skills) {
        const items = (group.items || []).join(', ');
        if (items) out.push(`**${group.category || 'Skills'}:** ${items}`);
      }
      out.push('');
      break;
    }

    case 'projects': {
      if (!data.projects?.length) break;
      out.push(heading);
      for (const project of data.projects) {
        out.push(`### ${project.name || ''}`);
        if (project.link) out.push(`${project.link}`);
        if (project.description) out.push(`${project.description}`);
        out.push('');
      }
      break;
    }

    case 'certifications': {
      if (!data.certifications?.length) break;
      out.push(heading);
      for (const certification of data.certifications) {
        out.push(`- ${line([certification.name, certification.issuer], ' — ')}${certification.date ? ` (${certification.date})` : ''}`);
      }
      out.push('');
      break;
    }

    case 'languages': {
      if (!data.languages?.length) break;
      out.push(heading);
      for (const language of data.languages) {
        out.push(`- ${line([language.name, language.proficiency], ' — ')}`);
      }
      out.push('');
      break;
    }

    case 'signature': {
      const signature = data.signature;
      if (!signature) break;
      const place = line([signature.place, signature.date], ', ');
      if (!place && !signature.signed) break;
      out.push(heading);
      out.push('_______________________');
      if (place) out.push(place);
      out.push('');
      break;
    }

    default:
      break;
  }

  return out;
}

/**
 * Serialise the resume as Markdown, driven entirely by the resolved schema — the
 * same enabled flags, order and localised labels the preview and the PDF use.
 */
export function buildResumeMarkdown(schema: TemplateSchema, data: ResumeJSON): string {
  const sections = (schema.sections || [])
    .filter((section) => section.enabled)
    .slice()
    .sort((a, b) => a.order - b.order);

  const blocks: string[] = [];
  for (const section of sections) blocks.push(...renderSection(section, data));

  // Collapse runs of blank lines so the output reads cleanly regardless of which
  // sections were enabled.
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
