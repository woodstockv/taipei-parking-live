/** Single-writer, immutable shards + one atomic manifest/checkpoint. No storage client. */
import { LIVE_LIMITS, isHash, isIso, parseManifestBytes, parseShardBytes, type LiveManifest, type ShardRef } from "../../shared/liveStatus.ts";
import { sha256, type Assembly } from "./assemble.ts";

export interface ObjectMetadata { contentType: "application/json"; contentEncoding?: "gzip"; cacheControl: string }
export interface ObjectStore {
  /** Null only for absence. Enforce maxBytes before buffering; other failures must throw. */
  get(key: string, options: { maxBytes: number }): Promise<Uint8Array | null>;
  inventory?(uploadSizes: number[]): Promise<number>;
  reserve?(reservation: { classA: number; classB: number; total: number }): Promise<void>;
  /** Atomic replacement. Resolve only when the complete object is durably readable.
   * Repeating an immutable key with identical bytes must be safe. No hidden PUT retries:
   * every invocation is counted here. Retain all active manifest references. */
  put(key: string, bytes: Uint8Array, metadata: ObjectMetadata): Promise<void>;
}
export interface PublicationAudit { classAOperations: number; shardPuts: number; manifestPuts: number }
export type PublicationResult = PublicationAudit & (
  | { ok: true; checkpoint: LiveManifest }
  | { ok: false; checkpoint: LiveManifest | null; error: string }
);
export function manifestKey(geometrySha256: string): string {
  if (!isHash(geometrySha256)) throw new Error("publication-geometry-pin");
  return `live/v1/${geometrySha256}/manifest.json`;
}
export async function loadCheckpoint(store: ObjectStore, geometrySha256: string): Promise<LiveManifest | null> {
  const bytes = await store.get(manifestKey(geometrySha256), { maxBytes: LIVE_LIMITS.manifestBytes });
  return bytes === null ? null : parseManifestBytes(bytes, geometrySha256);
}
export interface PublishOptions {
  store: ObjectStore; geometrySha256: string; previous: LiveManifest | null;
  /** A full assembly or a heartbeat from a successful conditional 304. */
  candidate: Assembly | { checkedAt: string };
  now(): string;
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function sameLayout(a: ShardRef, b: ShardRef): boolean {
  return a.bytes === b.bytes && a.rows === b.rows && JSON.stringify(a.bbox) === JSON.stringify(b.bbox);
}
/** One attempt per PUT per cycle. Retry by loading the last committed checkpoint
 * and running another cycle; partial immutable uploads can safely be replayed. */
export async function publish(options: PublishOptions): Promise<PublicationResult> {
  const { store, geometrySha256, previous, candidate } = options;
  const audit: PublicationAudit = { classAOperations: 0, shardPuts: 0, manifestPuts: 0 };
  try {
    const key = manifestKey(geometrySha256);
    // Validate caller input too; serialized copies prevent mutations of the checkpoint.
    const old = previous ? await parseManifestBytes(new TextEncoder().encode(JSON.stringify(previous)), geometrySha256) : null;
    const full = "manifest" in candidate;
    let next: LiveManifest;
    const uploads: { ref: ShardRef; gzip: Uint8Array }[] = [];
    if (full) {
      next = await parseManifestBytes(candidate.manifestBytes, geometrySha256);
      need(JSON.stringify(next) === JSON.stringify(candidate.manifest), "candidate-manifest-bytes");
      need(candidate.shards.length === next.shards.length, "candidate-shard-set");
      for (let i = 0; i < next.shards.length; i++) {
        const ref = next.shards[i]; const packed = candidate.shards[i];
        await parseShardBytes(packed.bytes, geometrySha256, ref);
        need(packed.gzip.length === ref.gzipBytes && sha256(packed.gzip) === ref.gzipSha256, "candidate-gzip-hash");
        const retained = old?.shards.find(r => r.id === ref.id && r.sha256 === ref.sha256);
        if (retained) {
          need(sameLayout(ref, retained), "unchanged-shard-layout");
          // Keep the already published compressed representation across runtime upgrades.
          next.shards[i] = retained;
        } else uploads.push({ ref, gzip: packed.gzip });
      }
    } else {
      need(old, "heartbeat-without-checkpoint");
      next = { ...old, checkedAt: candidate.checkedAt };
    }
    need(isIso(next.checkedAt) && (!old || next.checkedAt >= old.checkedAt), "publication-check-clock-regressed");
    need(!old || next.source.capturedAt >= old.source.capturedAt, "publication-capture-clock-regressed");
    const publicationClock = (): string => {
      const at = options.now();
      need(isIso(at) && at >= next.checkedAt && (!old || at >= old.publishedAt), "publication-clock-regressed");
      return at;
    };
    // Fail schema/pin/clock/candidate corruption before the first storage write.
    next.publishedAt = publicationClock();
    await parseManifestBytes(new TextEncoder().encode(JSON.stringify(next)), geometrySha256);
    const pages = await store.inventory?.(uploads.map(upload => upload.gzip.length)) ?? 0;
    const classA = uploads.length + 3 + pages;
    await store.reserve?.({ classA, classB: 4, total: classA + 4 });
    for (const { ref, gzip } of uploads) {
      audit.classAOperations++; audit.shardPuts++;
      await store.put(ref.key, gzip, { contentType: "application/json", contentEncoding: "gzip", cacheControl: "public, max-age=31536000, immutable" });
    }
    next.publishedAt = publicationClock(); // Delivery time, after all shard acknowledgements.
    const manifestBytes = new TextEncoder().encode(JSON.stringify(next));
    await parseManifestBytes(manifestBytes, geometrySha256);
    audit.classAOperations++; audit.manifestPuts++;
    await store.put(key, manifestBytes, { contentType: "application/json", cacheControl: "public, max-age=60" });
    return { ok: true, checkpoint: next, ...audit };
  } catch (error) {
    return { ok: false, checkpoint: previous, error: error instanceof Error ? error.message : "publication-error", ...audit };
  }
}
