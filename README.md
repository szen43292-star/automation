# FlowForge

Workflow automation platform (n8n-style) whose core feature will be **answering WhatsApp Business calls with an AI voice agent, 24/7**. Web editor, Windows/Android/iOS apps and a download site come in later phases.

> **Status: Phase 1 complete.** The server, database, workflow engine, editor canvas, core nodes and execution history work and have tests. The phases below are built in order.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Server, database, workflow engine, editor canvas, core nodes, execution history | ✅ Done |
| 2 | Expressions (isolated-vm), Merge/Switch/Loop, pinned data UI, queue + workers, Webhook & Schedule triggers, credentials vault | ⏳ Next |
| 3 | WhatsApp Business connection, setup checklist, messaging nodes and triggers | |
| 4 | Media server, incoming call handling, auto-answer modes, call log and recordings | |
| 5 | AI Voice Agent, knowledge base, tool calling, caller recognition, transfer, follow-ups, owner notifications | |
| 6 | Outbound calls with permissions, live dashboard, analytics, integrations, templates, users/roles, public API | |
| 7 | Windows `.exe`, Android `.apk`, sideloadable iOS `.ipa` | |
| 8 | Download website, release admin, CI/CD for all platforms | |

## Monorepo layout

```
apps/
  server/      Fastify API + execution engine host, Prisma/PostgreSQL, WebSocket push
  editor/      React + Vite + React Flow editor (later shared by desktop & mobile)
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

| Keys | Action |
| --- | --- |
| `Ctrl/⌘ S` | Save |
| `Ctrl/⌘ Enter` | Execute workflow |
| `Tab` | Open node panel (connects to the selected node) |
| `Enter` | Open selected node |
| `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` / `Ctrl Y` | Undo / redo |
| `Ctrl/⌘ C / X / V` | Copy / cut / paste nodes (JSON) |
| `Ctrl/⌘ A`, `Ctrl/⌘ D` | Select all, duplicate |
| `Delete` / `Backspace` | Delete selection |
| `D` | Deactivate / activate selected nodes |
| `Shift S` | Add sticky note |
| `F2` | Rename selected node |
| `1`, `0`, `+`, `-` | Fit view, reset zoom, zoom in/out |
| `Shift`-drag | Box select |

## Running locally

Requirements: Node 22+, pnpm 10, PostgreSQL 16 (Redis comes in Phase 2).

```bash
pnpm install
cp .env.example .env                  # set DATABASE_URL and JWT_SECRET (openssl rand -hex 32)
cp .env apps/server/.env              # Prisma CLI reads apps/server/.env
pnpm db:deploy                        # apply migrations

pnpm dev                              # server on :5678, editor (Vite) on :5173
```

Open http://localhost:5173 (dev) and create the owner account. Or build the editor once (`pnpm --filter @flowforge/editor build`); the server then serves it at http://localhost:5678.

### Self-hosting with Docker

```bash
cp .env.example .env    # set JWT_SECRET and POSTGRES_PASSWORD
docker compose up -d --build
```

Open http://localhost:5678. The image runs migrations on start and has a health check on `/readyz`.

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | – | PostgreSQL connection URL (required) |
| `JWT_SECRET` | – | At least 32 characters (required) |
| `PORT` / `HOST` | `5678` / `0.0.0.0` | Listen address |
| `PUBLIC_URL` | `http://localhost:5678` | Public URL (webhooks, links) |
| `CORS_ORIGINS` | – | Comma-separated browser origins allowed to call the API (e.g. the Vite dev server) |
| `JWT_EXPIRES_IN` | `7d` | Session length |
| `DEFAULT_TIMEZONE` | `UTC` | Default for workflows without a timezone |
| `CODE_TIMEOUT_MS` / `CODE_MEMORY_MB` | `30000` / `128` | Code node sandbox limits |
| `AUTH_RATE_LIMIT` | `10` | Sign-in attempts per IP per minute |
| `EDITOR_DIST` | auto | Folder with the built editor |
| `LOG_LEVEL` | `info` | pino log level |

## Testing Phase 1

### Automated

```bash
# Unit + integration tests (needs PostgreSQL; uses a separate *_test database)
createdb flowforge_test        # once
pnpm test                      # 93 tests across workflow, engine, nodes, server, editor
pnpm typecheck
```

