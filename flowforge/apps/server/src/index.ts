import Fastify from 'fastify';
import { buildApp } from './app';
import { loadConfig, type Config } from './config';

/**
 * Not configured yet (e.g. a fresh Vercel deploy without DATABASE_URL): answer every request
 * with what is missing instead of crashing, so the rest of the deployment keeps working.
 */
async function setupRequired(problem: string) {
  const app = Fastify({ logger: false });
  const message = problem.replace(/^Invalid server configuration:\n/, '').split('\n');
  app.all('/*', async (_request, reply) =>
    reply.status(503).send({
      error: 'SetupRequired',
      message:
        'The FlowForge server is not configured yet. Add these environment variables (on Vercel: Settings → Environment Variables) and redeploy.',
      problems: message.filter((line) => line.trim().startsWith('-')).map((line) => line.trim()),
    }),
  );
  await app.listen({ port: Number(process.env.PORT) || 5678, host: process.env.HOST ?? '0.0.0.0' });
  console.error(`FlowForge is waiting for configuration:\n${problem}`);
}

async function main() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    await setupRequired((error as Error).message);
    return;
  }
  const app = await buildApp(config);

  await app.listen({ port: config.PORT, host: config.HOST });
  await app.startBackgroundServices();
  app.log.info(
    `FlowForge ${app.flowforgeVersion} ready on ${config.PUBLIC_URL} (executions: ${config.EXECUTIONS_MODE})`,
  );
  if (!config.editorDist) {
    app.log.info(
      'Editor build not found - run "pnpm --filter @flowforge/editor build" or use the Vite dev server',
    );
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down…`);
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Started by the desktop app with an IPC channel: shut down when asked (Windows has no SIGTERM),
  // or when the app goes away without asking (e.g. it crashed), so no orphan keeps the port.
  if (process.send) {
    process.on('message', (message) => {
      if (message === 'shutdown') void shutdown('shutdown request');
    });
    process.on('disconnect', () => void shutdown('parent exit'));
    process.send('ready');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
