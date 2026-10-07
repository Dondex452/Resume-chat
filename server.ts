/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
// M11 — the persistence layer is real SQLite (`node:sqlite`) behind the same
// callback API it always had. It lives in `server/store.ts` so it can be tested
// without booting this HTTP server. GOTCHA #14 (the JSON mock) is retired.
import {
  SqliteDatabase,
  mergeResume,
  mergeCoverLetter,
  renderCoverLetterText,
  normalizePageSize,
  normalizePageOrientation,
} from './server/store';
// M13 Stage A — text-only ingestion (PRD §5.8) + SSRF-safe URL fetch (§5.9).
// The pdf-parse wrapper and `mammoth` moved into `server/ingestion/extract.ts`.
import { extractDocumentText } from './server/ingestion/extract';
import { safeFetchText } from './server/ingestion/urlSafety';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { AIError } from './server/ai/types';
import type { CapabilityTier, NeutralMessage, ProviderConfig } from './server/ai/types';
import {
  runChatLoop,
  probeCapability,
  completeJson,
  listProviders,
  findAdapter,
} from './server/ai/index';
import { loadSettings, saveSettings, resolveConfig } from './server/ai/settings';
import { RESUME_TOOLS } from './server/ai/schema';
// M11 Stage A — CRUD for user-created / cloned templates (PRD §5.5, §8). The
// handlers live in their own module so they can be tested against a temporary
// database without booting this server (which opens the real store).
import { createTemplateRouter, createGeneratedTemplate } from './server/templateRoutes';
// M14 — the chat system instruction, extracted so it is unit-testable (PRD §9.1,
// §9.7). Pure function: no I/O, no model call.
import { buildSystemInstruction } from './server/prompt';
// M15 — true-text PDF export (PRD §11, amended). Prints the app's own `#/print`
// view with an already-installed Chromium, so the exported PDF carries a real
// text layer instead of being a 6.8 MB bitmap (GOTCHA #56).
import {
  PDF_RENDER_FAILED_MESSAGE,
  buildPrintViewUrl,
  renderResumePdf,
  resolvePort,
  sanitizeFilename,
} from './server/pdfExport';

// GOTCHAS #1: dotenv.config() with no args only loads `.env`, but this project
// documents `.env.local`. Load both (`.env.local` takes precedence).
dotenv.config({ path: ['.env.local', '.env'] });

const app = express();
// The print view URL is built from the same port the server listens on, so the
// two can never disagree (PRD §11). Env `PORT` wins; the default stays 3000.
const PORT = resolvePort();

// Increase body-parser limits for file uploads
app.use(express.json({ limit: '15mb' }));

// -------------------------------------------------------------
// SQLite Database Setup
// -------------------------------------------------------------
// The store owns the schema (PRD §8) and performs the one-time, idempotent
// migration off the legacy JSON file in its constructor (server/migrate.ts).
// A malformed statement now throws rather than returning null/[] silently.
const dbPath = path.join(process.cwd(), 'database.sqlite');
const db = new SqliteDatabase(dbPath);

// SQLite Promise wrappers
const runQuery = (sql: string, params: any[] = []): Promise<{ lastID?: number, changes?: number }> => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const getQuery = (sql: string, params: any[] = []): Promise<any> => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const allQuery = (sql: string, params: any[] = []): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// -------------------------------------------------------------
// AI Layer
// -------------------------------------------------------------
// All provider logic lives in `server/ai/` behind one neutral interface.
// No vendor SDK is imported here.

// `mergeResume` / `mergeCoverLetter` / `renderCoverLetterText` are imported from
// `./server/store` (see the import at the top of this file).

// Models sometimes wrap JSON in a markdown fence despite instructions.
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

// Capability is read from saved settings; probed once and then persisted/cached.
let capabilityCache: { capability: CapabilityTier; checkedAt: string } | null = null;

async function ensureCapability(config: ProviderConfig): Promise<CapabilityTier> {
  if (capabilityCache && capabilityCache.capability !== 'unknown') return capabilityCache.capability;

  const publicSettings = loadSettings();
  if (publicSettings.capability && publicSettings.capability !== 'unknown') {
    capabilityCache = {
      capability: publicSettings.capability,
      checkedAt: publicSettings.capabilityCheckedAt || new Date().toISOString(),
    };
    return publicSettings.capability;
  }

  const probe = await probeCapability(config);
  const checkedAt = new Date().toISOString();
  try {
    saveSettings({ capability: probe.capability, capabilityCheckedAt: checkedAt });
  } catch (err: any) {
    console.error('Failed to persist capability result:', err?.message || err);
  }
  capabilityCache = { capability: probe.capability, checkedAt };
  return probe.capability;
}

