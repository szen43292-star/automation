import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/errors';
import type { ApprovalDTO, ApprovalService } from './ApprovalService';

const idParams = z.object({ id: z.string().min(1).max(100) });
const decisionBody = z.object({ decision: z.enum(['approve', 'reject']) });

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The approval page: works in any phone browser and inside the AutoForge app. */
export function approvalPage(approval: ApprovalDTO): string {
  const state =
    approval.status === 'approved'
      ? 'You approved this.'
      : approval.status === 'rejected'
        ? 'You rejected this.'
        : approval.expired
          ? 'This approval has expired - nothing was published.'
          : '';
  const media = approval.hasMedia
    ? approval.mediaType?.startsWith('image/')
      ? `<img src="${approval.id}/media" alt="">`
      : `<video src="${approval.id}/media" controls playsinline preload="metadata"></video>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>Approve: ${escape(approval.title)}</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--fg:#1b1f27;--muted:#5f6b7a;--line:#e3e6eb;--ok:#16a34a;--no:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaee;--muted:#9aa3af;--line:#2a2f37}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}
.brand{font-size:13px;color:var(--muted);margin:4px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
video,img{display:block;width:100%;max-height:70vh;background:#000;object-fit:contain}
.body{padding:16px}h1{font-size:19px;margin:0 0 8px}p.details{white-space:pre-wrap;color:var(--muted);margin:0;font-size:14px}
.actions{display:flex;gap:12px;margin-top:16px}button{flex:1;border:0;border-radius:12px;padding:15px;font:600 17px system-ui,sans-serif;color:#fff;cursor:pointer}
button.ok{background:var(--ok)}button.no{background:var(--no)}button:disabled{opacity:.5}
.state{margin-top:16px;padding:12px;border-radius:10px;background:var(--bg);font-weight:600;text-align:center}
.expires{margin-top:10px;font-size:13px;color:var(--muted);text-align:center}
</style></head><body><main>
<div class="brand">AutoForge · approval</div>
<div class="card">${media}<div class="body">
<h1>${escape(approval.title)}</h1>
${approval.description ? `<p class="details">${escape(approval.description)}</p>` : ''}
${
  state
    ? `<div class="state">${escape(state)}</div>`
    : `<div class="actions"><button class="no" data-decision="reject">Reject</button><button class="ok" data-decision="approve">Approve</button></div>
<div class="state" id="state" hidden></div>
<div class="expires">Answer before ${escape(new Date(approval.expiresAt).toUTCString())}</div>`
}
</div></div></main>
<script>
document.querySelectorAll('button[data-decision]').forEach(function (button) {
  button.addEventListener('click', function () {
    var decision = button.getAttribute('data-decision');
    if (decision === 'reject' && !confirm('Reject this? Nothing will be published.')) return;
    var buttons = document.querySelectorAll('button[data-decision]');
    buttons.forEach(function (b) { b.disabled = true; });
    var state = document.getElementById('state');
    fetch(location.pathname.replace(/\\/$/, ''), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: decision })
    }).then(function (r) { return r.json(); }).then(function (result) {
      state.hidden = false; state.textContent = result.message;
      if (result.ok) document.querySelector('.actions').remove();
      else buttons.forEach(function (b) { b.disabled = false; });
    }).catch(function () {
      state.hidden = false; state.textContent = 'Could not reach AutoForge - is the PC on? Try again.';
      buttons.forEach(function (b) { b.disabled = false; });
    });
  });
});
</script></body></html>`;
}

/** Streams the approval's video with HTTP range support (needed for seeking on phones). */
function sendMedia(reply: FastifyReply, path: string, type: string, range: string | undefined) {
  const size = statSync(path).size;
  reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=3600');
  reply.type(type);
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
    let end = match[1] && match[2] ? Number(match[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start >= size || start > end) {
      return reply.status(416).header('content-range', `bytes */${size}`).send();
    }
    start = Math.max(start, 0);
    return reply
      .status(206)
      .header('content-range', `bytes ${start}-${end}/${size}`)
      .header('content-length', end - start + 1)
      .send(createReadStream(path, { start, end }));
  }
  return reply.header('content-length', size).send(createReadStream(path));
}

/**
 * Public approval pages. The approval id is a long random secret, so the link itself is the
 * permission (it can be opened on a phone without signing in); nothing else is reachable this way.
 */
export async function approvalPublicRoutes(
  app: FastifyInstance,
  opts: { approvals: ApprovalService },
) {
  const { approvals } = opts;
  const notFound = (reply: FastifyReply) =>
    reply
      .status(404)
      .type('text/html')
      .send(
        '<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">This approval link is not valid.</p>',
      );

  app.get('/approve/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const row = await approvals.get(id);
    if (!row) return notFound(reply);
    return reply
      .type('text/html')
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex')
      .send(approvalPage(approvals.toDTO(row)));
  });

  app.get('/approve/:id/media', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const row = await approvals.get(id);
    const path = row ? approvals.mediaPath(row) : null;
    if (!row || !path) return reply.status(404).send({ message: 'No video for this approval' });
    return sendMedia(
      reply,
      path,
      row.mediaType ?? 'application/octet-stream',
      request.headers.range,
    );
  });

  app.post('/approve/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { decision } = parse(decisionBody, request.body);
    const result = await approvals.decide(id, decision === 'approve' ? 'approved' : 'rejected');
    return reply.status(result.ok ? 200 : 409).send(result);
  });
}

/** Signed-in API: the app's Approvals screen. */
export async function approvalApiRoutes(
  app: FastifyInstance,
  opts: { approvals: ApprovalService },
) {
  const { approvals } = opts;
  app.get('/api/approvals', async (request) => {
    const { status } = parse(
      z.object({ status: z.enum(['pending', 'all']).default('pending') }),
      request.query,
    );
    return { data: await approvals.list({ pendingOnly: status === 'pending' }) };
  });
  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { decision } = parse(decisionBody, request.body);
    const result = await approvals.decide(id, decision === 'approve' ? 'approved' : 'rejected');
    return reply.status(result.ok ? 200 : 409).send(result);
  });
}
