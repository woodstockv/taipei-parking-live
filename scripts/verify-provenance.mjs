import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const p = JSON.parse(readFileSync(new URL('../PROVENANCE.json', import.meta.url)));
const source = process.argv[2] || '/workspace/taipei-parking-alert';
const expected = '8302f9df9f4b8083cef3b42b7ab8d7ec26ad2516';
if (p.sourceCommit !== expected || !Object.keys(p.files).length) throw Error('invalid-provenance');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, digest] of Object.entries(p.files)) {
  if (!/^(tools\/live-status|worker\/(src|test)|shared|web\/public\/live-geometry)\/[\w./-]+$/.test(path) || path.includes('..')) throw Error(`invalid path: ${path}`);
  const local = readFileSync(new URL(`../${path}`, import.meta.url));
  const upstream = execFileSync('git', ['-C', source, 'show', `${expected}:${path}`], { maxBuffer: 20_000_000 });
  if (hash(local) !== digest || hash(upstream) !== digest) throw Error(`mismatch: ${path}`);
}
console.log(`Verified ${Object.keys(p.files).length} files against ${expected}`);
