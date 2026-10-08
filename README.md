# FlowForge

Workflow automation platform (n8n-style) whose core feature will be **answering WhatsApp Business calls with an AI voice agent, 24/7**. Web editor, Windows/Android/iOS apps and a download site come in later phases.

> **Status: Phases 1 and 2 complete.** The server, database, workflow engine, editor, expressions, triggers, credentials vault and queue workers work and have tests. The phases below are built in order.

| Phase | Scope                                                                                                                         | Status  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1     | Server, database, workflow engine, editor canvas, core nodes, execution history                                               | ✅ Done |
| 2     | Expressions (isolated-vm), Merge/Switch/Loop, pinned data UI, queue + workers, Webhook & Schedule triggers, credentials vault | ✅ Done |
| 3     | WhatsApp Business connection, setup checklist, messaging nodes and triggers                                                   | ⏳ Next |
| 4     | Media server, incoming call handling, auto-answer modes, call log and recordings                                              |         |
| 5     | AI Voice Agent, knowledge base, tool calling, caller recognition, transfer, follow-ups, owner notifications                   |         |
| 6     | Outbound calls with permissions, live dashboard, analytics, integrations, templates, users/roles, public API                  |         |
| 7     | Windows `.exe`, Android `.apk`, sideloadable iOS `.ipa`                                                                       |         |
| 8     | Download website, release admin, CI/CD for all platforms                                                                      |         |

## Monorepo layout

```
apps/
  server/      Fastify API + execution engine host, Prisma/PostgreSQL, WebSocket push
  editor/      React + Vite + React Flow editor (later shared by desktop & mobile)
  desktop/     Windows app (Electron): bundles Node.js, the server, the editor and PostgreSQL
  website/     Next.js landing + download site (Vercel), reads public GitHub Releases
packages/
  workflow/    Shared types, Zod schemas, graph utilities, expressions, filter conditions
  engine/      Workflow executor, isolated-vm Code sandbox, HTTP helper
  nodes/       Every node implements INodeType (description + execute())
e2e/           Playwright browser tests against a running server
docker/        Server image (API + bundled editor)
```

Turborepo + pnpm workspaces, TypeScript everywhere (`strict`, `noUncheckedIndexedAccess`). Workspace packages ship TypeScript source; the server is bundled with tsup.

## What's in Phase 1

**Engine** (`packages/engine`)

- Workflows are JSON graphs (`nodes`, `connections`, `settings`, `pinData`). Data passes between nodes as items: `[{ json, binary? }]`.
- Depth-first execution (n8n "v1" order): branches run to completion, ordered by canvas position.
- Multi-input nodes wait for all connected inputs (and still run with partial data if a branch produced nothing). Loops (cycles) are supported, with infinite-loop protection.
- Per-node settings: retry on fail (tries + wait), on error (stop / continue / continue using an extra **error output**), always output data, execute once, deactivate (pass-through).
- Pinned data, "execute step" (run only up to a node), cancel, workflow timeout.
- Every run keeps its remaining work, so a failed execution can be **retried from the failed node** with the original or the current workflow.
- The Code node runs JavaScript in **isolated-vm** (separate V8 isolate: no `require`, `process`, network or file system; memory and time limits).
- Clear errors: `NodeOperationError` / `NodeApiError` carry the node, item index, HTTP status and a human-readable description (e.g. "The resource you are requesting could not be found", "The service refused the connection - perhaps it is offline (ECONNREFUSED api.example.com)").

**Core nodes** (`packages/nodes`): Manual Trigger, HTTP Request, Code (JS), If, Filter, Edit Fields (Set), Sort, Aggregate, Date & Time, Limit, Split Out, No-Op, Stop and Error, Sticky Note.

**Expressions (Phase 1 subset):** any parameter whose value starts with `=` is an expression, e.g. `={{ $json.phone }}` or `=Hello {{ $json.name }}`. Phase 1 supports data references only: `$json.a.b[0]`, `$node["Name"].json.x`, `$('Name').item.json.x`, `$input.first()/last()/all()`, `$now`, `$today` (with `.toFormat('yyyy-MM-dd')`, `.toISO()` …), `$workflow`, `$execution`, `$itemIndex`, `$vars`. **Phase 2** replaces this with full JavaScript expressions in an isolated-vm sandbox behind the same `IExpressionEvaluator` interface.

**Server** (`apps/server`)

- Owner setup and sign-in (scrypt password hashes, JWT, rate-limited), Zod validation on every input with per-field error messages.
- Workflows: CRUD, search, optimistic locking (`versionId` → `409` when someone else saved first), **version history** with restore, import/export JSON, activation check.
- Executions: manual runs (also of unsaved editor state), live node events over WebSocket (`/api/push`), full history with per-node input/output, status filters, cursor pagination, stop, retry, delete. Executions left "running" by a crash are marked `crashed` on startup.
- Serves the built editor as a single-page app; `/healthz` and `/readyz` probes.

