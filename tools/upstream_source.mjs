// Read a pinned upstream source from Git history or the verified bundled copy.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
export function pinnedSource(revision, path) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^payloads\/[A-Za-z0-9_./-]+\.js$/.test(path) || path.split('/').includes('..')) throw Error('Invalid upstream source');
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {cwd:root, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  } catch (_) {
    const key = revision + '/' + path;
    const bytes = readFileSync(new URL('../vendor/pinned/' + key, import.meta.url));
    const manifest = JSON.parse(readFileSync(new URL('../vendor/pinned-manifest.json', import.meta.url), 'utf8'));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[key]?.sha256) throw Error('Upstream checksum mismatch: ' + key);
    return bytes.toString('utf8');
  }
}