// -------------------------------------------------------------
// REST API Routes
// -------------------------------------------------------------

// List sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await allQuery('SELECT * FROM sessions ORDER BY updated_at DESC');
    res.json(sessions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new session
app.post('/api/sessions', async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const title = req.body.title || 'New Resume Session';
    const template_id = req.body.template_id || 'minimal';
    // M10 — ISO 3166-1 alpha-2 (e.g. 'DE'). Optional; absent stays absent.
    const country_code = req.body.country_code || null;
    // M16 — the page the user owns (PRD §5.4 amended). Both are advisory:
    // anything unrecognised stores as NULL (= follow the country preset).
    const page_size = normalizePageSize(req.body.page_size);
    const page_orientation = normalizePageOrientation(req.body.page_orientation);
    const source_text = req.body.source_text || null;
    const job_text = req.body.job_text || null;
    const now = new Date().toISOString();

    let initialResumeJson = '{}';

    // If we have parsed old resume source text, pre-extract it with a neutral AI
    // call. A missing/invalid key must never block session creation.
    if (source_text) {
      try {
        // M13 — the prompt now carries the FULL PRD §8 shape (incl. the M10
        // `personal` / `signature` blocks and `basics.photo`). It previously
        // listed only the v1 schema, so an imported old CV could never populate
        // them (STATUS "What does NOT work" / ARCHITECTURE gap).
        const parsePrompt = `You are a helper that extracts raw resume text into a clean JSON structure.

        Return ONLY a JSON object with this shape (include a key ONLY when the text actually supports it):
        basics: { fullName, email, phone, location, summary, links: [{ label, url }], photo }
        personal: { dob, nationality, maritalStatus, visaStatus, fatherName, gender }
        work: [{ company, role, start, end, highlights: [] }]
        education: [{ school, degree, field, start, end }]
        skills: [{ category, items: [] }]
        projects: [{ name, description, link }]
        certifications: [{ name, issuer, date }]
        languages: [{ name, proficiency }]
        signature: { place, date, signed }

        Rules:
        - OMIT any personal field (dob, nationality, maritalStatus, visaStatus, fatherName, gender, photo) you cannot find in the text. Never invent values; absent fields must never render as empty headings.
        - Omit empty arrays and empty objects.
        - If the text yields no resume content at all, respond with exactly {}.
        - Respond ONLY with the JSON object. No markdown, no commentary.

        Extracted text:
        ${source_text}`;

        const parseText = await completeJson(parsePrompt);
        if (parseText) {
          const cleaned = stripCodeFences(parseText.trim());
          // Verify it's valid JSON before persisting.
          JSON.parse(cleaned);
          initialResumeJson = cleaned;
        }
      } catch (err: any) {
        console.warn('Failed to pre-parse uploaded resume to JSON (continuing):', err?.message || err);
      }
    }

    // Column list here MUST stay in step with `SESSION_COLUMNS` in
    // `server/migrate.ts`; the parameter count is now checked by the engine.
    await runQuery(`
      INSERT INTO sessions (id, title, status, resume_json, template_id, country_code, page_size, page_orientation, cover_letter_json, cover_letter_text, source_text, job_text, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, '{}', '', ?, ?, ?, ?)
    `, [id, title, initialResumeJson, template_id, country_code, page_size, page_orientation, source_text, job_text, now, now]);

    // Insert welcome message
    const welcomeMsgId = crypto.randomUUID();
    let welcomeText = "Hi! I'm your AI Resume Interviewer. Let's build your professional CV together!\n\nTo get started, what is your full name, and what kind of role are you targeting?";
    if (source_text) {
      welcomeText = "Hi! I've uploaded your existing resume and extracted your information. Let's review it together! We can start by reviewing your contact details or your work experience. What would you like to verify first?";
    }
    if (job_text) {
      welcomeText += "\n\nI've also analyzed your target job posting so I can tailor the experience, highlights, and summaries to align with what the recruiters are looking for!";
    }

    await runQuery(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, 'assistant', ?, ?)
    `, [welcomeMsgId, id, welcomeText, now]);

    const session = await getQuery('SELECT * FROM sessions WHERE id = ?', [id]);
    res.json(session);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get session details
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const session = await getQuery('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update session details (title, status, resume_json, template_id, country_code, page_size, page_orientation, cover_letter_json, cover_letter_text, source_text, job_text)
app.put('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, status, resume_json, template_id, country_code, page_size, page_orientation, cover_letter_json, cover_letter_text, source_text, job_text } = req.body;
    const now = new Date().toISOString();

    const existing = await getQuery('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Session not found' });

    // The SET order MUST match the params order below. A column typo now fails
    // loudly at prepare time instead of being dropped silently.
    // `source_text` / `job_text` were missing here until M13: the v1 upload flow
    // PUT them and got a 200 back, so "upload your old CV" and "paste the job
    // description" appeared to work while persisting nothing (PRD §5.8/§5.9).
    // M16 adds `page_size` / `page_orientation` to BOTH lists — the exact place
    // GOTCHA #55 happened — and `pageSettings.test.ts` asserts a PUT that
    // touches only `title` leaves every other field intact.
    await runQuery(`
      UPDATE sessions
      SET title = ?, status = ?, resume_json = ?, template_id = ?, country_code = ?, page_size = ?, page_orientation = ?, cover_letter_json = ?, cover_letter_text = ?, source_text = ?, job_text = ?, updated_at = ?
      WHERE id = ?
    `, [
      title !== undefined ? title : existing.title,
      status !== undefined ? status : existing.status,
      resume_json !== undefined ? resume_json : existing.resume_json,
      template_id !== undefined ? template_id : existing.template_id,
      country_code !== undefined ? country_code : existing.country_code,
      // Normalise on write: an explicit unrecognised value clears the choice to
      // NULL; an absent field leaves the stored value alone.
      page_size !== undefined ? normalizePageSize(page_size) : existing.page_size,
      page_orientation !== undefined ? normalizePageOrientation(page_orientation) : existing.page_orientation,
      cover_letter_json !== undefined ? cover_letter_json : existing.cover_letter_json,
      cover_letter_text !== undefined ? cover_letter_text : existing.cover_letter_text,
      source_text !== undefined ? source_text : existing.source_text,
      job_text !== undefined ? job_text : existing.job_text,
      now,
      id
    ]);

    const updated = await getQuery('SELECT * FROM sessions WHERE id = ?', [id]);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await runQuery('DELETE FROM sessions WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get session messages
app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await allQuery('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [id]);
    res.json(messages);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Send message & trigger the conversational AI interviewing loop
app.post('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: 'Content is required' });

    // 1. The session must exist before we write anything.
    const session = await getQuery('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // 2. Resolve the AI config BEFORE inserting the user message, so a missing
    //    key cannot leave an orphan user turn behind.
    const config = resolveConfig();

    // 3. Determine the model's capability tier (probed once, then persisted).
    const capability = await ensureCapability(config);

    // 4. Insert user message.
    // AUDIT FIX: this previously passed FIVE values for FOUR placeholders
    // (`'user'` twice). The JSON mock tolerated it because it mapped params by
    // hand; real SQLite rejects it ("column index out of range"), and the
    // store's parameter-count guard now catches it before the engine does.
    const now = new Date().toISOString();
    const userMsgId = crypto.randomUUID();
    await runQuery(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, ?)
    `, [userMsgId, sessionId, content, now]);

    // 5. Fetch past messages for history
    const pastMessages = await allQuery('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);

    // 6. Construct the instruction. PRD §9.1: guidelines + current resume_json +
    //    country-preset context. PRD §9.7: an uploaded CV with an empty resume
    //    carries an explicit acknowledge-and-populate instruction. The builder is
    //    a pure exported function (server/prompt.ts) so it is unit-tested.
    const systemInstruction = buildSystemInstruction(session);

    // Map history to the neutral message shape (user stays user, assistant -> assistant)
    const history: NeutralMessage[] = pastMessages.map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Run the provider-neutral chat loop (native tools / JSON fallback / chat-only)
    const loopResult = await runChatLoop({
      system: systemInstruction,
      messages: history,
      tools: RESUME_TOOLS,
      config,
      capability,
      onToolCall: async (name: string, args: any) => {
        try {
          if (name === 'update_resume') {
            const patch = args?.patch ?? args;
            const currentSession = await getQuery('SELECT * FROM sessions WHERE id = ?', [sessionId]);
            if (!currentSession) return { ok: false, error: 'Session not found' };
            let currentResume: any = {};
            try { currentResume = JSON.parse(currentSession.resume_json || '{}'); } catch (e) { }
            const updatedResume = mergeResume(currentResume, patch);
            await runQuery('UPDATE sessions SET resume_json = ?, updated_at = ? WHERE id = ?', [
              JSON.stringify(updatedResume),
              new Date().toISOString(),
              sessionId
            ]);
            return { ok: true };
          }

          if (name === 'update_cover_letter') {
            const patch = args?.patch ?? args;
            const currentSession = await getQuery('SELECT * FROM sessions WHERE id = ?', [sessionId]);
            if (!currentSession) return { ok: false, error: 'Session not found' };
            let currentCL: any = {};
            try { currentCL = JSON.parse(currentSession.cover_letter_json || '{}'); } catch (e) { }
            const updatedCL = mergeCoverLetter(currentCL, patch);
            // INVARIANT: always re-render and persist the plain-text cover letter.
            // M14: pass the resume's real name so a generated sign-off reads
            // "Sincerely,\nJane Doe" and never the old "[Your Name]" placeholder.
            // `currentSession` is the freshest row (a prior update_resume call in
            // the same turn may have just set the name).
            let senderName = '';
            try {
              senderName = JSON.parse(currentSession.resume_json || '{}')?.basics?.fullName || '';
            } catch (e) {
              // A malformed resume_json must not block persisting the letter.
            }
            const updatedText = renderCoverLetterText(updatedCL, senderName);
            await runQuery('UPDATE sessions SET cover_letter_json = ?, cover_letter_text = ?, updated_at = ? WHERE id = ?', [
              JSON.stringify(updatedCL),
              updatedText,
              new Date().toISOString(),
              sessionId
            ]);
            return { ok: true };
          }

          // M11 Stage B — PRD §9: create_template(schema) -> { ok, template_id }.
          // `createGeneratedTemplate` re-runs `validateTemplateSchema` and writes
          // nothing unless it passes, so a rejected document can never reach the
          // gallery. The chat loop's repair pass already tried once; a failure
          // here degrades the turn with an error, it never throws.
          if (name === 'create_template') {
            const created = createGeneratedTemplate(db, args?.schema);
            return created;
          }

          return { ok: false, error: `Unknown tool: ${name}` };
        } catch (err: any) {
          console.error('Tool execution error:', name, err);
          return { ok: false, error: err?.message || 'Tool execution failed' };
        }
      },
    });

    const assistantReply = loopResult.text || "I have updated your CV data. Let me know if you would like to refine any of these details!";

    // Insert assistant response message
    const assistantMsgId = crypto.randomUUID();
    const replyNow = new Date().toISOString();
    await runQuery(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES (?, ?, 'assistant', ?, ?)
    `, [assistantMsgId, sessionId, assistantReply, replyNow]);

    // Fetch final updated session & messages to send back
    const finalSession = await getQuery('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    const finalMessages = await allQuery('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);

    res.json({
      session: finalSession,
      messages: finalMessages,
      meta: {
        capability: loopResult.capability,
        provider: config.provider,
        model: config.model
      }
    });
  } catch (error: any) {
    if (error instanceof AIError) {
      console.error(`AI error [${error.code}]${error.provider ? ` via ${error.provider}` : ''}:`, error.message);
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error('Message processing error:', error);
    res.status(500).json({ error: error?.message || 'Internal server error', code: 'INTERNAL' });
  }
});

// -------------------------------------------------------------
// Custom templates (M11 — PRD §5.5, §8)
// -------------------------------------------------------------
// User-created / cloned templates only. Built-in designs are static data in
// `src/templates/builtin.ts` and never appear in the `templates` table.
app.use('/api/templates', createTemplateRouter(db));

// -------------------------------------------------------------
// AI Provider settings
// -------------------------------------------------------------

// List available provider adapters
app.get('/api/providers', (req, res) => {
  res.json(listProviders());
});

// Current settings (API key always masked)
app.get('/api/settings', (req, res) => {
  try {
    res.json(loadSettings());
  } catch (error: any) {
    console.error('Failed to load settings:', error);
    res.status(500).json({ error: 'Failed to load settings', code: 'INTERNAL' });
  }
});

// Update settings: { provider?, baseURL?, model?, apiKey?, temperature?, maxTokens? }
app.put('/api/settings', (req, res) => {
  try {
    const body = req.body || {};
    if (body.provider !== undefined) {
      if (typeof body.provider !== 'string' || !findAdapter(body.provider)) {
        return res.status(400).json({ error: `Unknown provider: ${body.provider}`, code: 'INVALID_PROVIDER' });
      }
    }
    const saved = saveSettings({
      provider: body.provider,
      baseURL: body.baseURL,
      model: body.model,
      apiKey: body.apiKey,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
    });
    res.json(saved);
  } catch (error: any) {
    console.error('Failed to save settings:', error);
    res.status(500).json({ error: 'Failed to save settings', code: 'INTERNAL' });
  }
});

// Probe a provider's capability. Optional overrides are merged over the saved
// config so the user can test before saving. Always 200 on a completed probe.
app.post('/api/settings/test', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.provider !== undefined) {
      if (typeof body.provider !== 'string' || !findAdapter(body.provider)) {
        return res.status(400).json({ error: `Unknown provider: ${body.provider}`, code: 'INVALID_PROVIDER' });
      }
    }

    let savedConfig: ProviderConfig | null = null;
    try {
      savedConfig = resolveConfig();
    } catch (err) {
      if (!(err instanceof AIError) || err.code !== 'AI_NOT_CONFIGURED') throw err;
    }

    const provider = body.provider || savedConfig?.provider || loadSettings().provider;
    const adapter = findAdapter(provider);
    const merged: ProviderConfig = {
      provider,
      baseURL: body.baseURL ?? savedConfig?.baseURL ?? adapter?.defaultBaseURL ?? '',
      model: body.model ?? savedConfig?.model ?? adapter?.defaultModel ?? '',
      apiKey: body.apiKey !== undefined && body.apiKey !== '' ? body.apiKey : savedConfig?.apiKey,
      temperature: savedConfig?.temperature,
      maxTokens: savedConfig?.maxTokens,
    };

    const hasOverrides =
      body.provider !== undefined ||
      body.baseURL !== undefined ||
      body.model !== undefined ||
      body.apiKey !== undefined;

    try {
      const probe = await probeCapability(merged);
      if (!hasOverrides) {
        try {
          saveSettings({ capability: probe.capability, capabilityCheckedAt: new Date().toISOString() });
        } catch (err: any) {
          console.error('Failed to persist capability result:', err?.message || err);
        }
      }
      return res.json({
        ok: true,
        capability: probe.capability,
        provider: merged.provider,
        model: merged.model,
        latencyMs: probe.latencyMs,
        message: probe.detail,
      });
    } catch (err: any) {
      const aiError =
        err instanceof AIError
          ? err
          : new AIError('AI_PROVIDER_ERROR', err?.message || 'Provider test failed', { cause: err });
      console.error(`Provider test failed [${aiError.code}] for ${merged.provider}:`, aiError.message);
      return res.status(200).json({
        ok: false,
        code: aiError.code,
        error: aiError.message,
        provider: merged.provider,
        model: merged.model,
        capability: 'unknown',
      });
    }
  } catch (error: any) {
    console.error('Failed to test provider:', error);
    res.status(500).json({ error: 'Failed to test provider', code: 'INTERNAL' });
  }
});

// Parse resume document (M13 — PRD §5.8 response contract)
app.post('/api/upload-resume', async (req, res) => {
  try {
    const { filename, data } = req.body || {};
    // `data: ''` is an explicitly empty file, NOT a malformed request: it falls
    // through to extraction and returns 422 EXTRACT_EMPTY, which is the truthful
    // outcome and carries the paste-as-text recovery (PRD §5.8).
    if (typeof filename !== 'string' || filename.trim() === '' || typeof data !== 'string') {
      return res.status(400).json({ error: 'A filename and the file content are required.', code: 'BAD_REQUEST' });
    }

    const buffer = Buffer.from(data, 'base64');
    // Pure: extraction never persists anything (PRD §5.8).
    const result = await extractDocumentText(filename, buffer);

    if (result.ok) {
      return res.json({ text: result.text, chars: result.chars, format: result.format });
    }

    if (result.code === 'UNSUPPORTED_TYPE') {
      return res.status(415).json({ error: result.error, code: 'UNSUPPORTED_TYPE' });
    }
    if (result.code === 'EXTRACT_EMPTY') {
      return res.status(422).json({
        error: result.error,
        code: 'EXTRACT_EMPTY',
        format: result.format,
        chars: result.chars,
      });
    }
    return res.status(500).json({ error: result.error, code: 'EXTRACT_FAILED' });
  } catch (error: any) {
    console.error('File parsing error:', error);
    return res.status(500).json({
      error: 'That file could not be read. Paste your CV text instead.',
      code: 'EXTRACT_FAILED',
    });
  }
});

// Fetch job link (M13 — PRD §5.9 response contract, SSRF-safe)
app.post('/api/fetch-job', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (typeof url !== 'string' || url.trim() === '') {
      return res.status(400).json({
        error: 'A URL is required. Paste the job description as text instead - it is more reliable than a link.',
        code: 'BAD_REQUEST',
      });
    }

    const result = await safeFetchText(url);
    if (result.ok) {
      return res.json({
        text: result.text,
        chars: result.chars,
        url: result.finalUrl,
        truncated: result.truncated,
      });
    }

    const status = result.code === 'INVALID_URL' ? 400 : result.code === 'EMPTY_EXTRACT' ? 422 : 502;
    return res.status(status).json({ error: result.error, code: result.code });
  } catch (error: any) {
    console.error('Job link fetch error:', error);
    return res.status(502).json({
      error: 'Could not reach that link. Paste the job description as text instead - it is more reliable than a link.',
      code: 'FETCH_FAILED',
    });
  }
});

// -------------------------------------------------------------
// PDF export (M15 — PRD §11, amended 2026-09-21)
// -------------------------------------------------------------
// The v1/v2 export rasterised the page (`html2canvas` -> `jsPDF`): 6,818,220 B
// for one A4 page, zero text operators, and the app's own extractor read 0
// characters from it (GOTCHA #56). A resume's PDF must be machine-readable, so
// this route prints the app's own `#/print` view with an already-installed
// Chromium (`--headless=new --print-to-pdf`) - no bundled browser, no new
// dependency (PRD §14 Decision #26).
//
// Registered BEFORE the Vite middleware/SPA fallback so the path is actually
// matched: in dev an unmatched `/api/*` route answers with `index.html` at HTTP
// 200, which a naive client reads as success (GOTCHA #15).
// The print view holds the window `load` event open with a pending image request
// until it is genuinely ready (session loaded, fonts settled, one-page fit
// computed). The PDF engine prints after `load`, so this is what makes the
// exported page deterministic instead of a race — see `src/main.tsx`.
//
// The hold is released by the page itself (POST) or by the timeout, whichever
// comes first, so a page that never signals cannot stall an export.
const PRINT_HOLD_TIMEOUT_MS = 6000;
const PRINT_HOLD_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const printHolds = new Map<string, () => void>();

app.get('/api/print-hold', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const release = () => {
    clearTimeout(timer);
    printHolds.delete(token);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store');
    res.end(PRINT_HOLD_GIF);
  };
  const timer = setTimeout(release, PRINT_HOLD_TIMEOUT_MS);
  if (token) printHolds.set(token, release);
  else release();
});

app.post('/api/print-hold/:token', (req, res) => {
  const release = printHolds.get(req.params.token);
  if (release) release();
  res.json({ ok: true });
});

app.post('/api/export/resume-pdf', async (req, res) => {
  try {
    const rawSessionId = req.body?.sessionId;
    if (typeof rawSessionId !== 'string' || rawSessionId.trim() === '') {
      return res.status(400).json({ error: 'A sessionId is required.', code: 'BAD_REQUEST' });
    }
    const sessionId = rawSessionId.trim();

    const session = await getQuery('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) {
      return res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    }

    const url = buildPrintViewUrl(sessionId, PORT);
    const result = await renderResumePdf({ url });

    if (!result.ok || !result.buffer) {
      // Only the code and timing are logged - never the title or any content.
      console.error(`PDF export failed [${result.code}] after ${result.elapsedMs}ms`);
      return res.status(502).json({
        error: result.error || PDF_RENDER_FAILED_MESSAGE,
        code: result.code || 'PDF_RENDER_FAILED',
      });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log(`PDF export rendered in ${result.elapsedMs}ms (${result.buffer.length} bytes)`);
    }

    const filename = sanitizeFilename(session.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.buffer);
  } catch (error: any) {
    console.error('PDF export failed:', error?.message || error);
    return res.status(502).json({ error: PDF_RENDER_FAILED_MESSAGE, code: 'PDF_RENDER_FAILED' });
  }
});


// -------------------------------------------------------------
// Vite Middleware / Static Serves
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
