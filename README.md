# AI Resume Generator

Chat with an AI and it interviews you, one or two questions at a time. As you
answer, it writes your answers into a structured resume that you watch update
live, then renders through the design you picked. When you are done you export a
PDF, a Word document, or Markdown — and, if you want one, a tailored cover
letter. It runs entirely on your machine: no account, no cloud sync, no
telemetry. Nothing leaves your computer except the calls to the AI provider *you*
configure (or to a local model, in which case nothing leaves at all).

---

## 1. Requirements

- **Node.js 22.5 or newer.** This is a hard floor: the app stores its data in
  SQLite through Node's built-in `node:sqlite` module, which first appeared in
  Node 22.5. It has been tested on Node 24.14.
- npm (any recent version).
- An AI model to talk to. You can use a hosted provider with an API key, or a
  local runtime such as Ollama. See section 3.

> **Note on `node:sqlite`:** the module is still marked *experimental* in Node,
> so the server prints an `ExperimentalWarning` on startup. This is expected and
> harmless. It does not indicate a problem with the app.

---

## 2. Install and run

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

The app has three pages, all reached by hash links (no router library):

| URL | Page |
|---|---|
| `http://localhost:3000/#/` | Home / landing page |
| `http://localhost:3000/#/studio` | The builder — chat, preview, export |
| `http://localhost:3000/#/templates` | Your templates: browse, clone, import, edit, and generate |

In development the server runs the Vite middleware, so the front end reloads as
you edit it. The API and the front end are served from the same port.

---

## 3. Choosing a model

This is the product's defining feature, so it is worth reading in full.

Click the **gear icon in the studio header** to open AI settings. There you set:

- **Provider** — one of the three adapters (below).
- **Base URL** — where the model lives.
- **Model** — the model id, e.g. `gpt-4o-mini` or `deepseek-chat`.
- **API key** — your key. Leave it blank for a local runtime that needs none.

You can press **Test** to check the configuration before saving. The key is
stored in a git-ignored file (`settings.json`) and is only ever sent to the
provider you chose. When the settings are read back, the key is **masked**
(`sk-...4f2a`), never returned in plaintext.

### 3.1 The three adapters

| Adapter | Use it for |
|---|---|
| `openai-compatible` | **The universal adapter.** Any endpoint that speaks the OpenAI chat-completions API: OpenAI itself, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, and any custom base URL. It is also the path for **keyless local runtimes** — Ollama, LM Studio, vLLM, llama.cpp and LocalAI. |
| `anthropic` | Anthropic's native Messages API (`api.anthropic.com`). |
| `gemini` | Google Gemini's native `generateContent` API. |

For the common providers, see [`docs/PROVIDERS.md`](docs/PROVIDERS.md), which has
concrete base-URL and model-id examples and explains how to add a new provider.

### 3.2 Using a local model (no key, nothing leaves your machine)

1. Start your local runtime (for example, `ollama serve`).
2. Open AI settings, choose **`openai-compatible`**.
3. Set the base URL to your local server, e.g. `http://localhost:11434/v1`.
4. Set the model id to a model you have pulled, e.g. `llama3.1`.
5. Leave the API key blank.

The app detects a loopback/private base URL and does not require a key for it.

### 3.3 Environment variables override the settings file

If you are deploying, you can configure the provider from the environment instead
of the settings screen. **Environment variables take precedence over
`settings.json`.** The server loads them from `.env.local` first, then `.env`
(both are git-ignored except the example). See [`.env.example`](.env.example).

