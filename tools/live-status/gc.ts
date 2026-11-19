/** Reachability GC for ONE pinned release. Caller holds the sole publisher lock
 * from before root reads until completion. No network client or import-time I/O. */
import { LIVE_LIMITS, isHash, isIso, parseManifestBytes } from "../../shared/liveStatus.ts";
import { sha256 } from "./assemble.ts";
import { manifestKey, type ObjectStore } from "./publish.ts";

export const GRACE_MS = 48 * 60 * 60 * 1000;
export interface ListedObject { key: string; bytes: number; uploadedAt: string }
export interface GcStorage extends Pick<ObjectStore, "get" | "reserve" | "inventory"> {
  /** Complete, stable pagination under the same exclusive publisher lock.
   * No hidden retries. Each call is one Class A LIST. */
  list(options: { prefix: string; cursor: string | null; limit: number }): Promise<{ objects: ListedObject[]; cursor: string | null }>;
  /** One key per invocation, no hidden retries; failed attempts also count. */
  delete(key: string): Promise<void>;
}
/** Immutable manifest snapshots are named by hash of their exact decoded bytes.
 * The adapter MUST durably retain the previous checkpoint and update this index
 * BEFORE replacing manifest.json. Entries include the previous generation and
 * every explicitly retained rollback manifest, regardless of age. Missing or
 * incomplete inventory is an adapter failure, never permission to delete. */
