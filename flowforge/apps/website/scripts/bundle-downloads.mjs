// Puts the newest apps into the website itself, so a fresh Vercel deploy serves them with no
// token and no settings (also for private repositories).
//
// The "Website downloads" workflow (.github/workflows/website-downloads.yml) commits each
// release's files to flowforge/downloads/: release.json, FlowForge.apk, FlowForge.ipa and the
// Windows installer in parts (GitHub refuses files over 100 MB). This script, run before
// `next build`, copies them to public/downloads/, joins the installer parts, checks every file
// against its SHA-256 and writes public/downloads/release.json with /downloads/<file> links.
// A file that is missing or does not match is left out; the build never fails because of it.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** FlowForge-Setup.exe.part0, .part1, ... in order. */
function partsOf(source, file) {
  return readdirSync(source)
    .map((name) => ({
      name,
      match: name.match(new RegExp(`^${file.replace(/\./g, '\\.')}\\.part(\\d+)$`)),
    }))
    .filter((p) => p.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((p) => join(source, p.name));
}

async function assemble(source, file, target) {
  if (existsSync(join(source, file))) {
    copyFileSync(join(source, file), target);
    return true;
  }
  const parts = partsOf(source, file);
  if (!parts.length) return false;
  writeFileSync(target, '');
  for (const part of parts) await appendFile(target, readFileSync(part));
  return true;
}

/**
 * Returns the bundled release (with /downloads/<file> links), or null when there is nothing to
 * bundle. `log` receives one line per decision for the build output.
 */
export async function bundleDownloads(source, target, log = console.log) {
  rmSync(target, { recursive: true, force: true });
  const manifestPath = join(source, 'release.json');
  if (!existsSync(manifestPath)) {
    log('Downloads: none in the repository yet (run Actions → Release on GitHub).');
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mkdirSync(target, { recursive: true });
  const downloads = [];
  for (const download of manifest.downloads ?? []) {
    const path = join(target, download.file);
    if (!(await assemble(source, download.file, path))) {
      log(`Downloads: ${download.file} is not in the repository - left out.`);
      continue;
    }
    const size = statSync(path).size;
    const hash = await sha256(path);
    if (
      (download.size && size !== download.size) ||
      (download.sha256 && hash !== download.sha256)
    ) {
      log(`Downloads: ${download.file} does not match release.json - left out.`);
      rmSync(path);
      continue;
    }
    downloads.push({ ...download, url: `/downloads/${download.file}`, size, sha256: hash });
    log(`Downloads: ${download.file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (!downloads.length) {
    rmSync(target, { recursive: true, force: true });
    return null;
  }
  // The Windows app updates itself from here: the updater reads latest.yml (and the delta map).
  if (downloads.some((d) => d.platform === 'windows')) {
    for (const file of ['latest.yml', 'FlowForge-Setup.exe.blockmap']) {
      if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file));
    }
  }
  const release = { ...manifest, downloads };
  writeFileSync(join(target, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundleDownloads(resolve(here, '../../../downloads'), resolve(here, '../public/downloads'));
}