| Suite | What it covers |
| --- | --- |
| `packages/workflow` (21) | Graph indexing and ordering, schemas, expressions, filter operators and type checks, parameter defaults/visibility |
| `packages/engine` (21) | Linear/branching order, multi-input waits, empty outputs, retries, continue-on-fail, error output, pinned data, execute step, cancel, timeout, loop protection, resume/retry, hooks, clear errors |
| `packages/nodes` (29) | Every core node, the Code sandbox (isolation, line numbers, infinite loops), HTTP Request against a local server (JSON/text/binary, 404, network errors) |
| `apps/server` (14) | Owner setup, sign-in, auth guard, rate limiting, CRUD, optimistic locking, versions, graph validation, import/export, runs, history, retry, stop, WebSocket events, crash recovery |
| `apps/editor` (8) | Editor store: add/connect, undo/redo, rename with expression rewrite, paste, delete with reconnect, live status |

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
2. **Create workflow** → **Add first step** → *Manual Trigger*.
3. Click the **+** on the trigger's output → *HTTP Request* → URL `https://jsonplaceholder.typicode.com/users` → **Execute step**. The OUTPUT panel shows 10 items (arrays become items).
4. Close the panel. Click **+** after HTTP Request → *If*. Drag `address` → `city` from the INPUT **Schema** view into *value1*. Choose *String: is equal to*, value2 `Gwenborough`. The preview under the field shows the resolved value.
5. **Execute workflow** (`Ctrl+Enter`). Nodes turn green, connections show item counts, and the If node shows `true · 1 item` / `false · 9 items`.
6. Add a *Code* node on the false branch with `return [{ json: { count: $input.all().length } }];` and run again. Add `console.log('hi')` and look for the log line under OUTPUT.
7. Break something: set the HTTP URL to `https://jsonplaceholder.typicode.com/nope`. Running shows a red node and the error "The resource you are requesting could not be found" with HTTP 404. Open the node → **Settings** → *On Error: Continue (using error output)* and see the red **error** output appear.
8. **Save** (`Ctrl+S`). Open the **Executions** tab: every run is listed and clicking one replays it read-only with all node data. Use **Retry** on the failed run and **Debug in editor** to load its data back onto the canvas.
9. Select nodes (Shift-drag), `Ctrl+C`, `Ctrl+V`, `Ctrl+Z`, `Ctrl+Shift+Z`; add a sticky note with `Shift+S`; toggle the theme in the sidebar.
10. Workflow menu (`…`): **Download JSON**, then on the Workflows page use **Import** to bring it back. Open **Version history** and restore an earlier version.

## API (Phase 1)

All endpoints except `/api/auth/status|setup|login` need `Authorization: Bearer <token>`.

| Method & path | Description |
| --- | --- |
| `GET /api/auth/status` | `{ setupRequired, version }` |
| `POST /api/auth/setup` · `POST /api/auth/login` · `GET /api/auth/me` | Owner setup, sign-in, current user |
| `GET /api/node-types` | Node descriptions (the editor renders forms from these) |
| `GET/POST /api/workflows`, `GET/PATCH/DELETE /api/workflows/:id` | Workflows (PATCH accepts `versionId` for conflict detection) |
| `POST /api/workflows/import`, `GET /api/workflows/:id/export` | JSON import/export |
| `GET /api/workflows/:id/versions[/:versionId]` | Version history |
| `POST /api/workflows/:id/run` | Manual run `{ workflowData?, destinationNode?, startNode?, triggerItems? }` → `202 { executionId }` |
| `GET /api/executions?workflowId=&status=error,crashed&cursor=&limit=` | Execution history |
| `GET/DELETE /api/executions/:id`, `POST /api/executions/:id/stop`, `POST /api/executions/:id/retry` | Details with per-node data, stop, retry `{ useCurrentWorkflow }` |
| `WS /api/push?token=` | Live events; send `{ "type": "subscribe", "topic": "workflow:<id>" }` |

The public REST API with API keys comes in Phase 6.

## Writing a node

```ts
import type { IExecuteFunctions, INodeType } from '@flowforge/workflow';

export const Greet: INodeType = {
  description: {
    name: 'acme.greet', displayName: 'Greet', icon: 'smile', group: ['transform'], version: 1,
    description: 'Adds a greeting', defaults: { name: 'Greet' },
    inputs: [{ type: 'main' }], outputs: [{ type: 'main' }],
    properties: [{ displayName: 'Name', name: 'name', type: 'string', default: '={{ $json.name }}' }],
  },
  async execute(this: IExecuteFunctions) {
    return [this.getInputData().map((item, i) => ({
      json: { ...item.json, greeting: `Hello ${this.getNodeParameter('name', i)}` },
      pairedItem: { item: i },
    }))];
  },
};
```

Register it in `packages/nodes/src/index.ts` (`builtinNodes`). The editor renders the parameter form from `properties` automatically.
