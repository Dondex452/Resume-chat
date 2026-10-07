/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ResumeBasics {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  links?: Array<{ label: string; url: string }>;
  /** M10 — data URI / path. Only rendered when present (PRD §8). */
  photo?: string;
}

export interface WorkExperience {
  company?: string;
  role?: string;
  start?: string;
  end?: string;
  highlights?: string[];
}

export interface Education {
  school?: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
}

export interface SkillCategory {
  category?: string;
  items?: string[];
}

export interface Project {
  name?: string;
  description?: string;
  link?: string;
}

export interface Certification {
  name?: string;
  issuer?: string;
  date?: string;
}

export interface Language {
  name?: string;
  proficiency?: string;
}

/**
 * M10 — country-preset personal fields (PRD §8). Every field is optional and is
 * only populated when the user's country preset requires it. Absence must stay
 * absence: an absent field must never render as an empty heading.
 */
export interface ResumePersonal {
  dob?: string;
  nationality?: string;
  maritalStatus?: string;
  visaStatus?: string;
  fatherName?: string;
  gender?: string;
}

/** M10 — signature block (Germany's Lebenslauf convention, PRD §8). */
export interface ResumeSignature {
  place?: string;
  date?: string;
  signed?: boolean;
}

export interface ResumeJSON {
  basics?: ResumeBasics;
  personal?: ResumePersonal;
  work?: WorkExperience[];
  education?: Education[];
  skills?: SkillCategory[];
  projects?: Project[];
  certifications?: Certification[];
  languages?: Language[];
  signature?: ResumeSignature;
}

export interface CoverLetterJSON {
  recipient?: {
    name?: string;
    company?: string;
    role?: string;
  };
  intro?: string;
  body?: string;
  closing?: string;
  tone?: string;
}

export interface Session {
  id: string;
  title: string;
  status: 'draft' | 'complete';
  resume_json: string; // Stringified ResumeJSON
  template_id: string;
  /** M10 — ISO 3166-1 alpha-2, e.g. `DE`. Absent on pre-M10 sessions. */
  country_code?: string;
  /**
   * M16 (PRD §5.4 amended) — the user's own page choice, which **wins over the
   * country preset**. `null`/absent means "follow the country preset" for the
   * size and the `portrait` default for the orientation. The server normalises
   * both on write (`server/store.ts`) and clears anything unrecognised to
   * `null`, so a stored value is always one of these or null.
   */
  page_size?: 'A4' | 'Letter' | 'Legal' | 'A5' | null;
  page_orientation?: 'portrait' | 'landscape' | null;
  cover_letter_json?: string; // Stringified CoverLetterJSON
  cover_letter_text?: string;
  source_text?: string;
  job_text?: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// M8 — Universal AI provider layer (PRD §5.2)
// ---------------------------------------------------------------------------

export type CapabilityTier = 'full' | 'fallback' | 'chat-only' | 'unknown';

export interface ProviderInfo {
  id: string;
  label: string;
  defaultBaseURL: string;
  defaultModel: string;
  requiresApiKey: boolean;
  suggestedModels: string[];
}

export interface PublicSettings {
  provider: string;
  baseURL: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  apiKeySource: 'env' | 'file' | 'none';
  capability: CapabilityTier;
  capabilityCheckedAt: string | null;
  envOverridden: string[];
  updatedAt: string | null;
}

export interface ChatMeta {
  capability: CapabilityTier;
  provider: string;
  model: string;
}

export interface AiError {
  code: string;
  message: string;
}
