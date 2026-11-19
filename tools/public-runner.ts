import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { sha256, assemble, type Geometry } from './live-status/assemble.ts';
import { createR2Adapter } from './live-status/r2-adapter.ts';
import { runEntrypoint } from './live-status/runner-entrypoint.ts';

const pin = 'e7a882774f11a7d78c0ff1606290a76fd1dea45403c8949f2c593373f1cc0608';
const artifactHash = '9dfab33b1cf1f98f504d2accbfb43f1cc4185c18af214cb450fd548f7341b30b';
const artifact = readFileSync(new URL(`../web/public/live-geometry/${pin}.json.gz`, import.meta.url));
if (sha256(artifact) !== artifactHash) throw Error('geometry-artifact-hash');
const raw = JSON.parse(gunzipSync(artifact, { maxOutputLength: 10_000_000 }).toString('utf8'));
if (raw.v !== 1 || raw.kind !== 'live-geometry-partitions' || raw.sha256 !== pin || !Array.isArray(raw.shards) || raw.shards.length !== 32) throw Error('geometry-artifact-format');
const spots: Geometry['spots'] = [];
for (const [i, shard] of raw.shards.entries()) {
  if (shard.id !== `s${String(i).padStart(2, '0')}` || !Array.isArray(shard.points)) throw Error('geometry-partition');
  for (const point of shard.points) {
    if (!Array.isArray(point) || point.length !== 3 || typeof point[0] !== 'string' || !Number.isFinite(point[1]) || !Number.isFinite(point[2])) throw Error('geometry-point');
    const parts = point[0].split(':');
    if (parts.length !== 3 || parts[0] !== 'tpe' || !parts[1] || !parts[2]) throw Error('geometry-id');
    spots.push({ id: point[0], road: parts[1], pkid: parts[2], lng: point[1], lat: point[2] });
  }
}
if (spots.length !== 51536 || new Set(spots.map(s => s.id)).size !== spots.length) throw Error('geometry-count');
const geometry = { sha256: pin, spots };
// Check that the upstream assembler reproduces the reader's exact partition membership.
const fixture = readFileSync(new URL('./live-status/fixtures/taipei.xml', import.meta.url));
const now = '2026-11-17T00:00:00.000Z';
const trial = assemble({ xml: fixture, geometry, capturedAt: now, checkedAt: now, publishedAt: now, etag: null, lastModified: null });
for (const [i, shard] of trial.shards.entries()) {
  const actual = shard.payload.rows.map(row => row[0]).sort();
  const expected = raw.shards[i].points.map((point: [string, number, number]) => point[0]).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('geometry-partition-mismatch');
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ mode: 'fixture-dry-run', geometryPin: pin, geometryArtifactSha256: artifactHash, geometryRows: spots.length,
    computedManifests: 1, computedShards: trial.shards.length, wouldPutShards: trial.shards.length, wouldPutManifest: 1,
    estimatedBootstrapClassA: 36, estimatedBootstrapClassB: 4, actualClassA: 0, actualClassB: 0, actualPut: 0, actualDelete: 0,
    note: 'Empty-bucket scenario; no R2 or source network access; ledger and inventory estimates are not actual requests.' }));
} else {
  if (process.env.GITHUB_REPOSITORY !== process.env.LIVE_STATUS_PUBLIC_REPOSITORY || !process.env.LIVE_STATUS_PUBLIC_REPOSITORY || process.env.GITHUB_REPOSITORY === 'woodstockv/taipei-parking-alert') throw Error('public-repository-allowlist');
  const adapter = createR2Adapter();
  const clock = { now: () => new Date().toISOString(), sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)), setTimer: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } };
  const result = await runEntrypoint({ adapter, geometry, geometrySha256: pin, clock, fetch: (url, init) => fetch(url, init), sourceUrl: 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_roadquery.xml' });
  console.log(JSON.stringify({ sourceStatus: result.cycle.sourceStatus, sourceAttempts: result.cycle.sourceAttempts, publicationClassA: result.cycle.classAOperations }));
}
