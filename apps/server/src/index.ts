import { buildApp } from './app';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
