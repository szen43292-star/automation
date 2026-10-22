import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/auth';
import { parse } from '../lib/errors';
import type { ApprovalService } from '../approvals/ApprovalService';
import type { PhoneService } from './PhoneService';

const tokenParams = z.object({ token: z.string().min(1).max(100) });
const runParams = tokenParams.extend({ workflowId: z.string().min(1).max(100) });
const updateBody = z.object({ workflowIds: z.array(z.string().min(1).max(100)).max(200) });

/** The phone page: the chosen workflows with a Run button, their last result, open approvals. */
export function phonePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>AutoForge</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--fg:#1b1f27;--muted:#5f6b7a;--line:#e3e6eb;--accent:#ea580c;--ok:#16a34a;--no:#dc2626;--wait:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaee;--muted:#9aa3af;--line:#2a2f37}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}
h1{font-size:20px;margin:4px 0 2px}.sub{color:var(--muted);font-size:13px;margin:0 0 16px}
h2{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:20px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
.name{flex:1;min-width:0}.name b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{font-size:13px;color:var(--muted)}.status.success{color:var(--ok)}.status.error,.status.crashed{color:var(--no)}.status.running,.status.new,.status.waiting{color:var(--wait)}
button{border:0;border-radius:10px;padding:12px 18px;font:600 16px system-ui,sans-serif;color:#fff;background:var(--accent);cursor:pointer}
button:disabled{opacity:.5}a.card{text-decoration:none;color:inherit}
.empty{color:var(--muted);font-size:14px;padding:8px 2px}
#toast{position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));max-width:448px;margin:0 auto;background:#1b1f27;color:#fff;padding:12px 14px;border-radius:12px;font-size:14px;display:none}
</style></head><body><main>
<h1>AutoForge</h1><p class="sub">Run your workflows from here. Add this page to your home screen.</p>
<div id="approvals"></div>
<h2>Workflows</h2><div id="workflows"><p class="empty">Loading…</p></div>
<div id="toast"></div>
</main>
<script>
var base = location.pathname.replace(/\\/$/, '');
var labels = { success: 'Finished', error: 'Failed', crashed: 'Failed', canceled: 'Stopped', running: 'Running…', new: 'Starting…', waiting: 'Waiting (e.g. for your approval)' };
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function when(iso) { if (!iso) return ''; var d = new Date(iso); return ' · ' + d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function toast(text) { var t = document.getElementById('toast'); t.textContent = text; t.style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.style.display = 'none'; }, 4000); }
function render(data) {
  var a = document.getElementById('approvals');
  a.innerHTML = data.approvals.length ? '<h2>Waiting for your approval</h2>' + data.approvals.map(function (x) {
    return '<a class="card" href="/approve/' + encodeURIComponent(x.id) + '"><div class="name"><b>' + esc(x.title) + '</b><span class="status waiting">Tap to watch and approve</span></div></a>';
  }).join('') : '';
  var w = document.getElementById('workflows');
  if (!data.workflows.length) { w.innerHTML = '<p class="empty">No workflows yet. On your PC, open AutoForge → Settings → Phone and pick the workflows to show here.</p>'; return; }
  w.innerHTML = data.workflows.map(function (x) {
    var s = x.last ? x.last.status : '';
    var busy = s === 'running' || s === 'new';
    var line = x.last ? (labels[s] || s) + when(x.last.stoppedAt || x.last.startedAt) : 'Not run yet';
    return '<div class="card"><div class="name"><b>' + esc(x.name) + '</b><span class="status ' + esc(s) + '">' + esc(line) + '</span></div>' +
      '<button data-id="' + esc(x.id) + '"' + (busy ? ' disabled' : '') + '>Run</button></div>';
  }).join('');
}
function refresh() {
  fetch(base + '/status').then(function (r) { return r.json(); }).then(render).catch(function () {
    document.getElementById('workflows').innerHTML = '<p class="empty">Could not reach AutoForge - is the PC on?</p>';
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('button[data-id]'); if (!b) return;
  b.disabled = true;
  fetch(base + '/' + encodeURIComponent(b.getAttribute('data-id')), { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (r) { toast(r.message); refresh(); })
    .catch(function () { toast('Could not reach AutoForge - is the PC on?'); b.disabled = false; });
});
refresh(); setInterval(refresh, 5000);
</script></body></html>`;
}

/** Public phone page (the secret link is the permission; see PhoneService). */
export async function phonePublicRoutes(
  app: FastifyInstance,
  opts: { phone: PhoneService; approvals: ApprovalService },
) {
  const { phone, approvals } = opts;
  const notFound = (reply: FastifyReply) =>
    reply
      .status(404)
      .type('text/html')
      .send(
        '<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">This link is not valid any more. Scan the new QR code in AutoForge → Settings → Phone.</p>',
      );

  app.get('/run/:token', async (request, reply) => {
    const { token } = parse(tokenParams, request.params);
    if (!(await phone.open(token))) return notFound(reply);
    return reply
      .type('text/html')
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex')
      .send(phonePage());
  });

  app.get('/run/:token/status', async (request, reply) => {
    const { token } = parse(tokenParams, request.params);
    const settings = await phone.open(token);
    if (!settings) return reply.status(404).send({ message: 'This link is not valid any more.' });
    const pending = await approvals.list({ pendingOnly: true, limit: 20 });
    return reply.header('cache-control', 'no-store').send({
      workflows: await phone.workflows(settings),
      approvals: pending.map((a) => ({ id: a.id, title: a.title })),
    });
  });

  app.post('/run/:token/:workflowId', async (request, reply) => {
    const { token, workflowId } = parse(runParams, request.params);
    const settings = await phone.open(token);
    if (!settings)
      return reply.status(404).send({ ok: false, message: 'This link is not valid any more.' });
    const result = await phone.run(settings, workflowId);
    return reply.status(result.ok ? 202 : 409).send(result);
  });
}

/** Signed-in API: Settings → Phone (one link for this AutoForge, set up by an owner or admin). */
export async function phoneApiRoutes(app: FastifyInstance, opts: { phone: PhoneService }) {
  const { phone } = opts;
  const admin = { onRequest: requireRole('owner', 'admin') };
  app.get('/api/phone', admin, async () => phone.info());
  app.put('/api/phone', admin, async (request) => {
    const { workflowIds } = parse(updateBody, request.body);
    return phone.update(request.currentUser, workflowIds);
  });
  app.post('/api/phone/reset', admin, async (request) => phone.reset(request.currentUser));
  app.delete('/api/phone', admin, async (_request, reply) => {
    await phone.disable();
    return reply.status(204).send();
  });
}
