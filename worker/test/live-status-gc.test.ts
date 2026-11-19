import { describe, expect, it } from "vitest";
import { collectGarbage, GRACE_MS, assertBudget, retainedKey, retentionKey, type GcOptions, type GcStorage, type ListedObject } from "../../tools/live-status/gc.ts";
import { manifestKey } from "../../tools/live-status/publish.ts";
import { createR2Adapter, type R2Adapter } from "../../tools/live-status/r2-adapter.ts";
import { runEntrypoint } from "../../tools/live-status/runner-entrypoint.ts";
import { assembly, encode, geometry, makeClock, pin, response, xml } from "./live-status-publish-fixtures.ts";

const now = "2026-11-20T02:00:00.000Z";
const old = "2026-11-17T02:00:00.000Z";
const prefix = `live/v1/${pin}/`;
const orphan = (i: number) => `${prefix}s00/${String(i).padStart(64, "0")}.json.gz`;
class Store implements GcStorage {
  values = new Map<string, Uint8Array>();
  metadata = new Map<string, ListedObject>();
  deletes: string[] = []; gets: string[] = []; lists = 0;
  failDelete = false;
  set(key: string, bytes: Uint8Array, uploadedAt = old) { this.values.set(key, bytes); this.metadata.set(key, { key, bytes: bytes.length, uploadedAt }); }
  async get(key: string) { this.gets.push(key); return this.values.get(key) ?? null; }
  async list({ cursor, limit }: { prefix: string; cursor: string | null; limit: number }) {
    this.lists++; const all = [...this.metadata.values()]; const start = Number(cursor ?? 0);
    return { objects: all.slice(start, start + limit), cursor: start + limit < all.length ? String(start + limit) : null };
  }
  async delete(key: string) { this.deletes.push(key); if (this.failDelete) throw new Error("delete-failed"); this.values.delete(key); this.metadata.delete(key); }
}
function seeded() {
  const store = new Store(); const a = assembly();
  store.set(manifestKey(pin), a.manifestBytes);
  store.set(retentionKey(pin), encode(JSON.stringify({ v: 1, geometrySha256: pin, manifests: [] })));
  for (const s of a.manifest.shards) store.set(s.key, new Uint8Array(s.gzipBytes));
  store.set(orphan(1), new Uint8Array(8));
  return store;
}
function options(store = seeded(), overrides: Partial<GcOptions> = {}): GcOptions { return { store, geometrySha256: pin, now, exclusivePublisher: true, ...overrides }; }
describe("LIVE-3 reachability GC", () => {
  it("defaults to dry-run and counts LIST as A, root GETs as B", async () => {
    const store = seeded(); const r = await collectGarbage(options(store));
    expect(r).toMatchObject({ ok: true, dryRun: true, eligible: [orphan(1)], deleted: [], objects: 5, reachableObjects: 4,
      operations: { classA: 1, classB: 4, lists: 1, gets: 4, deletes: 0, total: 5 } });
    expect(store.deletes).toEqual([]);
  });
  it("deletes unreachable old shards while retaining old unchanged active shards", async () => {
    const store = seeded(); const r = await collectGarbage(options(store, { dryRun: false }));
    expect(r.ok).toBe(true); expect(r.deleted).toEqual([orphan(1)]);
    expect(r.operations).toMatchObject({ classA: 1, classB: 4, deletes: 1, total: 6 });
    for (const ref of assembly().manifest.shards) expect(store.values.has(ref.key)).toBe(true);
  });
  it("protects every retained manifest and all of its references regardless of age", async () => {
    const store = seeded(); const previous = assembly("1"); const k = retainedKey(pin, previous.manifestBytes);
    store.set(k, previous.manifestBytes);
    store.set(retentionKey(pin), encode(JSON.stringify({ v: 1, geometrySha256: pin, manifests: [k] })));
    for (const s of previous.manifest.shards) store.set(s.key, new Uint8Array(s.gzipBytes));
    const r = await collectGarbage(options(store, { dryRun: false }));
    expect(r.ok).toBe(true); expect(r.deleted).toEqual([orphan(1)]); expect(r.operations.classB).toBe(5);
    expect(store.values.has(k)).toBe(true);
    for (const s of previous.manifest.shards) expect(store.values.has(s.key)).toBe(true);
  });
  it("preserves a snapshot of the current manifest and explicit rollback pins", async () => {
    const store = seeded(); const current = assembly().manifestBytes; const currentKey = retainedKey(pin, current);
    const previous = assembly("1"); const pinned = retainedKey(pin, previous.manifestBytes);
    store.set(currentKey, current); store.set(pinned, previous.manifestBytes);
    for (const shard of previous.manifest.shards) store.set(shard.key, new Uint8Array(shard.gzipBytes));
    store.set(retentionKey(pin), encode(JSON.stringify({ v: 1, geometrySha256: pin, manifests: [], pins: [pinned] })));
    const result = await collectGarbage(options(store, { dryRun: false }));
    expect(result.ok).toBe(true); expect(result.deleted).not.toContain(currentKey); expect(result.deleted).not.toContain(pinned);
  });
  it("reclaims a pruned unreferenced immutable snapshot after grace", async () => {
    const store = seeded(); const b = assembly("1").manifestBytes; const k = retainedKey(pin, b); store.set(k, b);
    const r = await collectGarbage(options(store, { dryRun: false }));
    expect(r.ok).toBe(true); expect(r.deleted).toContain(k);
  });
  it("retains young orphan uploads and deletes at the exact 48h boundary", async () => {
    const store = seeded(); const at = Date.parse(now);
    store.metadata.get(orphan(1))!.uploadedAt = new Date(at - GRACE_MS + 1).toISOString();
    expect((await collectGarbage(options(store))).eligible).toEqual([]);
    store.metadata.get(orphan(1))!.uploadedAt = new Date(at - GRACE_MS).toISOString();
    expect((await collectGarbage(options(store))).eligible).toEqual([orphan(1)]);
  });
  it("bounds deletes deterministically and completes a paginated inventory", async () => {
    const store = seeded(); store.set(orphan(3), new Uint8Array(1)); store.set(orphan(2), new Uint8Array(1));
    const r = await collectGarbage(options(store, { dryRun: false, pageSize: 2, maxDeletes: 1 }));
    expect(r.ok).toBe(true); expect(r.eligible).toEqual([orphan(1), orphan(2), orphan(3)]);
    expect(r.deleted).toEqual([orphan(1)]); expect(r.operations.lists).toBe(4);
  });
  it("inventories every bucket prefix without deleting other releases", async () => {
    const store = seeded();
    const other = `live/v1/${"c".repeat(64)}/s00/${"b".repeat(64)}.json.gz`;
    store.set(other, new Uint8Array(50));
    store.set("unrelated/object", new Uint8Array(100));
    const listedPrefixes: string[] = [];
    const list = store.list.bind(store);
    store.list = async opts => { listedPrefixes.push(opts.prefix); return list(opts); };
    const result = await collectGarbage(options(store, { dryRun: false, pageSize: 2 }));
    expect(result.ok, result.error).toBe(true);
    expect(listedPrefixes.length).toBeGreaterThan(1);
    expect(listedPrefixes.every(p => p === "")).toBe(true);
    expect(result.storageBytes).toBe([...store.metadata.values()].reduce((n, obj) => n + obj.bytes, 0) + 8);
    expect(result.deleted).toEqual([orphan(1)]);
    expect(store.values.has(other)).toBe(true);
    expect(store.values.has("unrelated/object")).toBe(true);
  });
  it("refuses GC when an object outside the release exceeds the bucket cap", async () => {
    const store = seeded();
    store.set("outside/large", new Uint8Array(0));
    store.metadata.get("outside/large")!.bytes = 1_999_999_999;
    const result = await collectGarbage(options(store, { dryRun: false }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("gc-inventory-storage-cap");
    expect(store.deletes).toEqual([]);
  });
  it("supports a zero-delete cap", async () => { const r = await collectGarbage(options(seeded(), { dryRun: false, maxDeletes: 0 })); expect(r.ok).toBe(true); expect(r.deleted).toEqual([]); });
  it("never deletes unknown key types", async () => {
    const store = seeded(); store.set(`${prefix}operator-note.txt`, new Uint8Array(5));
    const r = await collectGarbage(options(store, { dryRun: false })); expect(r.deleted).toEqual([orphan(1)]); expect(store.values.has(`${prefix}operator-note.txt`)).toBe(true);
  });
  it.each([manifestKey(pin), retentionKey(pin)])("fails closed when required root %s is missing", async key => {
    const store = seeded(); store.values.delete(key); const r = await collectGarbage(options(store, { dryRun: false }));
    expect(r.ok).toBe(false); expect(r.deleted).toEqual([]);
  });
  it("fails closed when a retained manifest is missing", async () => {
    const store = seeded(); store.set(retentionKey(pin), encode(JSON.stringify({ v: 1, geometrySha256: pin, manifests: [`${prefix}retained/${"f".repeat(64)}.json`] })));
    const r = await collectGarbage(options(store, { dryRun: false })); expect(r.ok).toBe(false); expect(r.deleted).toEqual([]);
  });
  it("rejects retained snapshot hash corruption", async () => {
    const store = seeded(); const k = `${prefix}retained/${"f".repeat(64)}.json`; store.set(k, assembly().manifestBytes);
    store.set(retentionKey(pin), encode(JSON.stringify({ v: 1, geometrySha256: pin, manifests: [k] })));
    expect((await collectGarbage(options(store))).error).toBe("gc-retained-hash");
  });
  it.each([
    { v: 2, geometrySha256: pin, manifests: [] }, { v: 1, geometrySha256: "b".repeat(64), manifests: [] },
    { v: 1, geometrySha256: pin, manifests: ["../manifest.json"] },
    { v: 1, geometrySha256: pin, manifests: ["x", "x"] },
  ])("rejects invalid retention inventories %#", async index => {
    const store = seeded(); store.set(retentionKey(pin), encode(JSON.stringify(index)));
    const r = await collectGarbage(options(store, { dryRun: false })); expect(r.ok).toBe(false); expect(store.deletes).toEqual([]);
  });
  it("rejects a corrupt current manifest", async () => {
    const store = seeded(); store.set(manifestKey(pin), encode("{}")); expect((await collectGarbage(options(store))).ok).toBe(false);
  });
  it("requires listed reachability and correct stored sizes", async () => {
    const store = seeded(); const k = assembly().manifest.shards[0].key; store.metadata.delete(k);
    expect((await collectGarbage(options(store))).error).toBe("gc-root-not-listed");
    store.metadata.set(k, { key: k, bytes: 1, uploadedAt: old });
    expect((await collectGarbage(options(store))).error).toBe("gc-reference-size");
  });
  it.each([
    { maxObjects: 1 }, { maxStorageBytes: 1 }, { maxOperations: 4 }, { maxListPages: 1, pageSize: 1 },
    { maxDeletes: 5001 }, { maxOperations: 10_001 }, { maxStorageBytes: 2_000_000_001 },
    { maxRetainedManifests: -1 }, { now: "invalid" }, { geometrySha256: "invalid" },
    { exclusivePublisher: false as unknown as true },
  ])("fails closed at policy/inventory/operation guards %#", async overrides => {
    const store = seeded(); const r = await collectGarbage(options(store, { dryRun: false, ...overrides }));
    expect(r.ok).toBe(false); expect(store.deletes).toEqual([]);
  });
  it.each(["uploadedAt", "bytes", "key"])("rejects unsafe metadata: %s", async field => {
    const store = seeded(); const meta = store.metadata.get(orphan(1))!;
    if (field === "uploadedAt") meta.uploadedAt = "2027-01-01T00:00:00.000Z";
    if (field === "bytes") meta.bytes = -1;
    if (field === "key") meta.key = "";
    expect((await collectGarbage(options(store))).ok).toBe(false); expect(store.deletes).toEqual([]);
  });
  it("rejects duplicate listing entries and repeated cursors", async () => {
    const store = seeded(); const obj = store.metadata.get(orphan(1))!;
    store.list = async () => ({ objects: [obj, obj], cursor: null });
    expect((await collectGarbage(options(store))).error).toBe("gc-object-metadata");
    store.list = async () => ({ objects: [], cursor: "loop" });
    expect((await collectGarbage(options(store))).error).toBe("gc-list-cursor-loop");
  });
  it("rechecks mutable roots and refuses a changed checkpoint", async () => {
    const store = seeded(); const original = store.get.bind(store);
    store.get = async key => key === manifestKey(pin) && store.gets.includes(key) ? assembly("1").manifestBytes : original(key);
    const r = await collectGarbage(options(store, { dryRun: false })); expect(r.error).toBe("gc-roots-changed"); expect(store.deletes).toEqual([]);
  });
  it("counts a failed LIST attempt", async () => {
    const store = seeded(); store.list = async () => { throw new Error("list-failed"); };
    const r = await collectGarbage(options(store)); expect(r.error).toBe("list-failed"); expect(r.operations).toMatchObject({ classA: 1, classB: 2, total: 3 });
  });
  it("counts a failed delete and stops without retrying", async () => {
    const store = seeded(); store.failDelete = true; store.set(orphan(2), new Uint8Array(1));
    const r = await collectGarbage(options(store, { dryRun: false })); expect(r.error).toBe("delete-failed");
    expect(r.operations.deletes).toBe(1); expect(r.deleted).toEqual([]); expect(store.deletes).toEqual([orphan(1)]);
  });
  it.each(["classA", "classB", "total"] as const)("enforces cumulative %s budget", field => {
    const caps = { classA: 750_000, classB: 9_000_000, total: 10_000_000 };
    const used = { classA: 0, classB: 0, total: 0 }; used[field] = caps[field];
    expect(() => assertBudget(used, { classA: 0, classB: 0, total: 0 })).not.toThrow();
    expect(() => assertBudget(used, { ...{ classA: 0, classB: 0, total: 0 }, [field]: 1 })).toThrow("pipeline-budget-exceeded");
  });
  it("rejects missing/invalid durable usage rather than resetting it", () => {
    expect(() => assertBudget({ classA: NaN, classB: 0, total: 0 }, { classA: 0, classB: 0, total: 0 })).toThrow("budget-invalid");
  });
  it("R2 client fails closed before network access when env is missing", () => {
    const fetchImpl = () => { throw new Error("network"); };
    expect(() => createR2Adapter({ env: {}, fetch: fetchImpl })).toThrow("missing-r2-env:R2_ACCOUNT_ID,R2_BUCKET,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY");
  });
  it("runs LIVE-2 under one exclusive publisher", async () => {
    const store = seeded(); store.values.clear(); const calls: string[] = []; let locked = false;
    const adapter: R2Adapter = {
      async inventory() { return 1; },
      async withExclusivePublisher(fn) { calls.push("lock"); locked = true; try { return await fn(); } finally { locked = false; calls.push("unlock"); } },
      async usage() { expect(locked).toBe(true); return { classA: 0, classB: 0, total: 0 }; },
      async reserve() { calls.push("reserve"); },
      async head() { return null; },
      async get(key) { expect(locked).toBe(true); calls.push("get"); return store.values.get(key) ?? null; },
      async put(key, bytes) { expect(locked).toBe(true); calls.push("put"); store.set(key, bytes); },
      list: opts => store.list(opts), delete: k => store.delete(k),
    };
    const r = await runEntrypoint({ adapter, geometry, geometrySha256: pin, clock: makeClock(), fetch: async () => response(xml()), sourceUrl: "https://source.invalid/capture.xml" });
    expect(r.cycle.ok).toBe(true); expect(calls).toEqual(["lock", "get", "reserve", "put", "put", "unlock"]);
  });
  it("stops before source HTTP when cumulative preflight budget is exhausted", async () => {
    let fetched = false;
    const adapter = { withExclusivePublisher: async (fn: () => Promise<unknown>) => fn(), usage: async () => ({ classA: 750_000, classB: 0, total: 0 }) } as R2Adapter;
    await expect(runEntrypoint({ adapter, geometry, geometrySha256: pin, clock: makeClock(), fetch: async () => { fetched = true; return response(xml()); }, sourceUrl: "https://source.invalid" })).rejects.toThrow("pipeline-budget-exceeded");
    expect(fetched).toBe(false);
  });
});
