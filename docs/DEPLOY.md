# Deployment

This document describes how to run the app in production mode, what data must be
persisted, and the security posture you must understand before exposing it.

The app is designed as a **local-first, single-user tool**. It has no accounts,
no authentication, and no encryption. Read section 3 before putting it on a
network.

---

## 1. Production mode

Development (`npm run dev`) runs the Vite middleware inside the Express server,
so the front end is compiled on the fly. Production uses a pre-built bundle.

```bash
npm install          # installs devDependencies too — see the warning below
npm run build        # vite build -> dist/
NODE_ENV=production npm start
```

Verified behaviour in `server.ts`:

- The mode is chosen by `process.env.NODE_ENV`. When it is **exactly**
  `production`, the server mounts `express.static(dist)` and serves
  `dist/index.html` for any unmatched route (SPA fallback).
- Otherwise, it creates a Vite server in middleware mode and mounts it.
- The server **always** listens on port **3000**, bound to `0.0.0.0`. The port is
  a constant in `server.ts`; it is not configurable through an environment
  variable today.

`npm run build` runs `vite build` only. There is **no server build step** — the
server runs directly from TypeScript source via `tsx`.

### Production needs devDependencies

Two packages listed under `devDependencies` are required at runtime:

- **`tsx`** executes `server.ts` (which is TypeScript).
- **`vite`** is imported at the top of `server.ts`, even though its branch only
  runs in development. A static import cannot be skipped at runtime.

Therefore **`npm ci --omit=dev` will produce a server that fails to start.** For
a production install, install all dependencies (omit nothing), or at minimum
ensure `tsx` and `vite` are present alongside the dependencies.

### Runtime requirement

Node **22.5 or newer** is required because the server uses `node:sqlite`
(introduced in Node 22.5). Tested on Node 24.14. The module is experimental and
prints an `ExperimentalWarning` at startup; this is expected.

---

## 2. Data that must be persisted

All state is stored on the local filesystem, next to the working directory the
server is started from (paths are resolved with `process.cwd()`):

| Path | Contents | Must persist? |
|---|---|---|
| `database.sqlite` | The SQLite database: `sessions`, `messages`, `templates`. Your entire resume history. | **Yes.** Losing it loses every session. |
| `settings.json` | Provider, base URL, model, and the **API key**. Git-ignored. | **Yes**, if you configured the provider in the app. |
| `database.json.pre-sqlite.bak` | A preserved copy of the legacy JSON store (created once by the migration if a legacy file was present). | Optional — keep as a backup. |

If the app or the environment is configured entirely through environment
variables, `settings.json` is not needed and no secret is written to disk.

Both `database.sqlite` and `settings.json` are listed in `.gitignore` and must
never be committed.

### Backups

Because everything is local, a backup is a file copy. Stop the server (so SQLite
has no write in flight), then copy `database.sqlite` and `settings.json`
together — the settings file is what makes a restore usable without re-entering
the provider configuration.

---

## 3. Security: there is no authentication

**This is the most important section.**

- The app has **no login, no accounts, and no authorization** by design
  (PRD §6). Anyone who can reach the port can read every session, edit or delete
  any session, change the provider settings, and make model calls billed to the
  configured API key.
- The server binds to `0.0.0.0`, so once it is running it is reachable from other
  machines on the same network unless a firewall blocks it.
- The API key is stored in plaintext in `settings.json` (a local file, git-
  ignored). It is only ever *sent to the provider you configured*, and it is
  masked when read back through the API — but it is not encrypted at rest.

**Do not expose this app to the public internet.** If you need remote access, put
it behind an authenticating reverse proxy or a private network (a VPN, an SSH
tunnel, or an allow-listed firewall), and treat the port as you would an
unauthenticated admin console.

There is no CSRF protection and no TLS termination in the app. If you front it
with a proxy, terminate TLS at the proxy.

---

## 4. Environment configuration

Provider configuration can come from the environment, and environment variables
**override** `settings.json`. The server loads `.env.local` first, then `.env`.
See [`.env.example`](../.env.example) for the full list with comments, and
[`docs/PROVIDERS.md`](PROVIDERS.md) §6 for the precedence rules and variable
names.

Relevant to deployment specifically:

- `NODE_ENV=production` — selects static serving of `dist/`.
- `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` — provider for any
  adapter.
- `OPENAI_*`, `ANTHROPIC_*`, `GEMINI_*` — provider-specific equivalents.
- `AI_TEMPERATURE`, `AI_MAX_TOKENS` — numeric overrides.

Keep real values in the deployment environment or a git-ignored `.env.local`,
never in a tracked file.

---

## 5. Why there is no Dockerfile in this repository

A Dockerfile was considered and deliberately **not** added, because it could not
be built or run during the stage that produced this document, and shipping an
untested container definition is worse than shipping none. The structural facts
that make it non-trivial are recorded here so a future, verifiable attempt starts
informed:

1. **Production runs from TypeScript source.** There is no server build step.
   The image must carry `server.ts`, `server/`, and the `src/templates/**` tree
   that `server/prompt.ts` and `server/ai/schema.ts` import at runtime, plus
   `tsx` to run it.
2. **`vite` is a runtime import.** `server.ts` statically imports `vite`, so the
   runtime image must include `vite` even though its code path is unused in
   production. Both `tsx` and `vite` are devDependencies.
3. **The base image must be Node 22.5+** (24.x recommended) for `node:sqlite`,
   and the database file must live on a mounted volume to survive container
   replacement.

A correct multi-stage image would therefore build `dist/` with full
dependencies in one stage and copy all runtime dependencies plus the server
sources into the final stage. Until that image can be built and smoke-tested, the
recommended deployment is a plain Node process on a host with a persisted
`database.sqlite` and `settings.json`, behind an authenticating proxy.

---

## 6. Production checklist

1. Use Node 22.5+ (24.x recommended).
2. `npm install` (do **not** omit devDependencies).
3. `npm run build` succeeds and produces `dist/`.
4. Start with `NODE_ENV=production npm start` and confirm the app loads on
   `http://<host>:3000/`.
5. Confirm `database.sqlite` and `settings.json` are on a persistent,
   backed-up volume.
6. Confirm neither file is tracked by git (`git status` stays clean).
7. Put an authenticating proxy in front of the port, or bind access to a private
   network. Do not expose it publicly.
8. Confirm the provider key is supplied by the environment or lives only in the
   git-ignored `settings.json`.
