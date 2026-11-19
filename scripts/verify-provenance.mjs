import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const p = JSON.parse(readFileSync(new URL('../PROVENANCE.json', import.meta.url)));
const source = process.argv[2] || '/workspace/taipei-parking-alert';
const expected = '0e2f3f7a90532f2cf1bdb2c7caaea683c07b140c';
if (p.sourceCommit !== expected || !Object.keys(p.files).length) throw Error('invalid-provenance');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, digest] of Object.entries(p.files)) {
  if (!/^(tools\/live-status|worker\/(src|test)|shared|web\/public\/live-geometry)\/[\w./-]+$/.test(path) || path.includes('..')) throw Error(`invalid path: ${path}`);
  const local = readFileSync(new URL(`../${path}`, import.meta.url));
  const upstream = execFileSync('git', ['-C', source, 'show', `${expected}:${path}`], { maxBuffer: 20_000_000 });
  if (hash(local) !== digest || hash(upstream) !== digest) throw Error(`mismatch: ${path}`);
}
console.log(`Verified ${Object.keys(p.files).length} files against ${expected}`);
// The separate historical geometry builder is also copied verbatim. It is not
// part of the publisher and replay closure above.
const geometryRecord = JSON.parse(readFileSync(new URL('../provenance/geometry/source.json', import.meta.url)));
for (const path of geometryRecord.builder.sourcePaths) {
  const destination = `provenance/geometry/builder/${path}`;
  const original = execFileSync('git', ['-C', source, 'show', `${geometryRecord.builder.sourceCommit}:${path}`], { maxBuffer: 2_000_000 });
  if (hash(original) !== geometryRecord.evidenceFiles[destination] || hash(readFileSync(new URL(`../${destination}`, import.meta.url))) !== hash(original)) throw Error(`geometry builder mismatch: ${path}`);
}
const geometryVerify = new URL('./verify-geometry.mjs', import.meta.url);
execFileSync(process.execPath, ['--experimental-transform-types', fileURLToPath(geometryVerify)], { stdio: 'inherit' });
