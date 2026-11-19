import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { parseManifestBytes, parseShardBytes, type LiveManifest } from "../../shared/liveStatus.ts";
import { assemble, sha256 } from "../../tools/live-status/assemble.ts";
import { loadCheckpoint, manifestKey, publish } from "../../tools/live-status/publish.ts";
import { runCycle, type CycleOptions } from "../../tools/live-status/cycle.ts";
import { MemoryStore, assembly, encode, geometry, makeClock, pin, response, xml } from "./live-status-publish-fixtures.ts";
const now = () => "2026-11-17T02:02:00.000Z";
function cycle(store = new MemoryStore(), overrides: Partial<CycleOptions> = {}): CycleOptions {
  return { store, fetch: async () => response(xml(), { etag: '"v1"', "last-modified": "Tue, 17 Nov 2026 01:59:00 GMT" }), clock: makeClock(), geometry, geometrySha256: pin,
    sourceUrl: "https://source.invalid/capture.xml", partitionRows: 2, ...overrides };
}
async function seed(store = new MemoryStore()): Promise<{ store: MemoryStore; previous: LiveManifest }> {
  const result = await publish({ store, geometrySha256: pin, previous: null, candidate: assembly(), now });
  if (!result.ok) throw new Error(result.error);
  store.puts = []; store.gets = [];
  return { store, previous: result.checkpoint };
}
async function completeReferences(store: MemoryStore): Promise<LiveManifest> {
  const m = await loadCheckpoint(store, pin); if (!m) throw new Error("missing manifest");
  for (const ref of m.shards) {
    const compressed = store.objects.get(ref.key); if (!compressed) throw new Error("dangling reference");
    await parseShardBytes(new Uint8Array(gunzipSync(compressed)), pin, ref);
  }
  return m;
}
describe("LIVE-2 atomic diff-only publication", () => {
  it("publishes immutable shards first and the single manifest/checkpoint last", async () => {
    const store = new MemoryStore(); const candidate = assembly();
    const result = await publish({ store, geometrySha256: pin, previous: null, candidate, now });
    expect(result.ok).toBe(true); expect(result).toMatchObject({ classAOperations: 3, shardPuts: 2, manifestPuts: 1 });
    expect(store.puts.map(p => p.key)).toEqual([...candidate.manifest.shards.map(s => s.key), manifestKey(pin)]);
    for (const put of store.puts.slice(0, -1)) expect(put.metadata).toEqual({ contentType: "application/json", contentEncoding: "gzip", cacheControl: "public, max-age=31536000, immutable" });
    expect(store.puts[2].metadata).toEqual({ contentType: "application/json", cacheControl: "public, max-age=60" });
    expect((await completeReferences(store)).source).toEqual(candidate.manifest.source);
  });
  it("retains unchanged shard hashes without re-PUT or per-shard reads", async () => {
    const { store, previous } = await seed();
    const result = await publish({ store, geometrySha256: pin, previous, candidate: assembly(), now });
    expect(result).toMatchObject({ ok: true, classAOperations: 1, shardPuts: 0, manifestPuts: 1 });
    expect(store.puts.map(p => p.key)).toEqual([manifestKey(pin)]); expect(store.gets).toEqual([]);
    expect(result.checkpoint?.shards).toEqual(previous.shards);
  });
  it("PUTs only the one changed shard, retaining the other reference", async () => {
    const { store, previous } = await seed(); const candidate = assembly("1");
    const changed = candidate.manifest.shards.filter((ref, i) => ref.sha256 !== previous.shards[i].sha256);
    expect(changed.length).toBe(1);
    const result = await publish({ store, geometrySha256: pin, previous, candidate, now });
    expect(result).toMatchObject({ ok: true, classAOperations: 2, shardPuts: 1, manifestPuts: 1 });
    expect(store.puts.map(p => p.key)).toEqual([changed[0].key, manifestKey(pin)]); await completeReferences(store);
  });
  it("retains published gzip metadata when only the compression representation changes", async () => {
    const { store, previous } = await seed(); const candidate = assembly();
    // The gzip OS header does not change the decoded semantic payload.
    candidate.shards[0].gzip[9] = 3;
    candidate.manifest.shards[0].gzipSha256 = sha256(candidate.shards[0].gzip);
    candidate.manifestBytes = encode(JSON.stringify(candidate.manifest));
    expect(candidate.manifest.shards[0].gzipSha256).not.toBe(previous.shards[0].gzipSha256);
    const result = await publish({ store, geometrySha256: pin, previous, candidate, now });
    expect(result).toMatchObject({ ok: true, classAOperations: 1, shardPuts: 0 });
    expect(result.checkpoint?.shards).toEqual(previous.shards); await completeReferences(store);
  });
  it("304 heartbeat updates only check/delivery clocks and preserves every source/version field", async () => {
    const { store, previous } = await seed(); const saved = JSON.stringify(previous);
    const checkedAt = "2026-11-17T02:05:00.000Z"; const publishedAt = "2026-11-17T02:05:02.000Z";
    const result = await publish({ store, geometrySha256: pin, previous, candidate: { checkedAt }, now: () => publishedAt });
    expect(result).toMatchObject({ ok: true, classAOperations: 1, shardPuts: 0, manifestPuts: 1 });
    expect(result.checkpoint).toEqual({ ...previous, checkedAt, publishedAt }); expect(JSON.stringify(previous)).toBe(saved);
    expect(store.puts.map(p => p.key)).toEqual([manifestKey(pin)]);
  });
  it("does not fabricate a first checkpoint from a heartbeat", async () => {
    const store = new MemoryStore();
    expect(await publish({ store, geometrySha256: pin, previous: null, candidate: { checkedAt: now() }, now })).toMatchObject({ ok: false, error: "heartbeat-without-checkpoint", classAOperations: 0 });
    expect(store.puts).toEqual([]);
  });
  it.each([false, true])("partial shard failure leaves the prior complete manifest and supports safe replay (existing=%s)", async existing => {
    const store = new MemoryStore(); const previous = existing ? (await seed(store)).previous : null;
    // Change both logical shards so one succeeds before the next fails.
    const candidate = assembly("1");
    if (existing) {
      // A new geometry-independent change in provider time rewrites both shards.
      Object.assign(candidate, assemble({ xml: encode(xml("1").replaceAll("09:00:00", "09:01:00")), geometry, capturedAt: "2026-11-17T02:03:00.000Z", checkedAt: "2026-11-17T02:03:01.000Z", publishedAt: "2026-11-17T02:03:02.000Z", etag: '"v2"', lastModified: "2026-11-17T02:02:59.000Z", partitionRows: 2 }));
    }
    const failedKey = candidate.manifest.shards[1].key; store.fail = key => key === failedKey;
    const publishNow = () => "2026-11-17T02:04:00.000Z";
    const failed = await publish({ store, geometrySha256: pin, previous, candidate, now: publishNow });
    expect(failed).toMatchObject({ ok: false, checkpoint: previous, classAOperations: 2, shardPuts: 2, manifestPuts: 0 });
    expect(store.objects.has(candidate.manifest.shards[0].key)).toBe(true); expect(store.objects.has(failedKey)).toBe(false);
    expect(await loadCheckpoint(store, pin)).toEqual(previous);
    expect(store.puts.some(p => p.key === manifestKey(pin))).toBe(false);
    const originalUpload = store.objects.get(candidate.manifest.shards[0].key)!.slice();
    store.fail = null; store.puts = [];
    const retry = await publish({ store, geometrySha256: pin, previous: await loadCheckpoint(store, pin), candidate, now: publishNow });
    expect(retry).toMatchObject({ ok: true, classAOperations: 3, shardPuts: 2, manifestPuts: 1 });
    expect(store.objects.get(candidate.manifest.shards[0].key)).toEqual(originalUpload);
    expect((await completeReferences(store)).source.etag).toBe(candidate.manifest.source.etag);
  });
  it("manifest PUT failure does not advance the checkpoint or validators", async () => {
    const { store, previous } = await seed(); const candidate = assembly("1");
    candidate.manifest.source.etag = '"v2"'; candidate.manifestBytes = encode(JSON.stringify(candidate.manifest));
    store.fail = key => key === manifestKey(pin);
    const failed = await publish({ store, geometrySha256: pin, previous, candidate, now });
    expect(failed).toMatchObject({ ok: false, checkpoint: previous, classAOperations: 2, shardPuts: 1, manifestPuts: 1 });
    expect((await completeReferences(store)).source.etag).toBe('"v1"');
    store.fail = null;
    const retry = await publish({ store, geometrySha256: pin, previous: await loadCheckpoint(store, pin), candidate, now });
    expect(retry).toMatchObject({ ok: true, classAOperations: 2 }); expect((await completeReferences(store)).source.etag).toBe('"v2"');
  });
  it("failed heartbeat leaves the successful-check clock unchanged", async () => {
    const { store, previous } = await seed(); store.fail = () => true;
    const result = await publish({ store, geometrySha256: pin, previous, candidate: { checkedAt: now() }, now });
    expect(result).toMatchObject({ ok: false, checkpoint: previous, classAOperations: 1, shardPuts: 0, manifestPuts: 1 });
    expect(await loadCheckpoint(store, pin)).toEqual(previous);
  });
  it.each(["candidate", "previous", "pin"])("geometry release mismatch in %s fails before any writes", async mismatch => {
    const { store, previous } = await seed(); const candidate = assembly(); let expectedPin = pin;
    if (mismatch === "candidate") { candidate.manifest.geometrySha256 = "b".repeat(64); candidate.manifestBytes = encode(JSON.stringify(candidate.manifest)); }
    if (mismatch === "previous") previous.geometrySha256 = "b".repeat(64);
    if (mismatch === "pin") expectedPin = "b".repeat(64);
    const result = await publish({ store, geometrySha256: expectedPin, previous, candidate, now });
    expect(result).toMatchObject({ ok: false, classAOperations: 0 }); expect(store.puts).toEqual([]);
  });
  it.each(["manifest", "decoded", "gzip", "shard-set"])("corrupt %s candidate is rejected before the first PUT", async part => {
    const store = new MemoryStore(); const candidate = assembly();
    if (part === "manifest") candidate.manifest.generation = "b".repeat(64);
    if (part === "decoded") candidate.shards[1].bytes[0] ^= 1;
    if (part === "gzip") candidate.shards[1].gzip[0] ^= 1;
    if (part === "shard-set") candidate.shards.pop();
    const result = await publish({ store, geometrySha256: pin, previous: null, candidate, now });
    expect(result).toMatchObject({ ok: false, classAOperations: 0 }); expect(store.puts).toEqual([]);
  });
  it.each(["check", "publish", "invalid"])("rejects a regressing/invalid %s clock without advancing state", async kind => {
    const { store, previous } = await seed();
    const result = await publish({ store, geometrySha256: pin, previous,
      candidate: { checkedAt: kind === "check" ? "2026-11-17T01:59:59.000Z" : "2026-11-17T02:05:00.000Z" },
      now: () => kind === "invalid" ? "invalid" : "2026-11-17T02:02:00.000Z" });
    expect(result).toMatchObject({ ok: false, classAOperations: 0 }); expect(store.puts).toEqual([]);
  });
  it("publication clock is sampled after all shard PUTs, distinct from source clocks", async () => {
    const store = new MemoryStore(); const clock = makeClock("2026-11-17T02:10:00.000Z");
    const originalPut = store.put.bind(store); let lastShardAt = "";
    store.put = async (key, bytes, metadata) => { await originalPut(key, bytes, metadata); if (!key.endsWith("manifest.json")) lastShardAt = clock.now(); };
    const result = await publish({ store, geometrySha256: pin, previous: null, candidate: assembly(), now: () => clock.now() });
    expect(result.ok).toBe(true); expect(result.checkpoint!.publishedAt > lastShardAt).toBe(true);
    expect(result.checkpoint!.source.batchNewestAt).toBe("2026-11-17T01:50:00.000Z");
    expect(result.checkpoint!.source.lastModified).toBe("2026-11-17T01:59:00.000Z");
    expect(result.checkpoint!.source.capturedAt).toBe("2026-11-17T02:00:00.000Z");
    expect(result.checkpoint!.checkedAt).toBe("2026-11-17T02:00:01.000Z");
  });
  it("a clock regression after shard uploads leaves only unreachable objects", async () => {
    const store = new MemoryStore(); let calls = 0;
    const result = await publish({ store, geometrySha256: pin, previous: null, candidate: assembly(), now: () => ++calls === 1 ? now() : "2026-11-17T01:00:00.000Z" });
    expect(result).toMatchObject({ ok: false, classAOperations: 2, manifestPuts: 0 }); expect(await loadCheckpoint(store, pin)).toBeNull();
  });
});
describe("LIVE-2 injected one-shot cycle", () => {
  it("wires a 200 → unchanged 200 → conditional 304, with Class A counts 3 / 1 / 1", async () => {
    const store = new MemoryStore(); const clock = makeClock(); const opts = cycle(store, { clock });
    const first = await runCycle(opts); expect(first).toMatchObject({ ok: true, sourceStatus: 200, sourceAttempts: 1, classAOperations: 3, shardPuts: 2 });
    const second = await runCycle(opts); expect(second).toMatchObject({ ok: true, sourceStatus: 200, classAOperations: 1, shardPuts: 0 });
    const fetch = vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"ignored"' } }));
    const third = await runCycle({ ...opts, fetch });
    expect(third).toMatchObject({ ok: true, sourceStatus: 304, classAOperations: 1, shardPuts: 0 });
    expect(third.checkpoint?.source).toEqual(second.checkpoint?.source); expect(third.checkpoint?.generation).toBe(first.checkpoint?.generation);
    expect(third.checkpoint!.checkedAt > second.checkpoint!.checkedAt).toBe(true);
    expect(fetch.mock.calls[0]).toEqual([opts.sourceUrl, expect.objectContaining({ headers: expect.objectContaining({ "If-None-Match": '"v1"' }) })]);
    // One bounded manifest read per cycle, no per-shard HEAD/GET.
    expect(store.gets).toEqual([manifestKey(pin), manifestKey(pin), manifestKey(pin)]); await completeReferences(store);
  });
  it("uses IMS on the next cycle after a 200 without ETag", async () => {
    const store = new MemoryStore(); const clock = makeClock();
    expect((await runCycle(cycle(store, { clock, fetch: async () => response(xml(), { "last-modified": "Tue, 17 Nov 2026 01:59:00 GMT" }) }))).ok).toBe(true);
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    expect((await runCycle(cycle(store, { clock, fetch }))).ok).toBe(true);
    expect(fetch.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ headers: { "Accept-Encoding": "identity", "If-Modified-Since": "Tue, 17 Nov 2026 01:59:00 GMT" } })]);
  });
  it("preserves source version on 304 and clears missing validators on the next 200", async () => {
    const { store } = await seed(); const clock = makeClock("2026-11-17T02:05:00.000Z");
    const result = await runCycle(cycle(store, { clock, fetch: async () => response() }));
    expect(result).toMatchObject({ ok: true, classAOperations: 1 });
    expect(result.checkpoint?.source.etag).toBeNull(); expect(result.checkpoint?.source.lastModified).toBeNull();
    const fetch = vi.fn(async () => response()); await runCycle(cycle(store, { clock, fetch }));
    expect(fetch.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ headers: { "Accept-Encoding": "identity" } })]);
  });
  it("does not advance source/check clocks after malformed XML or failed HTTP", async () => {
    const { store, previous } = await seed();
    for (const fetch of [async () => response(xml().slice(0, -10)), async () => new Response(null, { status: 503 })]) {
      const result = await runCycle(cycle(store, { fetch, clock: makeClock("2026-11-17T02:05:00.000Z") }));
      expect(result).toMatchObject({ ok: false, checkpoint: previous, classAOperations: 0 });
      expect(await loadCheckpoint(store, pin)).toEqual(previous);
    }
    expect(store.puts).toEqual([]);
  });
  it("a failed final PUT makes the next cycle reuse committed request validators", async () => {
    const { store, previous } = await seed(); const clock = makeClock("2026-11-17T02:05:00.000Z");
    store.fail = key => key === manifestKey(pin);
    const fetch = vi.fn(async () => response(xml("1"), { etag: '"v2"' }));
    const opts = cycle(store, { clock, fetch });
    const failed = await runCycle(opts); expect(failed).toMatchObject({ ok: false, checkpoint: previous, classAOperations: 2 });
    store.fail = null; const retry = await runCycle(opts);
    expect(retry).toMatchObject({ ok: true, classAOperations: 2 });
    expect(retry.checkpoint?.source.etag).toBe('"v2"');
    for (const call of fetch.mock.calls) expect(call).toEqual([opts.sourceUrl, expect.objectContaining({ headers: expect.objectContaining({ "If-None-Match": '"v1"' }) })]);
    await completeReferences(store);
  });
  it("fails geometry pin mismatch before store reads, HTTP, or writes", async () => {
    const store = new MemoryStore(); const fetch = vi.fn(async () => response());
    const result = await runCycle(cycle(store, { fetch, geometrySha256: "b".repeat(64) }));
    expect(result).toMatchObject({ ok: false, error: "cycle-geometry-pin-mismatch", classAOperations: 0 });
    expect(fetch).not.toHaveBeenCalled(); expect(store.gets).toEqual([]); expect(store.puts).toEqual([]);
  });
  it.each(["bad-json", "wrong-geometry", "bad-generation", "oversized"])("fails closed on %s checkpoint before HTTP/writes", async kind => {
    const { store, previous } = await seed(); const broken = { ...previous };
    if (kind === "wrong-geometry") broken.geometrySha256 = "b".repeat(64);
    if (kind === "bad-generation") broken.generation = "b".repeat(64);
    store.objects.set(manifestKey(pin), kind === "bad-json" ? encode("{") : kind === "oversized" ? new Uint8Array(32769) : encode(JSON.stringify(broken)));
    const fetch = vi.fn(async () => response());
    const result = await runCycle(cycle(store, { fetch }));
    expect(result).toMatchObject({ ok: false, classAOperations: 0 }); expect(fetch).not.toHaveBeenCalled(); expect(store.puts).toEqual([]);
  });
  it("distinguishes storage read failure from an absent checkpoint", async () => {
    const store = new MemoryStore(); store.get = async () => { throw new Error("read-unavailable"); };
    const fetch = vi.fn(async () => response());
    expect(await runCycle(cycle(store, { fetch }))).toMatchObject({ ok: false, error: "read-unavailable", classAOperations: 0 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("fails source success with a backwards check clock without publishing a fresh heartbeat", async () => {
    const { store, previous } = await seed();
    const result = await runCycle(cycle(store, { clock: makeClock("2026-11-17T01:59:00.000Z"), fetch: async () => new Response(null, { status: 304 }) }));
    expect(result).toMatchObject({ ok: false, checkpoint: previous, classAOperations: 0 }); expect(store.puts).toEqual([]);
  });
  it("the final manifest bytes validate independently of the returned checkpoint", async () => {
    const store = new MemoryStore(); const result = await runCycle(cycle(store));
    expect(result.checkpoint).toEqual(await parseManifestBytes(store.objects.get(manifestKey(pin))!, pin));
  });
});
