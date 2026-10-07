import { execSync } from 'node:child_process';

/** Apply pending migrations to the dedicated test database (non-destructive). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/flowforge_test';
  if (!/_test(\?|$)/.test(new URL(url).pathname + new URL(url).search)) {
    throw new Error(`Refusing to run tests against "${url}": the database name must end with _test`);
  }
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
}
