// Writes release/release.json and release/SHA256SUMS.txt for a GitHub Release.
// The download website reads release.json from https://github.com/<repo>/releases/latest/download/release.json,
// a plain file download: no GitHub API, no token, no rate limit.
//   node scripts/release-manifest.mjs --version 0.3.0 --repo owner/name [--notes-file notes.md]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? 'szen43292-star/automation' },
    'notes-file': { type: 'string' },
    dir: { type: 'string' },
  },
});
const releaseDir = resolve(
  values.dir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'release'),
);
const version =
  values.version ??
  JSON.parse(readFileSync(join(releaseDir, '..', 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const notes =
  values['notes-file'] && existsSync(values['notes-file'])
    ? readFileSync(values['notes-file'], 'utf8').trim()
    : '';

const artifacts = [
  {
    file: 'FlowForge-Setup.exe',
    platform: 'windows',
    arch: 'x64',
    kind: 'installer',
    label: 'Windows installer (.exe)',
    requirements: 'Windows 10 or 11, 64-bit',
  },
];

const downloads = artifacts
  .filter((artifact) => existsSync(join(releaseDir, artifact.file)))
  .map((artifact) => {
    const path = join(releaseDir, artifact.file);
    return {
      ...artifact,
      url: `https://github.com/${values.repo}/releases/download/${tag}/${artifact.file}`,
      size: statSync(path).size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  });
if (!downloads.length) throw new Error(`No release files found in ${releaseDir}`);

const manifest = {
  schema: 1,
  name: 'FlowForge',
  version,
  tag,
  publishedAt: new Date().toISOString(),
  repo: values.repo,
  notes,
  downloads,
};
writeFileSync(join(releaseDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(releaseDir, 'SHA256SUMS.txt'),
  downloads.map((d) => `${d.sha256}  ${d.file}`).join('\n') + '\n',
);
for (const d of downloads)
  console.log(`${d.file}  ${(d.size / 1024 / 1024).toFixed(1)} MB  sha256 ${d.sha256}`);
