/** Offline reconstruction from hash-pinned local inputs; no network or credentials. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
const root = fileURLToPath(new URL('..', import.meta.url));
const record = JSON.parse(readFileSync(join(root, 'provenance/geometry/source.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => { if (!ok) throw Error(message); };
for (const [file, digest] of Object.entries(record.evidenceFiles)) {
  need(hash(readFileSync(join(root, file))) === digest, `evidence hash: ${file}`);
}
const inputRoot = resolve(process.argv[2] || '/workspace/forge-022');
for (const input of Object.values(record.inputs)) {
  const path = join(inputRoot, input.relativePath);
  need(statSync(path).size === input.bytes && hash(readFileSync(path)) === input.sha256, `input hash: ${input.relativePath}`);
}
// Establish that the exact SHP/DBF bytes consumed below are members of the pinned ZIP.
execFileSync('python3', ['-c', `
import hashlib,json,sys,zipfile
r=json.load(open(sys.argv[1]))
with zipfile.ZipFile(sys.argv[2]) as z:
 for key in ['shp','dbf']:
  item=r['inputs'][key]
  h=hashlib.sha256()
  with z.open(item['archiveMember']) as f:
   while data:=f.read(1048576): h.update(data)
  assert h.hexdigest()==item['sha256'], 'archive member mismatch: '+key
`, join(root, 'provenance/geometry/source.json'), join(inputRoot, record.inputs.archive.relativePath)]);
const temp = mkdtempSync(join(tmpdir(), 'live6b-geometry-'));
try {
  const directory = join(temp, 'tiles');
  execFileSync(process.execPath, ['--experimental-strip-types', join(root, record.builder.entrypoint),
    '--shp', join(inputRoot, record.inputs.shp.relativePath), '--dbf', join(inputRoot, record.inputs.dbf.relativePath),
    '--status-xml', join(inputRoot, record.inputs.statusXml.relativePath), '--out', directory], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const manifestPath = join(directory, 'provenance.json');
  // Paths are part of the historical namespace. Restore the original recorded
  // path labels when inputs are supplied from a different local directory.
  const manifest = JSON.parse(readFileSync(manifestPath));
  for (const key of ['shp', 'dbf', 'statusXml']) manifest[key].path = record.inputs[key].canonicalPath;
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  need(hash(manifestBytes) === record.namespaceSha256, 'rebuilt namespace mismatch');
  need(manifestBytes.equals(readFileSync(join(root, 'provenance/geometry/tile-provenance.json'))), 'manifest bytes mismatch');
  writeFileSync(manifestPath, manifestBytes);
  const { localGeometry } = await import('../tools/live-status/coverage.ts');
  const geometry = localGeometry(directory, record.namespaceSha256); // checks every page and index hash
  const partitions = [];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function split(spots) {
    if (spots.length <= 2048) { partitions.push(spots); return; }
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of spots) { b[0] = Math.min(b[0], s.lng); b[1] = Math.min(b[1], s.lat); b[2] = Math.max(b[2], s.lng); b[3] = Math.max(b[3], s.lat); }
    const axis = (b[2] - b[0]) * Math.cos((b[1] + b[3]) * Math.PI / 360) >= b[3] - b[1] ? 'lng' : 'lat';
    const sorted = [...spots].sort((a, b) => a[axis] - b[axis] || compare(a.id, b.id));
    const mid = Math.floor(sorted.length / 2);
    split(sorted.slice(0, mid)); split(sorted.slice(mid));
  }
  split(geometry.spots);
  const body = Buffer.from(JSON.stringify({ v: 1, kind: 'live-geometry-partitions', sha256: record.namespaceSha256,
    shards: partitions.map((spots, i) => ({ id: `s${String(i).padStart(2, '0')}`, points: spots.map(p => [p.id, p.lng, p.lat]) })) }));
  const artifact = gzipSync(body, { level: 9 });
  need(hash(body) === record.decodedArtifactSha256, 'decoded artifact mismatch');
  need(hash(artifact) === record.artifactSha256, 'gzip artifact hash mismatch (use Node 24.22.1 Linux)');
  need(artifact.equals(readFileSync(join(root, record.artifactPath))), 'gzip bytes mismatch');
  console.log(`Verified archive members, ${manifest.files.length} pages, ${manifest.indexes.length} indexes, namespace ${record.namespaceSha256}, ${geometry.spots.length} points / ${partitions.length} shards, artifact ${record.artifactSha256}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