**Editor** (`apps/editor`)

- Infinite canvas with minimap, zoom controls, snap-to-grid, multi-select (Shift-drag box, Ctrl/Cmd-click), copy/paste as JSON, undo/redo, sticky notes (markdown, resizable, colours), searchable node panel (keyboard navigable).
- Add nodes from the `+` on any unconnected output, by dropping a connection on empty canvas, or by inserting into an existing connection.
- Node panel with **INPUT | PARAMETERS | OUTPUT** columns; Table / JSON / Schema views; **drag a field from INPUT into a parameter** to insert `{{ $json.field }}`; live expression preview; per-output tabs (true/false/error); pin output data; console.log output from Code nodes; node settings tab.
- Execute the whole workflow or a single step; live node status (running/success/error), item counts on connections and outputs; stop a running execution.
- Workflow list (search, active toggle, duplicate, export, import, delete), per-workflow executions tab with read-only replay of each run and "Debug in editor", global executions page with status filters, version history, workflow settings (timezone, timeout), dark/light/system theme, unsaved-changes guard.
- Handles 250+ nodes smoothly (about 55-60 fps while zooming; nodes outside the viewport aren't rendered for workflows with more than 150 nodes).

### Keyboard shortcuts

| Keys                                    | Action                                          |
| --------------------------------------- | ----------------------------------------------- |
| `Ctrl/⌘ S`                              | Save                                            |
| `Ctrl/⌘ Enter`                          | Execute workflow                                |
| `Tab`                                   | Open node panel (connects to the selected node) |
| `Enter`                                 | Open selected node                              |
| `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` / `Ctrl Y` | Undo / redo                                     |
| `Ctrl/⌘ C / X / V`                      | Copy / cut / paste nodes (JSON)                 |
| `Ctrl/⌘ A`, `Ctrl/⌘ D`                  | Select all, duplicate                           |
| `Delete` / `Backspace`                  | Delete selection                                |
| `D`                                     | Deactivate / activate selected nodes            |
| `Shift S`                               | Add sticky note                                 |
| `F2`                                    | Rename selected node                            |
| `1`, `0`, `+`, `-`                      | Fit view, reset zoom, zoom in/out               |
| `Shift`-drag                            | Box select                                      |

## What's in Phase 2

**JavaScript expressions.** `{{ }}` blocks are real JavaScript, evaluated on the server in an **isolated-vm** sandbox (one isolate per execution, 1 s timeout, 64 MB). Available: `$json`, `$input.item/first()/last()/all()`, `$('Node').item/first()/all()/itemMatching(i)`, `$node`, `$now`, `$today`, `DateTime` (Luxon), `$vars`, `$workflow`, `$execution` (incl. `resumeUrl`), `$itemIndex`, `$if()`, `$ifEmpty()`. `$('Node').item` follows **paired items** back through the graph, so it returns the item that produced the current one. In the editor, the expression editor has syntax highlighting and **autocomplete** (variables, node names, fields from the real input data). The live preview runs in a sandboxed, network-less iframe worker and is cut off after 1 s.

**New nodes:**

| Node                                                | What it does                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Webhook**                                         | Production URL `/webhook/<path>` (while active) and test URL `/webhook-test/<path>` (while "Listen for test event" is on). Any method; respond immediately, when the last node finishes, or from a Respond to Webhook node. |
| **Respond to Webhook**                              | Sends JSON, text, binary or no data, with status code and headers.                                                                                                                                                          |
| **Schedule Trigger**                                | Every N seconds/minutes/hours/days/weeks/months, or a cron expression, in the workflow timezone.                                                                                                                            |
| **Merge**                                           | Append, combine by matching fields, by position, all combinations, or choose a branch.                                                                                                                                      |
| **Switch**                                          | Rules or an expression; one output per rule, renamable, with an optional fallback output.                                                                                                                                   |
| **Loop Over Items**                                 | Processes items in batches, with `loop` and `done` outputs.                                                                                                                                                                 |
| **Wait**                                            | Pause for an interval, until a date, or until a webhook call (`$execution.resumeUrl`). Long waits are saved to the database and survive restarts.                                                                           |
| **Execute Workflow** / **Execute Workflow Trigger** | Sub-workflows: pass items in and get the results back.                                                                                                                                                                      |
| **Error Trigger**                                   | Starts an error workflow when a production execution fails.                                                                                                                                                                 |

**Credentials vault.** Header, Basic, query, Bearer and **OAuth2** credentials (authorization code with PKCE, or client credentials; tokens refresh automatically). They are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. Secrets are never sent back to the browser: they show as masked, and leaving them unchanged keeps the stored value. **Test** checks a credential against a URL. HTTP Request uses credentials through _Authentication → Generic credential type_.

**Execution.**

- **Queue mode:** `EXECUTIONS_MODE=queue` sends production runs through Redis (BullMQ) to any number of `worker` processes. Live events and cancel commands travel over Redis pub/sub.
- **Per-workflow concurrency limit.**
- **Error workflows** and **variables** (`$vars`, Variables page).
- **Partial execution:** "Execute step" reuses earlier results and re-runs only the nodes you changed.
- **Pinned data** can be edited as JSON. **Set mock data** can pin output to a node that hasn't run yet.

## Testing Phase 2

```bash
pnpm test        # 138 tests: workflow 22, engine 32, nodes 46, server 28, editor 10
pnpm --filter @flowforge/e2e test:e2e   # 8 browser tests (4 Phase 1 + 4 Phase 2)
```

The server suite includes queue mode with a real worker. It needs Redis on `REDIS_URL`, default `redis://localhost:6379`.

The Phase 2 browser tests check:

- Expression preview, autocomplete and that the sandbox has no storage or network.
- Credential masking.
- Webhook listening and activation.
- Switch outputs.

**Manual walkthrough:**

1. **Expressions:** add a _Code_ node returning `[{ json: { name: 'asha', price: 10, qty: 3 } }]`, then _Edit Fields_ with value `{{ $json.price * $json.qty }} for {{ $json.name.toUpperCase() }}`. Type `{{ $json.` to see autocomplete. The preview shows `30 for ASHA`.
2. **Webhook:** create a workflow with _Webhook_ (POST, path `hello`) → _Respond to Webhook_ (JSON `{{ { ok: true, got: $json.body } }}`), and set the Webhook to respond _Using 'Respond to Webhook' node_.
   - Click **Listen for test event**, then run `curl -X POST localhost:5678/webhook-test/hello -H 'content-type: application/json' -d '{"a":1}'`. The run appears on the canvas.
   - Save, toggle **Active**, and call `/webhook/hello`. The response is `{"ok":true,"got":{"a":1}}`, and the run is under **Executions**.
3. **Schedule:** add _Schedule Trigger_ (every 10 seconds) → _No-Op_, then activate. A new execution appears every 10 s. Deactivate it again.
4. **Credentials:**
   - **Credentials → Add credential → Header Auth** (`X-Api-Key` / any secret), then reopen it: the secret is masked.
   - In _HTTP Request_ with URL `https://httpbin.org/headers` and _Authentication: Generic → Header Auth_, choose the credential and run. httpbin echoes the header back.
5. **Switch / Loop / Merge / Wait:** build a Switch on `{{ $json.intent }}` with rules `sales` and `support` plus a fallback. Each output shows its item count. Add _Wait_ (2 minutes; waits over 65 s are saved to the database) and watch the execution sit in **waiting**, then finish.
6. **Error workflow:** create a workflow with _Error Trigger_ → _No-Op_. In another workflow's **Settings**, choose it as the _Error workflow_. When an active run of the second workflow fails, the error workflow runs with the error details.
7. **Queue mode:** `docker compose up -d --build` starts the server plus a `worker`. Production runs (webhook/schedule) then appear in the worker's logs: `docker compose logs -f worker`.

## What's in Phases 3–5: WhatsApp, calls and the AI voice agent

**Phase 3: WhatsApp Business.**

- **Connecting numbers:** customers click **Connect WhatsApp** and log in with Facebook (Meta Embedded Signup). The owner sets up the Meta app once, on the WhatsApp page or with `META_*` variables.
- **Webhook** at `/webhooks/whatsapp`, with verify token and `X-Hub-Signature-256` checks.
- **WhatsApp node:** text, templates, media, buttons, lists, location, reactions, mark as read, media download.
- **WhatsApp Trigger:** starts workflows on messages, statuses and calls.
- **Test numbers (simulator):** chat as the customer without a Meta account or any keys.

**Phase 4: WhatsApp voice calls.**

- Calls are answered over WebRTC by the server itself (werift + Opus).
- **Per-number modes:**
  - _ring in the app_: whoever answers in the browser, desktop or phone app is bridged to the caller;
  - _voicemail_: greeting + beep, recorded;
  - _decline_: sends a WhatsApp message instead;
  - _AI voice agent_.
- Business hours with timezone, ring time and a fallback when nobody answers.
- Call log with recordings (WAV) and transcripts.
- "Call started" / "call ended" workflow triggers.
- Test numbers can be **called from the browser** with your microphone.

**Phase 5: AI voice agent.** The agent answers calls 24/7.

- **Personas:** templates plus a persona builder; greeting; languages. Hindi, English and Hinglish are understood, and the agent replies in the caller's language.
- **Knowledge:** paste or upload price lists and FAQs. They are searched with BM25, which works in any script.
- **Two engines:**
  - **Realtime** (OpenAI Realtime, speech-to-speech): the lowest latency. When the caller interrupts, playback stops and the model is told how much of its reply was actually heard.
  - **Pipeline**: speech-to-text (OpenAI / Deepgram / Sarvam) → LLM (Claude `claude-opus-5-5` by default, OpenAI or Gemini) → voice (OpenAI / ElevenLabs / Sarvam). Replies are spoken sentence by sentence while the LLM writes, and the caller can interrupt at any time.
- **Tools:**
  - search knowledge;
  - transfer to a person (rings the app with a ringback tone, then the person takes over);
  - end the call;
  - send the caller a WhatsApp message;
  - **your workflows as tools** (book in a calendar, check an order…) through an _Execute Workflow Trigger_.
- **Caller recognition:** the agent knows returning callers from earlier calls and chats.
- **After each call:** a summary in the call log, in "call ended" workflows, and optionally on your WhatsApp.
- **Test chat:** talk to the agent in text with the same persona, knowledge and tools.
- **Fallback:** without working keys, calls go to voicemail instead of failing.
- **Keys:** AI keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `SARVAM_API_KEY`) come from the server environment, or are built into your private app (see _Private build_). Otherwise enter them in **AI agents → AI providers**, where they are stored encrypted. They never reach the apps or browsers.

