/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * M14 — the chat system instruction, extracted out of the `server.ts` route
 * handler into a **pure, exported** function so it can be unit-tested without
 * booting the HTTP server. This is the same reason `server/store.ts` and
 * `server/templateRoutes.ts` were extracted (see memory/ARCHITECTURE.md).
 *
 * What the PRD requires of this prompt:
 *   - §9.1 — the system prompt loads the interview guidelines, the current
 *     `resume_json`, and any **country preset context**.
 *   - §8   — the v2 fields (`personal`, `signature`, `basics.photo`) exist and
 *     absent fields must stay absent (never rendered as empty headings).
 *   - §9.7 — with an uploaded `source_text` and an empty resume, the first reply
 *     must acknowledge the CV, populate the model from it, and only then ask
 *     about the genuine gaps.
 *
 * Nothing here has any I/O: the same session row always yields the same string.
 */

import { getCountryPreset, type CountryPersonalField, type CountryPreset } from '../src/templates/countries';
import { isResumeEmpty } from '../src/templates';
import type { ResumeJSON } from '../src/types';

/**
 * The slice of a `sessions` row the instruction depends on. Deliberately loose
 * (`?` everywhere) so a raw SQLite row, a test fixture or a partially-hydrated
 * object all satisfy it.
 */
export interface PromptSession {
  resume_json?: string | null;
  cover_letter_json?: string | null;
  source_text?: string | null;
  job_text?: string | null;
  country_code?: string | null;
}

/** Human label + destination for each country personal field, incl. photo/signature. */
const PERSONAL_FIELD_LABELS: Record<CountryPersonalField, string> = {
  dob: 'date of birth (`personal.dob`)',
  nationality: 'nationality (`personal.nationality`)',
  maritalStatus: 'marital status (`personal.maritalStatus`)',
  visaStatus: 'visa status (`personal.visaStatus`)',
  fatherName: "father's name (`personal.fatherName`)",
  gender: 'gender (`personal.gender`)',
  photo: 'photo (`basics.photo`)',
  signature: 'signature line (`signature.place` / `signature.date`)',
};

const INTERVIEW_GUIDELINES = `You are an expert conversational CV, resume, and cover letter builder. Your job is to interview the user step-by-step to build an outstanding, impact-driven resume and optional cover letter.

**Your Guidelines**:
1. Ask 1 or 2 targeted questions at a time. Do not ask too many things at once.
2. Keep your replies professional, concise, encouraging, and clear.
3. Be adaptive. If the user is a student, focus on projects, clubs, and education. If they are experienced, focus on achievements, work experience, impact, metrics (e.g. sales, efficiencies), and technical skills.
4. Whenever the user provides new or modified details (like contact details, education, a job role, projects, skills), call the 'update_resume' tool immediately to update the structured model. The app's user interface renders this resume in real-time, so they will see it update instantly!
5. If a 'source_text' (uploaded old resume) is provided, extract everything you can from it and pre-populate the structured resume before asking follow-up questions. You are the one who populates the resume — the app does not do it for you.
6. If a 'job_text' (target job description) is provided, tailor your feedback, resume bullet points, and skills to align with the requirements of that role.
7. Once the resume is reasonably complete, tell the user they can generate a tailored cover letter based on their resume and the job posting. If they request this or ask to modify the cover letter, use the 'update_cover_letter' tool immediately.
8. If the user asks for a brand-new resume design or layout (for example "make me a two-column navy template"), call the 'create_template' tool with a COMPLETE TemplateSchema document: id, name, version, origin, page, tokens, layout, and a non-empty sections array. Every enabled section must carry its own 'props' bag (basics needs nameClass/headline/contacts; work needs layout/listClass/rowClass; and so on). The app validates the document before saving it, so an incomplete document is rejected — send the whole document, not a fragment.`;

/**
 * The v2 structured fields. Always present in the prompt: the `update_resume`
 * tool schema already declares them, but the model was never *told* they exist,
 * so an imported old CV could never populate them (M14, Defect 2b).
 */