export interface RetentionIndex { v: 1; geometrySha256: string; manifests: string[]; pins?: string[] }
export const retentionKey = (pin: string): string => `${manifestKey(pin).slice(0, -"manifest.json".length)}retention.json`;
export function retainedKey(pin: string, bytes: Uint8Array): string {
  return `${manifestKey(pin).slice(0, -"manifest.json".length)}retained/${sha256(bytes)}.json`;
}
export interface OperationCounts { classA: number; classB: number; lists: number; gets: number; puts: number; deletes: number; total: number }
export const emptyCounts = (): OperationCounts => ({ classA: 0, classB: 0, lists: 0, gets: 0, puts: 0, deletes: 0, total: 0 });
export interface GcOptions {
  store: GcStorage; geometrySha256: string; now: string;
  /** Explicit assertion by orchestrator; never run concurrently with publication. */
  exclusivePublisher: true;
  dryRun?: boolean; maxDeletes?: number; maxListPages?: number; pageSize?: number;
  maxObjects?: number; maxStorageBytes?: number; maxOperations?: number; maxRetainedManifests?: number;
}
export interface GcResult {
  ok: boolean; dryRun: boolean; error?: string; operations: OperationCounts;
  objects: number; storageBytes: number; reachableObjects: number;
  eligible: string[]; deleted: string[];
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function limit(n: number, ceiling: number): boolean { return Number.isSafeInteger(n) && n >= 0 && n <= ceiling; }
/** Fail closed before deletion on invalid/incomplete roots, incomplete listing,
 * cap violations or a changed checkpoint. Dry runs perform the same reads. */
export async function collectGarbage(options: GcOptions): Promise<GcResult> {
  const { store, geometrySha256: pin } = options;
  const result: GcResult = { ok: false, dryRun: options.dryRun !== false, operations: emptyCounts(), objects: 0, storageBytes: 0, reachableObjects: 0, eligible: [], deleted: [] };
  const maxDeletes = options.maxDeletes ?? 1000; const maxPages = options.maxListPages ?? 64;
  const pageSize = options.pageSize ?? 1000; const maxObjects = options.maxObjects ?? 50_000;
  const maxStorage = options.maxStorageBytes ?? 2_000_000_000; const maxOps = options.maxOperations ?? 4096;
  const maxRetained = options.maxRetainedManifests ?? 1024;
  const op = (kind: "gets" | "lists" | "deletes"): void => {
    need(result.operations.total < maxOps, "gc-operation-cap");
    result.operations[kind]++; result.operations.total++;
    if (kind === "gets") result.operations.classB++;
    if (kind === "lists") result.operations.classA++;
    // R2 DELETE is free, but still consumes the total-operation/delete budgets.
  };
  const get = async (key: string, cap: number): Promise<Uint8Array> => {
    op("gets"); const bytes = await store.get(key, { maxBytes: cap });
    need(bytes !== null && bytes.length <= cap, "gc-missing-or-oversized-root"); return bytes;
  };
  try {
    need(isHash(pin) && isIso(options.now) && options.exclusivePublisher === true, "gc-pin-clock-or-lock");
    need(limit(maxDeletes, 5000) && limit(maxPages, 128) && maxPages > 0 && limit(pageSize, 1000) && pageSize > 0 &&
      limit(maxObjects, 100_000) && maxObjects > 0 && limit(maxStorage, 2_000_000_000) && maxStorage > 0 &&
      limit(maxOps, 10_000) && maxOps > 0 && limit(maxRetained, 1024), "gc-policy");
    // Standalone GC writes an accounting ledger. Gate that PUT with the same
    // whole-bucket inventory used by publication, then reserve both listings.
    if (store.reserve) {
      need(store.inventory, "gc-inventory-required");
      const pages = await store.inventory([]);
      need(Number.isSafeInteger(pages) && pages > 0 && pages <= 10, "gc-inventory-pages");
      await store.reserve({ classA: maxPages + pages, classB: maxRetained + 4, total: maxOps + pages });
    }
    const currentKey = manifestKey(pin); const indexKey = retentionKey(pin);
    const prefix = currentKey.slice(0, -"manifest.json".length);
    const currentBytes = await get(currentKey, LIVE_LIMITS.manifestBytes);
    const current = await parseManifestBytes(currentBytes, pin);
    need(current.publishedAt <= options.now, "gc-future-manifest");
    const indexBytes = await get(indexKey, 250_000);
    const index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes)) as RetentionIndex;
    need(index?.v === 1 && index.geometrySha256 === pin && Array.isArray(index.manifests) &&
      index.manifests.length <= maxRetained && new Set(index.manifests).size === index.manifests.length, "gc-retention-index");
    need(index.pins === undefined || Array.isArray(index.pins) && index.pins.length <= 400 && new Set(index.pins).size === index.pins.length, "gc-retention-index");
    const retained = [...new Set([...index.manifests, ...(index.pins ?? [])])];
    need(retained.length <= maxRetained, "gc-retention-index");
    const roots = new Set<string>([currentKey, indexKey]);
    const references = new Map(current.shards.map(s => [s.key, s.gzipBytes]));
    for (const key of retained) {
      need(typeof key === "string" && key.startsWith(`${prefix}retained/`) && /^[a-f0-9]{64}\.json$/.test(key.slice(`${prefix}retained/`.length)), "gc-retained-path");
      const bytes = await get(key, LIVE_LIMITS.manifestBytes);
      need(retainedKey(pin, bytes) === key, "gc-retained-hash");
      const m = await parseManifestBytes(bytes, pin); need(m.publishedAt <= options.now, "gc-future-manifest");
      roots.add(key);
      for (const s of m.shards) { need(!references.has(s.key) || references.get(s.key) === s.gzipBytes, "gc-reference-size-conflict"); references.set(s.key, s.gzipBytes); }
    }
    for (const k of references.keys()) roots.add(k);
    const objects = new Map<string, ListedObject>(); const cursors = new Set<string>(); let cursor: string | null = null;
    for (let page = 0; ; page++) {
      need(page < maxPages, "gc-list-page-cap"); op("lists");
      // Inventory the whole bucket, including other geometry pins and accounting
      // objects. Deletion below remains restricted to this geometry's paths.
      const batch = await store.list({ prefix: "", cursor, limit: pageSize });
      need(Array.isArray(batch.objects) && batch.objects.length <= pageSize && (batch.cursor === null || typeof batch.cursor === "string" && batch.cursor.length > 0 && batch.cursor.length <= 4096), "gc-list-page");
      for (const object of batch.objects) {
        need(object && typeof object.key === "string" && object.key.length > 0 && object.key.length <= 512 && !objects.has(object.key) &&
          limit(object.bytes, maxStorage) && isIso(object.uploadedAt) && object.uploadedAt <= options.now, "gc-object-metadata");
        objects.set(object.key, object); result.objects++; result.storageBytes += object.bytes;
        need(result.objects <= maxObjects && result.storageBytes <= maxStorage, "gc-inventory-storage-cap");
      }
      if (batch.cursor === null) break;
      need(!cursors.has(batch.cursor), "gc-list-cursor-loop"); cursors.add(batch.cursor); cursor = batch.cursor;
    }
    // If an exact snapshot of the current checkpoint already exists, retain it.
    const currentSnapshot = retainedKey(pin, currentBytes);
    if (objects.has(currentSnapshot)) roots.add(currentSnapshot);
    // A missing referenced object is a broken release: never attempt cleanup.
    for (const k of roots) need(objects.has(k), "gc-root-not-listed");
    for (const [k, bytes] of references) need(objects.get(k)!.bytes === bytes, "gc-reference-size");
    result.reachableObjects = roots.size;
    const shardPattern = new RegExp(`^${prefix}s[0-9]{2}/[a-f0-9]{64}\\.json\\.gz$`);
    const retainedPattern = new RegExp(`^${prefix}retained/[a-f0-9]{64}\\.json$`);
    for (const object of objects.values()) {
      if (!roots.has(object.key) && (shardPattern.test(object.key) || retainedPattern.test(object.key)) &&
        Date.parse(options.now) - Date.parse(object.uploadedAt) >= GRACE_MS) result.eligible.push(object.key);
    }
    result.eligible.sort();
    // Re-read both mutable roots before ANY delete. The lock is still mandatory:
    // an optimistic comparison alone cannot close a subsequent writer race.
    need(sha256(await get(currentKey, LIVE_LIMITS.manifestBytes)) === sha256(currentBytes) &&
      sha256(await get(indexKey, 250_000)) === sha256(indexBytes), "gc-roots-changed");
    const selected = result.eligible.slice(0, maxDeletes);
    need(result.operations.total + (result.dryRun ? 0 : selected.length) <= maxOps, "gc-operation-cap");
    if (!result.dryRun) for (const k of selected) { op("deletes"); await store.delete(k); result.deleted.push(k); }
    result.ok = true;
  } catch (e) { result.error = e instanceof Error ? e.message : "gc-error"; }
  return result;
}

export interface UsageBudget {
  /** Durable month-to-date attempted ops, including uncertain/failed requests.
   * Future adapter must reserve quota durably BEFORE dispatch, across restarts. */
  classA: number; classB: number; total: number;
}
/** Shared hard caps: inventory counts bytes before publication; reserve full
 * prospective upload size (even overwrite bytes) and count failed attempts.
 * These are pipeline limits, not a provider-enforced account billing cap. */
export function assertBudget(used: UsageBudget, reserve: UsageBudget): void {
  for (const b of [used, reserve]) for (const v of Object.values(b)) need(Number.isSafeInteger(v) && v >= 0, "budget-invalid");
  need(used.classA + reserve.classA <= 750_000 && used.classB + reserve.classB <= 9_000_000 &&
    used.total + reserve.total <= 10_000_000, "pipeline-budget-exceeded");
}