> Claude requests use `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`): if Claude declines a request, the API retries it on Anthropic's recommended fallback model instead of failing the call. They also use `output_config.effort: "low"` for fast voice replies.

## Testing Phases 3–5

```bash
pnpm test        # workflow 22, engine 32, nodes 57, media 5, server 59, editor 10, website 18, desktop 7
```

- **Real calls in the tests.** The server suite runs real calls over WebRTC on localhost. It uses a local STUN responder, a fake Graph API for Meta, and fake AI providers (`apps/server/test/fakeAi.ts`).
- **How the fake speech works.** "Speech" is encoded as tone pitch: the caller plays 400 Hz and the fake speech-to-text hears _"What is the price of a haircut?"_.
- **What the AI tests cover:**
  - greeting;
  - knowledge lookup with tool use (Claude's thinking blocks are passed back unchanged);
  - hang-up, summary and the owner's WhatsApp note;
  - realtime barge-in truncation;
  - transfer to a person;
  - workflows as tools;
  - the voicemail fallback.

**Browser tests (15)** need a running server pointed at the fake providers:

```bash
cd apps/server && npx tsx test/fake-ai-server.ts &          # fake AI on :5700
F=http://127.0.0.1:5700 OPENAI_BASE_URL=$F/v1 ANTHROPIC_BASE_URL=$F DEEPGRAM_BASE_URL=$F \
  ELEVENLABS_BASE_URL=$F SARVAM_BASE_URL=$F pnpm --filter @flowforge/server start   # built server + editor
pnpm --filter @flowforge/e2e test:e2e
```

**Manual walkthrough with real keys (about 10 minutes):**

1. **WhatsApp page → Add test number → Open simulator.** Build a workflow _WhatsApp Trigger → WhatsApp (send text "Hi {{ $json.contactName }}!")_, activate it, and type "hello" as the customer. The reply arrives with ✓✓ ticks.
2. **Calls without AI:** on the test number click **Calls** and choose _Ring in FlowForge_. Press **Call** in the simulator; the call rings at the bottom right. **Answer** and talk: open the app in a second browser or the desktop app to hear both sides. Then hang up and find the call and its recording under **Calls**. Try _Voicemail_ the same way.
3. **AI keys:** **AI agents → AI providers.** Paste an OpenAI key (enough for everything) and/or an Anthropic key. Your private app build already has them.
4. **Agent:** **New agent → Receptionist**, then **Persona builder** (your business name). In **Knowledge**, write your price list and use **Try a search**. In **Test chat**, ask "what does a haircut cost?". The tool call shows above the reply.
5. **Voice:** set the test number's **Calls** to _AI voice agent_, pick the agent, then **Call** from the simulator and talk. Try Hindi or Hinglish, interrupt the agent mid-sentence, ask for "a human" (it rings the app; answer to take over), and say "bye". The call log shows the transcript and summary.
6. **Workflow tool:** create a workflow _Execute Workflow Trigger → Code_ (`return [{ json: { booking: 'B-1', day: $json.day } }]`). In the agent's **Tools**, add it as `book_appointment` with the detail `day`, then ask the agent to book.
7. **Real number:** connect your number with **Connect WhatsApp**, enable calling in its **Calls** settings, and call it from your phone. It needs `PUBLIC_URL` reachable from the internet and UDP ports open for audio (`MEDIA_PORT_RANGE`, plus `MEDIA_PUBLIC_IP` behind NAT).

## Deployment

FlowForge has two kinds of parts:

- **Static parts** can be hosted on Vercel: the editor (`apps/editor`) and the download website (`apps/website`).
- **Long-running parts** need a host that keeps processes running: the **server** (webhooks, schedules, WebSockets), the **worker** and, from Phase 4, the **media server**. Vercel can't run these because its functions stop after each request. Use Railway, Render, Fly.io or any VPS with `docker compose`.

The simplest production setup:

1. **Server:** deploy `docker/Dockerfile.server` (Railway/Render/Fly) or run `docker compose up -d` on a VPS.
   - Set `DATABASE_URL` (e.g. Neon/Supabase Postgres), `REDIS_URL` (e.g. Upstash, needed for queue mode), `JWT_SECRET`, `ENCRYPTION_KEY` and `PUBLIC_URL`.
   - The server also serves the editor, so this alone is a complete deployment.
2. **Optional: editor on Vercel.**
   - Import the repo with **Root Directory** `apps/editor` (`vercel.json` is included).
   - Set `VITE_DEFAULT_SERVER_URL=https://your-server.example.com`.
   - Add the Vercel URL to the server's `CORS_ORIGINS`.
3. **Download website on Vercel:** see [Windows app & download website](#windows-app--download-website).

## Windows app & download website

### The Windows app (`apps/desktop`)

The installer contains everything FlowForge needs, so it runs on any Windows 10/11 PC **without API keys, accounts or a server**:

- A private **PostgreSQL**. It is created on first start in `%APPDATA%\FlowForge\database`, listens on 127.0.0.1 only and is password-protected. It starts through `pg_ctl`, so it also works for administrator users.
- The **FlowForge server and editor**, running on a bundled Node.js at `http://localhost:5678`. If that port is taken, a free one is used.
- **Secrets are generated** on first start (`%APPDATA%\FlowForge\secrets.json`): the JWT secret, the credentials encryption key and the database password. Nobody has to create or paste a key.
- **Tray app:**
  - Closing the window keeps workflows running.
  - Optional _Start with Windows_ (on by default).
  - _Open in browser_, _Open logs folder_ and _Quit_.
  - If the server stops unexpectedly, the window shows the error with _Try again_.
- **Auto-update** from this repository's GitHub Releases (electron-updater, no token).
- **Installer:** one-click, per user (no admin prompt), into `%LOCALAPPDATA%\Programs\flowforge`. The installer and uninstaller stop the app, its server and PostgreSQL first. Uninstalling keeps your data folder.

The installer is about 150 MB: Electron, Node.js, PostgreSQL and the server.

**Build it:** the **Windows app** workflow (`.github/workflows/desktop.yml`) runs on every push that touches the app, on a `windows-latest` runner:

1. Builds the app and bundles the runtime (`scripts/prepare-resources.mjs`).
2. Runs a smoke test of the bundled runtime: database, migrations, sign-up, a workflow with a Code node and an expression, an encrypted credential, then a restart.
3. Builds `FlowForge-Setup.exe`.
4. **Installs it silently, launches it, checks the editor and API, and uninstalls it.**

The installer is attached to the run as an artifact.

**Publish a release:** _Actions → Windows app → Run workflow_ with a version (e.g. `0.3.0`), or push a tag `v0.3.0`. The workflow creates the GitHub Release using only the built-in `GITHUB_TOKEN`. It attaches:

- `FlowForge-Setup.exe`
- `latest.yml` and the `.blockmap`, for auto-update
- `release.json`, for the website
- `SHA256SUMS.txt`

> **Private repository? Fine.** Set it up once as described in [Private build](#private-build-your-keys-built-in). You add your keys as GitHub secrets, CI builds them into your installer, and it updates itself from the private releases.

**Develop locally:**

```bash
pnpm --filter @flowforge/desktop resources   # bundle Node, server, editor, PostgreSQL for this OS
pnpm --filter @flowforge/desktop smoke       # start the runtime with plain Node and run the checks
pnpm --filter @flowforge/desktop start       # open the Electron app
pnpm --filter @flowforge/desktop test        # unit tests
```

On Linux, PostgreSQL refuses to run as root, so run the smoke test as a regular user.

### Private build (your keys built in)

For your own private use, the app can carry your keys, so nothing has to be typed into it.

1. **Repository secrets.** In GitHub, go to _Settings → Secrets and variables → Actions → New repository secret_. Add the ones you have; missing ones are simply skipped.

   | Secret                                                                                                              | Used for                                                                                                                       |
   | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
   | `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`                                                  | WhatsApp: your Meta app (one-click "Connect WhatsApp")                                                                         |
   | `WHATSAPP_WEBHOOK_VERIFY_TOKEN`                                                                                     | Optional fixed verify token for the Meta webhook                                                                               |
   | `PUBLIC_URL`                                                                                                        | Public HTTPS address of the app's server (e.g. a tunnel), needed for Meta to deliver messages                                  |
   | `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `SARVAM_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | AI voice agent providers (Phase 5)                                                                                             |
   | `UPDATE_GITHUB_TOKEN`                                                                                               | Lets the app auto-update from your **private** releases. Use a fine-grained token, this repository only, _Contents: Read-only_ |

2. **Build.** Run _Actions → Windows app → Run workflow_ with a version.
   - The build writes the secrets into `resources/runtime/config.json` inside the installer.
   - The app's server reads them as environment variables, which take precedence over anything entered on the WhatsApp page.
3. **Download.** Get the installer from the private GitHub Release while signed in, or from your own download site (next step).
4. **Your download site (optional).** Deploy `apps/website` on Vercel with two environment variables:
   - `RELEASES_GITHUB_TOKEN`: the same kind of read-only token, kept server-side. The site hands out short-lived signed download links, never the token.
   - `SITE_PASSWORD`: protects the whole site, because the installer contains your keys.

> **Treat the installer like a password.** Anyone who has the file can extract the keys inside it, so keep the repository, its releases and the site private. If a copy leaks, rotate the keys in Meta, OpenAI and the other providers, then build again.

### The download website (`apps/website`)

A Next.js site with a landing page and a download page. The download page:

- Detects the visitor's OS. Windows gets the button; macOS/Linux/Android/iOS visitors get a note that their platform is coming.
- Shows version, date, size and **SHA-256** (copy button plus the PowerShell command to verify it).
- Shows release notes, install steps, a SmartScreen explanation, an FAQ and a QR code.
- Supports dark and light themes.

**It needs no API keys or secrets.**

- Release data comes from `https://github.com/<repo>/releases/latest/download/release.json`. This is a plain public file download, not the GitHub API, so there is no token and no rate limit. If it's missing, the site falls back to the public releases API.
- Pages are static and re-check every 5 minutes, so a new release shows up on its own.
- `GET /api/releases/latest` returns the release as JSON. `/download/windows` always redirects to the newest installer.
- Before the first public release, the button explains that the release is on its way.

**Deploy on Vercel:**

1. _Add New → Project_, then import this repository.
2. Set **Root Directory** to `apps/website`. The framework is detected as Next.js.
3. Deploy. **No environment variables are needed.**
   - Optional: `FLOWFORGE_RELEASES_REPO=owner/name` to read releases from another (public) repository.
   - Optional: `RELEASE_MANIFEST_URL` to point at a `release.json` hosted anywhere.

**Develop and test locally:**

```bash
pnpm --filter @flowforge/website dev     # http://localhost:3000
pnpm --filter @flowforge/website test    # release parsing/fallbacks, OS detection, release-notes rendering
pnpm --filter @flowforge/website build
```

### Testing the Windows app and website

1. Push to any branch, then open _Actions → Windows app_. All steps should be green. "Install, launch and uninstall" proves the installer works on a clean Windows machine.
2. Download the `FlowForge-Windows-…` artifact on a Windows PC and run `FlowForge-Setup.exe`.
   - SmartScreen will say "Windows protected your PC" because the build is unsigned. Choose _More info → Run anyway_.
   - FlowForge opens by itself. Create the owner account, build a workflow, and close the window. The tray icon remains, and an active schedule keeps running.
   - Right-click the tray icon to try _Open in browser_, _Start with Windows_ and _Quit FlowForge_.
3. Run _Actions → Windows app → Run workflow_ with version `0.2.0` (with your secrets set for a private build). A release `v0.2.0` appears with the installer and `release.json`.
4. Deploy `apps/website` on Vercel and open `/download`.
   - Version, size and SHA-256 match the release. Compare with `Get-FileHash .\FlowForge-Setup.exe -Algorithm SHA256`.
   - On a phone you get the "coming soon" note, and on a desktop the QR code.
5. Publish `0.2.1` the same way. The installed app downloads it in the background, and the tray menu offers _Restart to install version 0.2.1_.

## Running locally

Requirements: Node 22+, pnpm 10, PostgreSQL 16, and Redis 7 (only for queue mode and its tests).

```bash
pnpm install
cp .env.example .env                  # set DATABASE_URL, JWT_SECRET and ENCRYPTION_KEY (openssl rand -hex 32)
cp .env apps/server/.env              # Prisma CLI reads apps/server/.env
pnpm db:deploy                        # apply migrations

pnpm dev                              # server on :5678, editor (Vite) on :5173
```

Open http://localhost:5173 (dev) and create the owner account. Or build the editor once (`pnpm --filter @flowforge/editor build`); the server then serves it at http://localhost:5678.

### Self-hosting with Docker

```bash
cp .env.example .env    # set JWT_SECRET, ENCRYPTION_KEY and POSTGRES_PASSWORD
docker compose up -d --build
```

Open http://localhost:5678. The image runs migrations on start and has a health check on `/readyz`. Production executions run on the `worker` service (`docker compose up -d --scale worker=3` for more).

### Configuration

| Variable                                     | Default                 | Description                                                                                                 |
| -------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                               | –                       | PostgreSQL connection URL (required)                                                                        |
| `JWT_SECRET`                                 | –                       | At least 32 characters (required)                                                                           |
| `ENCRYPTION_KEY`                             | –                       | Encrypts credentials; required in production. Keep it safe, since credentials can't be decrypted without it |
| `EXECUTIONS_MODE`                            | `regular`               | `queue` hands production runs to workers via Redis                                                          |
| `REDIS_URL`                                  | –                       | Redis connection URL (required for queue mode)                                                              |
| `WORKER_CONCURRENCY`                         | `10`                    | Parallel executions per worker                                                                              |
| `WEBHOOK_TIMEOUT_MS` / `WEBHOOK_MAX_BODY_MB` | `120000` / `16`         | Webhook response timeout and body size                                                                      |
| `PORT` / `HOST`                              | `5678` / `0.0.0.0`      | Listen address                                                                                              |
| `PUBLIC_URL`                                 | `http://localhost:5678` | Public URL (webhooks, links)                                                                                |
| `CORS_ORIGINS`                               | –                       | Comma-separated browser origins allowed to call the API (e.g. the Vite dev server)                          |
| `JWT_EXPIRES_IN`                             | `7d`                    | Session length                                                                                              |
| `DEFAULT_TIMEZONE`                           | `UTC`                   | Default for workflows without a timezone                                                                    |
| `CODE_TIMEOUT_MS` / `CODE_MEMORY_MB`         | `30000` / `128`         | Code node sandbox limits                                                                                    |
| `AUTH_RATE_LIMIT`                            | `10`                    | Sign-in attempts per IP per minute                                                                          |
| `EDITOR_DIST`                                | auto                    | Folder with the built editor                                                                                |
| `LOG_LEVEL`                                  | `info`                  | pino log level                                                                                              |

## Testing Phase 1

### Automated

```bash
# Unit + integration tests (needs PostgreSQL; uses a separate *_test database)
createdb flowforge_test        # once
pnpm test                      # 93 tests across workflow, engine, nodes, server, editor
pnpm typecheck
```

| Suite                    | What it covers                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workflow` (21) | Graph indexing and ordering, schemas, expressions, filter operators and type checks, parameter defaults/visibility                                                                                |
| `packages/engine` (21)   | Linear/branching order, multi-input waits, empty outputs, retries, continue-on-fail, error output, pinned data, execute step, cancel, timeout, loop protection, resume/retry, hooks, clear errors |
| `packages/nodes` (29)    | Every core node, the Code sandbox (isolation, line numbers, infinite loops), HTTP Request against a local server (JSON/text/binary, 404, network errors)                                          |
| `apps/server` (14)       | Owner setup, sign-in, auth guard, rate limiting, CRUD, optimistic locking, versions, graph validation, import/export, runs, history, retry, stop, WebSocket events, crash recovery                |
| `apps/editor` (8)        | Editor store: add/connect, undo/redo, rename with expression rewrite, paste, delete with reconnect, live status                                                                                   |

The server tests use `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/flowforge_test`) and refuse to run against a database whose name doesn't end in `_test`.

Browser tests (Playwright) against a running server:

```bash
pnpm --filter @flowforge/editor build && pnpm --filter @flowforge/server build
node apps/server/dist/index.js &                  # with DATABASE_URL / JWT_SECRET set
pnpm --filter @flowforge/e2e exec playwright install chromium
pnpm --filter @flowforge/e2e test:e2e
# Existing instance? Pass its owner: E2E_EMAIL=... E2E_PASSWORD=... (FLOWFORGE_URL to target another server)
```

These tests build, run and inspect a workflow (including execution history and "Debug in editor"); drag a field from INPUT into a parameter and check the preview and output; test undo/redo, copy/paste, delete and sticky notes; and render and run a 250-node workflow.

### Manual walkthrough (about 5 minutes)

1. Open the app and **create the owner account** (the password needs 8+ characters, an uppercase letter and a number).
2. **Create workflow** → **Add first step** → _Manual Trigger_.
3. Click the **+** on the trigger's output → _HTTP Request_ → URL `https://jsonplaceholder.typicode.com/users` → **Execute step**. The OUTPUT panel shows 10 items (arrays become items).
4. Close the panel. Click **+** after HTTP Request → _If_. Drag `address` → `city` from the INPUT **Schema** view into _value1_. Choose _String: is equal to_, value2 `Gwenborough`. The preview under the field shows the resolved value.
5. **Execute workflow** (`Ctrl+Enter`). Nodes turn green, connections show item counts, and the If node shows `true · 1 item` / `false · 9 items`.
6. Add a _Code_ node on the false branch with `return [{ json: { count: $input.all().length } }];` and run again. Add `console.log('hi')` and look for the log line under OUTPUT.
7. Break something: set the HTTP URL to `https://jsonplaceholder.typicode.com/nope`. Running shows a red node and the error "The resource you are requesting could not be found" with HTTP 404. Open the node → **Settings** → _On Error: Continue (using error output)_ and see the red **error** output appear.
8. **Save** (`Ctrl+S`). Open the **Executions** tab: every run is listed and clicking one replays it read-only with all node data. Use **Retry** on the failed run and **Debug in editor** to load its data back onto the canvas.
9. Select nodes (Shift-drag), `Ctrl+C`, `Ctrl+V`, `Ctrl+Z`, `Ctrl+Shift+Z`; add a sticky note with `Shift+S`; toggle the theme in the sidebar.
10. Workflow menu (`…`): **Download JSON**, then on the Workflows page use **Import** to bring it back. Open **Version history** and restore an earlier version.

## API

All endpoints except `/api/auth/status|setup|login` need `Authorization: Bearer <token>`.

| Method & path                                                                                       | Description                                                                                         |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/auth/status`                                                                              | `{ setupRequired, version }`                                                                        |
| `POST /api/auth/setup` · `POST /api/auth/login` · `GET /api/auth/me`                                | Owner setup, sign-in, current user                                                                  |
| `GET /api/node-types`                                                                               | Node descriptions (the editor renders forms from these)                                             |
| `GET/POST /api/workflows`, `GET/PATCH/DELETE /api/workflows/:id`                                    | Workflows (PATCH accepts `versionId` for conflict detection)                                        |
| `POST /api/workflows/import`, `GET /api/workflows/:id/export`                                       | JSON import/export                                                                                  |
| `GET /api/workflows/:id/versions[/:versionId]`                                                      | Version history                                                                                     |
| `POST /api/workflows/:id/run`                                                                       | Manual run `{ workflowData?, destinationNode?, startNode?, triggerItems? }` → `202 { executionId }` |
| `GET /api/executions?workflowId=&status=error,crashed&cursor=&limit=`                               | Execution history                                                                                   |
| `GET/DELETE /api/executions/:id`, `POST /api/executions/:id/stop`, `POST /api/executions/:id/retry` | Details with per-node data, stop, retry `{ useCurrentWorkflow }`                                    |
| `WS /api/push?token=`                                                                               | Live events; send `{ "type": "subscribe", "topic": "workflow:<id>" }`                               |
| `GET/POST /api/credentials`, `GET/PATCH/DELETE /api/credentials/:id`, `POST /api/credentials/test`  | Credentials (secrets masked)                                                                        |
| `GET /api/credential-types`                                                                         | Credential type descriptions                                                                        |
| `GET/POST /api/variables`, `PATCH/DELETE /api/variables/:id`                                        | Variables                                                                                           |
| `POST/DELETE /api/workflows/:id/webhook-test`                                                       | Start/stop listening for a test webhook                                                             |
| `ANY /webhook/<path>`, `/webhook-test/<path>`, `/webhook-waiting/<executionId>`                     | Webhook triggers and Wait resumes (no auth)                                                         |

The public REST API with API keys comes in Phase 6.

## Writing a node

```ts
import type { IExecuteFunctions, INodeType } from '@flowforge/workflow';

export const Greet: INodeType = {
  description: {
    name: 'acme.greet',
    displayName: 'Greet',
    icon: 'smile',
    group: ['transform'],
    version: 1,
    description: 'Adds a greeting',
    defaults: { name: 'Greet' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      { displayName: 'Name', name: 'name', type: 'string', default: '={{ $json.name }}' },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      this.getInputData().map((item, i) => ({
        json: { ...item.json, greeting: `Hello ${this.getNodeParameter('name', i)}` },
        pairedItem: { item: i },
      })),
    ];
  },
};
```

Register it in `packages/nodes/src/index.ts` (`builtinNodes`). The editor renders the parameter form from `properties` automatically.
