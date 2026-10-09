/**
 * Run the fake AI providers on a fixed port for browser tests and local demos:
 *   npx tsx test/fake-ai-server.ts            (port 5700)
 * then start the server with OPENAI_BASE_URL=http://127.0.0.1:5700/v1 ANTHROPIC_BASE_URL=http://127.0.0.1:5700 …
 */
import { startFakeAi } from './fakeAi';

const fake = await startFakeAi(Number(process.env.FAKE_AI_PORT ?? 5700));
console.log(`Fake AI providers on ${fake.base}`);