const FIELD_DOCUMENTATION = `**Structured fields you can populate (v2)**:
The 'update_resume' tool accepts more than the classic sections. Populate these ONLY from information the user (or an uploaded CV) actually provides — never invent a value and never write a placeholder, because an absent field renders as nothing while a made-up one renders as fact (PRD §8):
- \`personal\` — country-specific personal details: \`dob\`, \`nationality\`, \`maritalStatus\`, \`visaStatus\`, \`fatherName\`, \`gender\`. Populate only the fields the country convention above expects and the user actually states.
- \`basics.photo\` — a photo (data URI or path). Only set it when the convention expects a photo and the user has supplied one.
- \`signature\` — \`place\`, \`date\`, \`signed\`. Used by conventions that require a signature line.`;

/** The country-preset block. With no preset it states that plainly and adds no rules. */
function countrySection(preset: CountryPreset | undefined): string {
  if (!preset) {
    return `**Country Convention**:
No country convention is selected, so no country-specific personal fields, photo, signature line or page limit applies. Follow widely accepted international resume conventions, and mention that the user can select their target country if they are applying abroad.`;
  }

  const details =
    preset.personalFields.length > 0
      ? preset.personalFields.map((field) => PERSONAL_FIELD_LABELS[field]).join(', ')
      : 'none — do not add a photo, date of birth, nationality, marital status or signature';

  const lines = [
    `**Country Convention — ${preset.name} (${preset.code})**:`,
    `The user is targeting ${preset.name}. The local document is called a "${preset.documentName}".`,
    `- Required personal details: ${details}.`,
    `- Photo: ${preset.rules.photoExpected ? 'expected on this document' : 'not used in this market — do not request one'}.`,
    `- Signature line: ${
      preset.rules.signatureRequired
        ? 'expected — ask for the place and date and record them in `signature`'
        : 'not required'
    }.`,
  ];

  const targetPages = preset.page.targetPages;
  if (targetPages) {
    lines.push(`- Target length: ${targetPages} page${targetPages === 1 ? '' : 's'}.`);
  }
  lines.push('Ask for the details above when they are still missing, and never invent them.');
  return lines.join('\n');
}

function parseResume(resumeJson: string | null | undefined): ResumeJSON {
  if (!resumeJson) return {};
  try {
    const parsed = JSON.parse(resumeJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A malformed stored value must not break prompt construction; treat it as
    // empty, exactly as the frontend's preview path does.
    return {};
  }
}

/**
 * PRD §9.7 — the post-upload first turn. Only emitted when there is an uploaded
 * CV *and* the structured resume is still empty; once the resume is populated
 * the normal interviewing flow applies.
 */
function uploadedCvSection(session: PromptSession): string | null {
  const source = typeof session.source_text === 'string' ? session.source_text.trim() : '';
  if (!source) return null;
  if (!isResumeEmpty(parseResume(session.resume_json))) return null;

  return `**Uploaded CV — do this on your next reply**:
The user uploaded an old CV and the structured resume is still empty. You are the one who populates it — the app does NOT pre-fill anything. On your NEXT reply you must:
1. Briefly acknowledge that you have read the uploaded CV (one short sentence).
2. Call the 'update_resume' tool to populate everything you can extract from the uploaded text below — \`basics\`, \`work\`, \`education\`, \`skills\`, \`projects\`, \`certifications\`, \`languages\`, and the country-specific \`personal\` / \`signature\` fields when the convention expects them and the text actually contains them.
3. Only then ask about the genuine gaps — the details the uploaded CV does not contain.`;
}

/**
 * Build the chat system instruction for a session (PRD §9.1).
 *
 * Pure: same input, same output, no I/O. Called from the messages route in
 * `server.ts`.
 */
export function buildSystemInstruction(session: PromptSession): string {
  const preset = getCountryPreset(session.country_code);

  const blocks: string[] = [
    INTERVIEW_GUIDELINES,
    countrySection(preset),
    FIELD_DOCUMENTATION,
  ];

  const uploadedCv = uploadedCvSection(session);
  if (uploadedCv) blocks.push(uploadedCv);

  blocks.push(
    [
      'Current Resume State:',
      session.resume_json ?? '{}',
      '',
      'Current Cover Letter State:',
      session.cover_letter_json || '{}',
      '',
      'Uploaded Old Resume Text:',
      session.source_text || 'None uploaded.',
      '',
      'Target Job Details:',
      session.job_text || 'None specified.',
    ].join('\n'),
  );

  return blocks.join('\n\n');
}
