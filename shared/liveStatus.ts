/** Browser-safe live-status v1. Hashes are SHA-256 of exact decoded UTF-8 JSON. */
export const LIVE_LIMITS = Object.freeze({ shards: 64, shardBytes: 128 * 1024,
  gzipBytes: 32 * 1024, rows: 2048, manifestBytes: 32 * 1024, xmlBytes: 20_000_000,
  sourceCells: 100_000, geometryRows: 64 * 2048 });
export type Bbox = [west: number, south: number, east: number, north: number];
export type Join = "matched" | "unmatched" | "ambiguous";
/** Null provider fields mean no unique source row. Raw strings are never coerced. */
export type LiveRow = [id: string, join: Join, roadSegID: string | null,
  psId: string | null, rawCode: string | null, data_Dt: string | null];
export interface LiveShard {
  v: 1; kind: "live-status-shard"; geometrySha256: string; id: string; rows: LiveRow[];
}
export interface ShardRef {
  id: string; bbox: Bbox; sha256: string; gzipSha256: string;
  bytes: number; gzipBytes: number; rows: number; key: string;
}
export interface JoinCounts { total: number; matched: number; unmatched: number; ambiguous: number }
export interface SourceClocks {
  name: "tcmsv"; sha256: string; bytes: number; etag: string | null;
  lastModified: string | null; capturedAt: string;
  /** Raw distinct roadSegUpdatetime values, including malformed values. */
  batchTimes: string[]; batchOldestAt: string | null; batchNewestAt: string | null;
}
export interface LiveManifest {
  v: 1; kind: "live-status-manifest"; geometrySha256: string;
  /** Hash of ordered [logical shard id, decoded hash] pairs. Excludes clocks. */
  generation: string; source: SourceClocks; checkedAt: string; publishedAt: string;
  geometry: JoinCounts; cells: JoinCounts; shards: ShardRef[];
}
const enc = new TextEncoder();
export function decodedBytes(text: string): number { return enc.encode(text).byteLength; }
export function isHash(x: unknown): x is string { return typeof x === "string" && /^[a-f0-9]{64}$/.test(x); }
export function isIso(x: unknown): x is string {
  return typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
    Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function record(x: unknown): Record<string, unknown> {
  assert(x && typeof x === "object" && !Array.isArray(x), "invalid-object");
  return x as Record<string, unknown>;
}
function integer(x: unknown, min: number, max: number): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
}
function scalar(x: unknown): x is string { return typeof x === "string" && x.length <= 256 && !/[\u0000-\u001f]/.test(x); }
export function validBbox(x: unknown): x is Bbox {
  return Array.isArray(x) && x.length === 4 && x.every(n => typeof n === "number" && Number.isFinite(n)) &&
    x[0] >= -180 && x[2] <= 180 && x[1] >= -90 && x[3] <= 90 && x[0] <= x[2] && x[1] <= x[3];
}
/** Interpret event time with an explicit Taipei offset; reject rollover and timezone-less ISO. */
export function eventTime(raw: string | null): string | null {
  if (!raw) return null;
  const local = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/.exec(raw);
  const text = local ? `${local[1]}T${local[2]}+08:00` : raw;
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.exec(text);
  if (!m) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  const offset = m[3] === "Z" ? 0 : (m[3][0] === "-" ? -1 : 1) * (Number(m[3].slice(1, 3)) * 60 + Number(m[3].slice(4)));
  if (new Date(ms + offset * 60_000).toISOString().slice(0, 19) !== `${m[1]}T${m[2]}`) return null;
  return new Date(ms).toISOString();
}
export function reading(row: LiveRow, capturedAt: string): {
  status: "occupied" | "free" | "unknown"; collectedAt: string | null; label: string | null;
} {
  const at = eventTime(row[5]);
  const valid = row[1] === "matched" && at !== null && isIso(capturedAt) && Date.parse(at) <= Date.parse(capturedAt);
  return { status: valid && row[4] === "1" ? "occupied" : valid && row[4] === "2" ? "free" : "unknown",
    collectedAt: valid ? at : null, label: row[1] === "matched" && row[4] === "3" ? "設備調整中" : null };
}
export function shardKey(geometry: string, id: string, hash: string): string {
  return `live/v1/${geometry}/${id}/${hash}.json.gz`;
}
export function validateShard(value: unknown, geometry: string, id: string, expectedIds?: readonly string[]): LiveShard {
  const x = record(value);
  assert(x.v === 1 && x.kind === "live-status-shard" && isHash(geometry) && x.geometrySha256 === geometry && x.id === id && /^s\d{2}$/.test(id), "shard-version-or-identity");
  assert(Array.isArray(x.rows) && x.rows.length > 0 && x.rows.length <= LIVE_LIMITS.rows, "shard-row-cap");
  const ids = new Set<string>();
  let previous = "";
  for (const r of x.rows) {
    assert(Array.isArray(r) && r.length === 6 && scalar(r[0]) && r[0].length > 0 && r[0] > previous, "shard-ids");
    previous = r[0]; ids.add(r[0]);
    assert(["matched", "unmatched", "ambiguous"].includes(r[1]), "shard-join");
    assert(r.slice(2).every(v => v === null || scalar(v)), "shard-scalars");
    assert(r[1] === "matched" ? !!r[2] && !!r[3] && r[4] !== null && r[5] !== null : r.slice(2).every(v => v === null), "shard-join-evidence");
  }
  if (expectedIds) assert(ids.size === expectedIds.length && new Set(expectedIds).size === ids.size && expectedIds.every(id => ids.has(id)), "shard-membership");
  assert(decodedBytes(JSON.stringify(x)) <= LIVE_LIMITS.shardBytes, "shard-byte-cap");
  return value as LiveShard;
}
function counts(x: unknown, cap: number): JoinCounts {
  const c = record(x);
  assert([c.total, c.matched, c.unmatched, c.ambiguous].every(n => integer(n, 0, cap)) && c.total === Number(c.matched) + Number(c.unmatched) + Number(c.ambiguous), "invalid-counts");
  return x as JoinCounts;
}
export function validateManifest(value: unknown, geometry: string): LiveManifest {
  const x = record(value);
  assert(x.v === 1 && x.kind === "live-status-manifest" && isHash(geometry) && x.geometrySha256 === geometry && isHash(x.generation), "manifest-version-or-geometry");
  assert(isIso(x.checkedAt) && isIso(x.publishedAt) && x.checkedAt <= x.publishedAt, "manifest-clocks");
  const s = record(x.source);
  assert(s.name === "tcmsv" && isHash(s.sha256) && integer(s.bytes, 1, LIVE_LIMITS.xmlBytes) && isIso(s.capturedAt) && s.capturedAt <= x.checkedAt, "source-identity-or-clock");
  assert((s.etag === null || scalar(s.etag)) && (s.lastModified === null || isIso(s.lastModified)), "source-validators");
  assert(s.lastModified === null || s.lastModified <= s.capturedAt, "source-object-clock");
  assert(Array.isArray(s.batchTimes) && s.batchTimes.length <= 4096 && s.batchTimes.every(scalar) &&
    s.batchTimes.every((v, i, times) => i === 0 || times[i - 1] < v), "source-batch-times");
  const normalized = (s.batchTimes as string[]).map(batchTime).filter((v): v is string => v !== null).sort();
  assert(s.batchOldestAt === (normalized[0] ?? null) && s.batchNewestAt === (normalized.at(-1) ?? null), "source-batch-clocks");
  const g = counts(x.geometry, LIVE_LIMITS.geometryRows); counts(x.cells, LIVE_LIMITS.sourceCells);
  assert(Array.isArray(x.shards) && x.shards.length > 0 && x.shards.length <= LIVE_LIMITS.shards, "manifest-shard-cap");
  let total = 0; let prev = "";
  for (const raw of x.shards) {
    const r = record(raw);
    assert(typeof r.id === "string" && /^s\d{2}$/.test(r.id) && r.id > prev && isHash(r.sha256) && isHash(r.gzipSha256) && validBbox(r.bbox), "manifest-shard-identity");
    prev = r.id;
    assert(integer(r.bytes, 1, LIVE_LIMITS.shardBytes) && integer(r.gzipBytes, 1, LIVE_LIMITS.gzipBytes) && integer(r.rows, 1, LIVE_LIMITS.rows), "manifest-shard-size");
    assert(r.key === shardKey(geometry, r.id, r.sha256), "manifest-shard-key"); total += r.rows;
  }
  assert(total === g.total && total > 0, "manifest-coverage");
  assert(decodedBytes(JSON.stringify(x)) <= LIVE_LIMITS.manifestBytes, "manifest-byte-cap");
  return value as LiveManifest;
}
export function batchTime(raw: string): string | null {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)$/.exec(raw);
  return m ? eventTime(`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`) : null;
}
/** Byte-level integrity entry points. Callers still cap streaming bytes before buffering. */
export async function decodedHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
export async function parseManifestBytes(bytes: Uint8Array, geometry: string): Promise<LiveManifest> {
  assert(bytes.length > 0 && bytes.length <= LIVE_LIMITS.manifestBytes, "manifest-byte-cap");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const m = validateManifest(value, geometry);
  const generation = await decodedHash(enc.encode(JSON.stringify(m.shards.map(r => [r.id, r.sha256]))));
  assert(generation === m.generation, "generation-hash-mismatch");
  return m;
}
export async function parseShardBytes(bytes: Uint8Array, geometry: string, ref: ShardRef, expectedIds?: readonly string[]): Promise<LiveShard> {
  assert(bytes.length > 0 && bytes.length <= LIVE_LIMITS.shardBytes && bytes.length === ref.bytes, "shard-byte-cap-or-length");
  assert(await decodedHash(bytes) === ref.sha256, "shard-hash-mismatch");
  const s = validateShard(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), geometry, ref.id, expectedIds);
  assert(s.rows.length === ref.rows, "shard-ref-count");
  return s;
}