| Variable | Meaning |
|---|---|
| `AI_PROVIDER` | Adapter id: `openai-compatible`, `anthropic`, or `gemini`. Also inferred from whichever provider key is set. |
| `AI_BASE_URL` | Base URL for any provider. |
| `AI_MODEL` | Model id for any provider. |
| `AI_API_KEY` | API key for any provider. |
| `AI_TEMPERATURE` | Optional sampling temperature (number). |
| `AI_MAX_TOKENS` | Optional max output tokens (number). |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY` | Provider-specific equivalents for `openai-compatible`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Provider-specific equivalents for `anthropic`. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Provider-specific equivalents for `gemini`. |

Note: `NODE_ENV=production` switches the server from Vite middleware to serving
the pre-built `dist/` folder. `DISABLE_HMR` is a Vite development-only flag.

### 3.4 Capability tiers

Not every model can make structured updates. When you first connect, or press
**Test**, the app probes the model and reports one of three tiers:

| Tier | What it means |
|---|---|
| `full` | The model supports native tool calling. Resume and cover-letter updates happen directly. |
| `fallback` | No native tools. The model is asked to emit a fenced JSON block describing the update, which the app parses and applies. Works, but slightly less reliably. |
| `chat-only` | The model can converse but cannot reliably update your resume. The app says so up front rather than silently doing nothing. |

The tier is shown in the settings screen and, for `chat-only`, as a permanent
notice in the studio.

---

## 4. Bringing your own CV

Use **Upload old CV** in the studio. Accepted formats are `.pdf`, `.docx`,
`.txt` and `.md`. The app extracts **text only** — no vision model is involved,
which is what keeps cheap and local models viable.

- The extracted text is always shown to you for review and correction before it
  is used. Extraction by itself never writes anything.
- If the file has no usable text (a scanned, image-only PDF, for example), the
  app tells you and opens a **paste-as-text** panel so you can supply the text by
  hand.
- Unsupported file types are rejected explicitly rather than decoded as garbage.
- The file's magic bytes are checked, not just its name, so a renamed file that
  is not really a PDF is rejected.

---

## 5. Job context

Open the job panel and **paste the job description as text**. This is the primary
path and the one that actually works for most job boards, because LinkedIn,
Workday, Greenhouse and Lever render their pages with JavaScript and often return
an empty shell to a plain fetch.

You can also paste a URL, as a best effort. The app fetches it safely (rejecting
local, private and metadata addresses), detects when a page returned no readable
text, and tells you to paste the description instead. It does not feed junk to
the model.

---

## 6. Export

From the studio you can export the resume as:

- **PDF** — a pixel render of the selected template at the page size your country
  preset calls for (A4, or Letter for US/Canada).
- **DOCX** — an editable Word document generated from your resume data.
- **Markdown** — a plain `.md` file.

The cover letter has its own separate PDF / DOCX / Markdown export.

> **Important limitation:** the PDF export rasterises the page (it draws the
> rendered sheet to a canvas and wraps it in a PDF). The resulting PDF has **no
> text layer**, so many applicant-tracking systems cannot read it, and its file
> size is large for a one-page document. See "Known gaps" below.

---

## 7. Scripts

| Script | Command | Use |
|---|---|---|
| `npm run dev` | `tsx server.ts` | Development server on port 3000, with Vite middleware. |
| `npm run build` | `vite build` | Build the front end into `dist/`. |
| `npm start` | `tsx server.ts` | Start the server. Set `NODE_ENV=production` to serve `dist/` as static files. |
| `npm test` | `tsx --test server/ai/__tests__/run.ts` | Run the backend test suite. |

The test entry is a single file that imports each suite, rather than a glob. This
is deliberate: **npm scripts do not expand globs on Windows**, so a glob pattern
would silently match nothing and the suite would appear to pass while running
zero tests. Always check the reported test count, not just the exit code.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Chat replies with `400 AI_NOT_CONFIGURED` | No provider is configured. Open AI settings (gear icon) and add one, or set a provider variable in the environment. |
| Chat replies with `401 AI_AUTH` | The provider rejected the API key. Check the key in AI settings. |
| Chat replies with `429 AI_RATE_LIMIT` | The provider is rate limiting you. Wait and retry. |
| Chat replies with `502` (`AI_UNREACHABLE`, `AI_TIMEOUT`, `AI_PROVIDER_ERROR`) | The provider could not be reached, timed out, or returned an error. Check the base URL and your connection. |
| `ExperimentalWarning: SQLite is an experimental feature` | Expected. The app uses Node's built-in `node:sqlite`. It is safe; see section 1. |
| The app is not on `http://localhost:3000` | The port is fixed at 3000 in the server. Make sure nothing else is using it, and that `npm run dev` started without an error. |
| `node:sqlite` fails to load or the app exits immediately | Your Node version is too old. Upgrade to Node 22.5 or newer (24.x recommended). |

---

## 9. Known gaps (not built yet)

The following are documented limitations, not hidden ones. None of these should
be described as working.

- **The German tabular `Lebenslauf` and the Japanese JIS `Rirekisho` layouts are
  not faithful.** The `tabular` layout is declared in the template schema but is
  not implemented, so both presets render the personal / photo / signature blocks
  in the template's default layout instead. Japan's seal box is drawn as a
  standard signature line.
- **`rules.dateFormat` is data only.** Country presets declare a date format, but
  no rendered date is reformatted to match it.
- **Template editing is structural only.** On `#/templates` you can reorder
  sections, move them between columns, and toggle visibility. You cannot edit
  design tokens (fonts, colours, spacing) yet, because each template's look is
  carried as a Tailwind class bundle inside its own data.
- **Exported PDFs are rasterised and have no text layer.** This makes them hard
  for applicant-tracking systems to parse, and large for their content. A
  headless HTML-to-PDF render path is the intended fix; it is not built.
- **The layout variants `timeline`, `table`, `tags` and `grid`** are declared in
  the schema but not used by any shipped template.

---

## 10. Project layout

```
server.ts                 Express server: routes, chat loop, static serving
server/
  ai/                     provider layer — adapters, neutral tool schemas, settings
  ingestion/              text extraction (PDF/DOCX/TXT/MD) and SSRF-safe URL fetch
  store.ts                persistence (node:sqlite) + resume/cover-letter merge
  prompt.ts               builds the chat system instruction
  templateRoutes.ts       CRUD for user-created templates
src/
  App.tsx                 app shell, hash routing, export handlers
  templates/              the template engine: schema, one renderer, built-ins, countries
  components/             UI, including the landing page and the templates page
  styles/tokens.css       every design value in one file
docs/
  PROVIDERS.md            adapters, base URLs, capability tiers, adding a provider
  DEPLOY.md               production mode, data to persist, security notes
```

For the binding specification and the project's design decisions, see
[`PRD.md`](PRD.md). For current status and history, see [`memory/`](memory/).
