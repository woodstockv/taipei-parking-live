/** Read-only local measurement CLI. No network clients or output artifact writes. */
import process from "node:process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, readGeometry, sha256, type Assembly, type AssemblyInput } from "./assemble.ts";
import { isIso } from "../../shared/liveStatus.ts";
export function statistics(values: number[]): { min: number; median: number; max: number } {
  const v = [...values].sort((a, b) => a - b); const m = Math.floor(v.length / 2);
  return { min: v[0], median: v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, max: v.at(-1)! };
}
export function measured(a: Assembly) {
  return { source: a.manifest.source, roads: a.roads, cells: a.manifest.cells, geometry: a.manifest.geometry,
    geometryCoverage: `${a.manifest.geometry.total}/${a.manifest.geometry.total}`,
    matchedGeometryPercent: 100 * a.manifest.geometry.matched / a.manifest.geometry.total,
    shards: a.shards.length, fits64: a.shards.length <= 64,
    rawBytes: statistics(a.shards.map(s => s.bytes.length)), gzipBytes: statistics(a.shards.map(s => s.gzip.length)),
    rowCounts: statistics(a.shards.map(s => s.payload.rows.length)), manifestBytes: a.manifestBytes.length,
    perShard: a.manifest.shards.map(s => ({ id: s.id, rawBytes: s.bytes, gzipBytes: s.gzipBytes, rows: s.rows })) };
}
export function monthlyWrites(shards: number, changed: number) {
  return [30, 31].map(days => ({ days, runs: days * 24 * 12,
    worstCase: (shards + 1) * days * 24 * 12,
    diffOnlyEstimate: (changed + 1) * days * 24 * 12, freeTier: 1_000_000 }));
}
function bounded(path: string, cap: number): Uint8Array {
  const s = lstatSync(path);
  if (!s.isFile() || s.size > cap) throw new Error(`invalid-local-input: ${path}`);
  const b = readFileSync(path); if (b.length > cap) throw new Error("input-grew-over-cap"); return b;
}
function main(args: string[]): void {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || !args[i + 1] || options.has(args[i])) throw new Error("expected unique --name value pairs");
    options.set(args[i], args[i + 1]);
  }
  const allowed = ["geometry", "geometry-sha256", "xml", "captured-at", "last-modified", "etag", "previous-xml", "previous-captured-at", "previous-last-modified", "previous-etag"];
  if ([...options.keys()].some(k => !allowed.includes(k.slice(2)))) throw new Error("unknown-option");
  const required = (name: string): string => { const v = options.get(`--${name}`); if (!v) throw new Error(`missing --${name}`); return v; };
  const dir = required("geometry"); const pin = required("geometry-sha256");
  const manifestBytes = bounded(resolve(dir, "provenance.json"), 2_000_000);
  // Verify the pin BEFORE interpreting paths from an untrusted manifest.
  // readGeometry repeats this check and verifies the exact page/index set.
  if (sha256(manifestBytes) !== pin) throw new Error("geometry-pin-mismatch");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as { files: { file: string }[]; indexes: { file: string }[] };
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.indexes) || manifest.files.length + manifest.indexes.length > 8192) throw new Error("geometry-manifest");
  const files = new Map<string, Uint8Array>();
  for (const f of [...manifest.files, ...manifest.indexes]) {
    if (!f || !/^\d{2}\.\d{2}_\d{3}\.\d{2}(?:\.p[1-9]\d*|\.index)?\.json$/.test(f.file)) throw new Error("geometry-path");
    files.set(f.file, bounded(resolve(dir, f.file), 48_000));
  }
  const geometry = readGeometry(manifestBytes, pin, files);
  const run = (prefix: string): Assembly => {
    const capturedAt = required(`${prefix}captured-at`);
    if (!isIso(capturedAt)) throw new Error("captured-at-must-be-canonical-UTC-ISO");
    const lm = options.get(`--${prefix}last-modified`);
    if (lm && !isIso(lm)) throw new Error("last-modified-must-be-canonical-UTC-ISO");
    const input: AssemblyInput = { xml: bounded(required(`${prefix}xml`), 20_000_000), geometry, capturedAt,
      checkedAt: capturedAt, publishedAt: capturedAt,
      lastModified: lm ?? null, etag: options.get(`--${prefix}etag`) ?? null };
    return assemble(input);
  };
  const current = run(""); const previous = options.has("--previous-xml") ? run("previous-") : null;
  const changed = previous ? current.manifest.shards.filter(s => previous.manifest.shards.find(p => p.id === s.id)?.sha256 !== s.sha256).length : null;
  console.log(JSON.stringify({ geometrySha256: pin, current: measured(current), previous: previous ? measured(previous) : null,
    changedShards: changed, monthly: changed === null ? null : monthlyWrites(current.shards.length, changed),
    assumptions: "One manifest PUT per successful five-minute check, 200 or 304; changed immutable shard PUTs. Diff extrapolates this single saved transition; excludes retries/GC/other account use." }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(new URL(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : "measurement-failed"); process.exitCode = 1; }
}
