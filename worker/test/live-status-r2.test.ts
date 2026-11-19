import { execPath } from "node:process";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { authorizationHeader } from "../../tools/live-status/sigv4.ts";
import { createR2Adapter, type R2Adapter } from "../../tools/live-status/r2-adapter.ts";
import { runCycle } from "../../tools/live-status/cycle.ts";
import { collectGarbage } from "../../tools/live-status/gc.ts";
import { runEntrypoint } from "../../tools/live-status/runner-entrypoint.ts";
import { assembly, geometry, makeClock, pin, response, xml } from "./live-status-publish-fixtures.ts";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const ACCESS = "AKIDEXAMPLE";
const ENV = {
  R2_ACCOUNT_ID: "abc123", R2_BUCKET: "my-bucket",
  R2_ACCESS_KEY_ID: ACCESS, R2_SECRET_ACCESS_KEY: SECRET,
};
const NOW = new Date("2026-11-17T02:00:00.000Z");
const ACCT = "live-status/accounting/2026-11.json";
const enc = new TextEncoder();
const dec = new TextDecoder();
const meta = { contentType: "application/json" as const, cacheControl: "public, max-age=60" };
const gz = { ...meta, contentEncoding: "gzip" as const };

interface Stored { body: Uint8Array; headers: Record<string, string> }
class FakeR2 {
  objects = new Map<string, Stored>();
  calls: { method: string; url: string; headers: Headers; body: Uint8Array | null }[] = [];
  pulled = false;
  failStatus: { key: string; status: number; remaining: number } | null = null;
  throwOn: { key: string; error: Error } | null = null;
  redirect = false;
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body instanceof Uint8Array ? init.body : null;
    const headers = new Headers(init?.headers);
    this.calls.push({ method, url, headers, body });
    if (this.redirect) return new Response(null, { status: 302, headers: { location: "https://evil.example/signed?X-Amz-Signature=abc" } });
    const key = keyOf(url);
    if (this.throwOn && key.includes(this.throwOn.key)) throw this.throwOn.error;
    if (this.failStatus && key.includes(this.failStatus.key) && this.failStatus.remaining > 0) {
      this.failStatus.remaining -= 1;
      return new Response("nope", { status: this.failStatus.status });
    }
    const u = new URL(url);
    if (u.searchParams.get("list-type") === "2") return this.list(u);
    if (method === "PUT" && key) {
      this.objects.set(key, { body: body ?? new Uint8Array(), headers: {
        "content-type": headers.get("content-type") ?? "",
        "content-encoding": headers.get("content-encoding") ?? "",
        "cache-control": headers.get("cache-control") ?? "",
      } });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE" && key) { this.objects.delete(key); return new Response(null, { status: 204 }); }
    const stored = key ? this.objects.get(key) : undefined;
    if (!stored) return new Response(null, { status: 404 });
    const declared = stored.headers["content-length"];
    if (declared === "999999") {
      const stream = new ReadableStream({ pull: controller => { this.pulled = true; controller.close(); } });
      return new Response(stream, { status: 200, headers: { "content-length": declared, "last-modified": "Tue, 17 Nov 2026 02:00:00 GMT" } });
    }
    return new Response(stored.body as BodyInit, { status: 200, headers: {
      "content-length": String(stored.body.byteLength), "content-type": stored.headers["content-type"],
      "content-encoding": stored.headers["content-encoding"], "cache-control": stored.headers["cache-control"],
      "last-modified": "Tue, 17 Nov 2026 02:00:00 GMT",
    } });
  };
  private list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const limit = Number(url.searchParams.get("max-keys") ?? "0");
    const start = Number(url.searchParams.get("continuation-token") ?? "0");
    const all = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const page = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : null;
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated>${page.map(key => `<Contents><Key>${encodeURIComponent(key)}</Key><Size>${this.objects.get(key)!.body.byteLength}</Size><LastModified>2026-11-17T02:00:00.000Z</LastModified></Contents>`).join("")}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;
    return new Response(xml, { status: 200, headers: { "content-length": String(enc.encode(xml).byteLength) } });
  }
  seed(classA: number, extra: Partial<{ classB: number; total: number }> = {}) {
    const ledger = { v: 1, month: "2026-11", classA, classB: extra.classB ?? 0, total: extra.total ?? classA };
    this.objects.set(ACCT, { body: enc.encode(JSON.stringify(ledger)), headers: {} });
  }
}
function keyOf(url: string): string {
  const path = new URL(url).pathname;
  const prefix = "/my-bucket/";
  return path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : "";
}
function client(fake: FakeR2, env: Record<string, string> = ENV): R2Adapter {
  return createR2Adapter({ env, fetch: fake.fetch, now: () => NOW });
}
function ledger(fake: FakeR2): { classA: number; classB: number; total: number } {
  const stored = fake.objects.get(ACCT);
  if (!stored) throw new Error("missing-ledger");
  return JSON.parse(dec.decode(stored.body));
}
const reservation = { classA: 10, classB: 10, total: 30 };
const dataPuts = (fake: FakeR2, from = 0) => fake.calls.slice(from).filter(call => call.method === "PUT" && !keyOf(call.url).startsWith("live-status/accounting")).map(call => keyOf(call.url));

describe("LIVE-6a R2 client", () => {
  it("matches the published AWS Signature Version 4 example", async () => {
    const header = await authorizationHeader({
      method: "GET", canonicalUri: "/test.txt", query: [], payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1", service: "s3", amzDate: "20130524T000000Z",
      headers: [
        ["x-amz-date", "20130524T000000Z"],
        ["host", "examplebucket.s3.amazonaws.com"],
        ["x-amz-content-sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        ["range", "bytes=0-9"],
      ],
    });
    expect(header).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("signs R2 PUTs with header auth, payload hash, and no presigned URL", async () => {
    const fake = new FakeR2();
    const bytes = enc.encode("hello-r2");
    const adapter = client(fake);
    await adapter.withExclusivePublisher(async () => { await adapter.reserve(reservation); await adapter.put("widgets/hello", bytes, gz); });
    const put = fake.calls.find(call => call.method === "PUT" && keyOf(call.url) === "widgets/hello");
    expect(put).toBeTruthy();
    const url = put!.url;
    expect(url).toBe("https://abc123.r2.cloudflarestorage.com/my-bucket/widgets/hello");
    expect(url).not.toContain(SECRET); expect(url).not.toContain("X-Amz-"); expect(url).not.toContain(ACCESS);
    const authorization = put!.headers.get("authorization") ?? "";
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261117\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
    expect(authorization).toContain("SignedHeaders=cache-control;content-encoding;content-type;host;x-amz-content-sha256;x-amz-date");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    expect(put!.headers.get("x-amz-content-sha256")).toBe(hash);
    expect(put!.headers.get("content-type")).toBe("application/json");
    expect(put!.headers.get("content-encoding")).toBe("gzip");
    expect(put!.headers.get("cache-control")).toBe("public, max-age=60");
    const other = new FakeR2();
    const otherClient = client(other);
    await otherClient.withExclusivePublisher(async () => { await otherClient.reserve(reservation); await otherClient.put("widgets/hello", enc.encode("other"), gz); });
    const otherPut = other.calls.find(call => keyOf(call.url) === "widgets/hello")!;
    expect(otherPut.headers.get("authorization")).not.toBe(authorization);
  });

  it("does not retry 500, 429, redirects, or thrown network errors", async () => {
    for (const status of [500, 429]) {
      const fake = new FakeR2();
      fake.failStatus = { key: "widgets/hello", status, remaining: 5 };
      const adapter = client(fake);
      await expect(adapter.withExclusivePublisher(async () => { await adapter.reserve(reservation); await adapter.put("widgets/hello", enc.encode("x"), meta); })).rejects.toThrow(`r2-put-failed:${status}`);
      expect(fake.calls.filter(call => keyOf(call.url) === "widgets/hello")).toHaveLength(1);
    }
    const redirected = new FakeR2();
    redirected.redirect = true;
    const redirectedClient = client(redirected);
    await expect(redirectedClient.withExclusivePublisher(async () => { await redirectedClient.usage(); })).rejects.toThrow("r2-redirect-blocked");
    expect(redirected.calls).toHaveLength(1);
    expect(redirected.calls[0].url).not.toContain("evil.example");
    const crashed = new FakeR2();
    crashed.throwOn = { key: "accounting", error: new Error(`down ${SECRET} Authorization: AWS4-HMAC-SHA256 Credential=${ACCESS}/20261117/auto/s3/aws4_request, SignedHeaders=host, Signature=deadbeef`) };
    const logs: unknown[][] = [];
    const spy = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    const crashedClient = client(crashed);
    try {
      await expect(crashedClient.withExclusivePublisher(async () => { await crashedClient.usage(); })).rejects.toThrow(/r2-network/);
    } finally { console.log = spy; }
    expect(crashed.calls).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("redacts secrets and signed headers from errors", async () => {
    const fake = new FakeR2();
    fake.throwOn = { key: "widgets", error: new Error(`boom ${SECRET} ${ACCESS} X-Amz-Signature=abc123 X-Amz-Credential=${ACCESS}/20261117`) };
    let message = "";
    const adapter = client(fake);
    await adapter.withExclusivePublisher(async () => {
      try { await adapter.reserve(reservation); await adapter.put("widgets/hello", enc.encode("x"), meta); }
      catch (error) { message = error instanceof Error ? error.message : ""; }
    });
    expect(message).toContain("r2-network");
    expect(message).toContain("r2-network");
    expect(message).not.toContain(SECRET); expect(message).not.toContain(ACCESS);
    expect(message).not.toContain("abc123"); expect(message).not.toContain("deadbeef");
  });

  it("redacts RFC3986-encoded credentials even when fetch errors start with r2-", async () => {
    const secret = "ab!'()*xyz";
    const encoded = "ab%21%27%28%29%2Axyz";
    for (const value of [secret, encoded, encoded.toLowerCase(), "%61b%21%27%28%29%2axyz", "%61b!'()*xyz"]) {
      const fake = new FakeR2(); fake.throwOn = { key: "widgets", error: new Error(`r2-${value}`) };
      const adapter = client(fake, { ...ENV, R2_SECRET_ACCESS_KEY: secret });
      let message = "";
      try { await adapter.withExclusivePublisher(async () => {
        await adapter.reserve(reservation); await adapter.put("widgets/hello", enc.encode("x"), meta);
      }); } catch (error) { message = String(error); }
      expect(message).not.toContain(value);
      expect(message).toContain("r2-network");
    }
  });

  it("returns static errors for untrusted status bodies and redirect locations", async () => {
    for (const status of [500, 302]) {
      const fake = new FakeR2();
      const adapter = createR2Adapter({ env: ENV, now: () => NOW, fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("widgets")) return new Response(status === 302 ? null : `r2-%61bSecret123 ${SECRET}`, { status, headers: { location: `https://example.invalid/%61bSecret123/${SECRET}` } });
        return fake.fetch(input, init);
      } });
      let message = "";
      try { await adapter.withExclusivePublisher(async () => {
        await adapter.reserve(reservation); await adapter.get("widgets/hello", { maxBytes: 100 });
      }); } catch (error) { message = String(error); }
      expect(message).toContain(status === 302 ? "r2-redirect-blocked" : "r2-get-failed:500");
      expect(message).not.toContain("%61bSecret123"); expect(message).not.toContain(SECRET); expect(message).not.toContain("example.invalid");
    }
  });

  it("fails closed when any R2 env var is missing and does not touch the network", () => {
    const calls: unknown[] = [];
    const fetchImpl = () => { calls.push(1); throw new Error("network"); };
    expect(() => createR2Adapter({ env: {}, fetch: fetchImpl as typeof fetch })).toThrow("missing-r2-env:R2_ACCOUNT_ID,R2_BUCKET,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY");
    const partial = { ...ENV, R2_SECRET_ACCESS_KEY: "   " };
    expect(() => createR2Adapter({ env: partial, fetch: fetchImpl as typeof fetch })).toThrow("missing-r2-env:R2_SECRET_ACCESS_KEY");
    try { createR2Adapter({ env: partial, fetch: fetchImpl as typeof fetch }); } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(ACCESS);
      expect(error instanceof Error ? error.message : "").not.toContain(SECRET);
    }
    expect(calls).toEqual([]);
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("real-network"); }) as typeof fetch;
    try { expect(() => createR2Adapter({ env: {} })).toThrow(/missing-r2-env/); }
    finally { globalThis.fetch = original; }
  });

  it("counts failed PUTs and a crash after the write-ahead", async () => {
    const fake = new FakeR2();
    fake.failStatus = { key: "widgets/hello", status: 500, remaining: 1 };
    const adapter = client(fake);
    await expect(adapter.withExclusivePublisher(async () => { await adapter.reserve(reservation); await adapter.put("widgets/hello", enc.encode("x"), meta); })).rejects.toThrow("r2-put-failed:500");
    expect(fake.objects.has("widgets/hello")).toBe(false);
    expect(ledger(fake)).toMatchObject({ classA: 11, classB: 10 });
    const reloaded = client(fake);
    const usage = await reloaded.withExclusivePublisher(() => reloaded.usage());
    expect(usage.classA).toBeGreaterThanOrEqual(11);
    expect(usage.classB).toBeGreaterThanOrEqual(1);
  });

  it("keeps a reserved batch in the ledger when the process stops before the objects are written", async () => {
    const fake = new FakeR2();
    const adapter = client(fake);
    await adapter.withExclusivePublisher(async () => {
      await adapter.reserve({ classA: 2, classB: 1, total: 3 });
      const reserved = fake.calls.filter(call => call.method === "PUT" && keyOf(call.url) === ACCT).length;
      await adapter.put("widgets/a", new Uint8Array(4), meta);
      await adapter.put("widgets/b", new Uint8Array(4), meta);
      expect(fake.calls.filter(call => call.method === "PUT" && keyOf(call.url) === ACCT)).toHaveLength(reserved);
    });
    expect(ledger(fake).classA).toBe(3);
    const crashed = new FakeR2();
    const first = client(crashed);
    await first.withExclusivePublisher(async () => { await first.reserve({ classA: 2, classB: 1, total: 3 }); });
    expect(crashed.objects.has("widgets/a")).toBe(false);
    const again = client(crashed);
    const seen = await again.withExclusivePublisher(() => again.usage());
    expect(seen.classA).toBeGreaterThanOrEqual(3);
  });

  it("refuses to start at 750k Class A and aborts the next attempt mid-run", async () => {
    const full = new FakeR2();
    full.seed(750_000);
    let source = false;
    await expect(runEntrypoint({
      adapter: client(full), geometry, geometrySha256: pin, clock: makeClock(),
      fetch: async () => { source = true; return response(xml()); }, sourceUrl: "https://source.invalid/capture.xml",
    })).rejects.toThrow("pipeline-budget-exceeded");
    expect(source).toBe(false);
    expect(full.calls.filter(call => call.method === "PUT")).toEqual([]);
    const mid = new FakeR2();
    mid.seed(749_997);
    const adapter = client(mid);
    await adapter.withExclusivePublisher(async () => {
      await adapter.reserve({ classA: 1, classB: 1, total: 2 });
      await adapter.put("widgets/one", Uint8Array.of(1), meta);
      await expect(adapter.put("widgets/two", Uint8Array.of(2), meta)).rejects.toThrow("r2-reservation-short");
    });
    expect(mid.objects.has("widgets/one")).toBe(true);
    expect(mid.objects.has("widgets/two")).toBe(false);
    expect(mid.calls.filter(call => keyOf(call.url) === "widgets/two")).toHaveLength(0);
    expect(ledger(mid).classA).toBe(749_999);
  });

  it("counts LIST as Class A, HEAD/GET as Class B, and DELETE as free", async () => {
    const fake = new FakeR2();
    const adapter = client(fake);
    await adapter.withExclusivePublisher(async () => {
      await adapter.reserve(reservation);
      await adapter.put("live/v1/obj", enc.encode("abc"), meta);
      const before = await adapter.usage();
      expect(await adapter.head("missing")).toBeNull();
      const head = await adapter.head("live/v1/obj");
      expect(head).toMatchObject({ bytes: 3, uploadedAt: "2026-11-17T02:00:00.000Z", contentType: "application/json" });
      const listed = await adapter.list({ prefix: "live/v1/", cursor: null, limit: 10 });
      expect(listed.objects.map(object => object.key)).toContain("live/v1/obj");
      await adapter.delete("live/v1/obj");
      const after = await adapter.usage();
      expect(after.classB).toBe(before.classB);
      expect(after.classA).toBe(before.classA);
      expect(after.total).toBe(before.total);
    });
    const capped = new FakeR2();
    capped.objects.set("widgets/big", { body: new Uint8Array(4), headers: { "content-length": "999999" } });
    const cappedClient = client(capped);
    await cappedClient.withExclusivePublisher(async () => {
      await expect(cappedClient.get("widgets/big", { maxBytes: 10 })).rejects.toThrow("r2-object-too-large");
    });
    expect(capped.calls.filter(call => keyOf(call.url) === "widgets/big")).toHaveLength(1);
  });

  it("publishes shards before the manifest and keeps the 3/1 Class A audit", async () => {
    const fake = new FakeR2();
    const adapter = client(fake);
    const clock = makeClock();
    const source = async () => response(xml());
    const first = await adapter.withExclusivePublisher(() => runCycle({
      store: adapter, fetch: source, clock, sourceUrl: "https://source.invalid/capture.xml",
      geometry, geometrySha256: pin, partitionRows: 2,
    }));
    expect(first).toMatchObject({ ok: true, classAOperations: 3, shardPuts: 2, manifestPuts: 1 });
    const puts = dataPuts(fake);
    const shardAt = puts.findIndex(key => /\/s\d{2}\//.test(key));
    const indexAt = puts.findIndex(key => key.endsWith("/retention.json"));
    const manifestAt = puts.findIndex(key => key.endsWith("/manifest.json"));
    expect(shardAt).toBeGreaterThanOrEqual(0);
    expect(shardAt).toBeLessThan(indexAt);
    expect(indexAt).toBeLessThan(manifestAt);
    expect(puts.filter(key => /\/s\d{2}\//.test(key))).toHaveLength(2);
    const mark = fake.calls.length;
    const second = await adapter.withExclusivePublisher(() => runCycle({
      store: adapter, fetch: source, clock, sourceUrl: "https://source.invalid/capture.xml",
      geometry, geometrySha256: pin, partitionRows: 2,
    }));
    expect(second).toMatchObject({ ok: true, classAOperations: 1, shardPuts: 0, manifestPuts: 1 });
    const more = dataPuts(fake, mark);
    expect(more.some(key => /\/s\d{2}\//.test(key))).toBe(false);
    expect(more.map(key => key.includes("/retained/") ? "retained" : key.endsWith("/retention.json") ? "index" : key.endsWith("/manifest.json") ? "manifest" : key)).toEqual(["retained", "index", "manifest"]);
  });

  it("reserves once before writes and measures bootstrap, unchanged and 32 changed shards", async () => {
    const fake = new FakeR2();
    const spots = Array.from({ length: 32 }, (_, i) => ({ id: `tpe:測試路A:${i + 1}`, road: "測試路A", pkid: String(i + 1), lat: 25.05, lng: 121.53 + i / 10000 }));
    const manyGeometry = { sha256: pin, spots };
    const sourceXml = (status: string) => `<DATA><ROAD><roadSegID>1000A0</roadSegID><roadSegName>測試路A</roadSegName><roadSegUpdatetime>20261117T095000</roadSegUpdatetime><cellStatusList>${spots.map((_, i) => `<cell><psId>${i + 1}</psId><cellStatus>${status}</cellStatus><data_Dt>2026-11-17 09:00:00</data_Dt></cell>`).join("")}</cellStatusList></ROAD></DATA>`;
    let runNumber = 0;
    const run = async (status: string | null) => {
      const start = fake.calls.length; const adapter = client(fake);
      const result = await adapter.withExclusivePublisher(() => runCycle({ store: adapter, fetch: async () => status === null ? new Response(null, { status: 304 }) : response(sourceXml(status), { etag: '"v1"' }), clock: makeClock(`2026-11-17T02:0${++runNumber}:00.000Z`), sourceUrl: "https://source.invalid", geometry: manyGeometry, geometrySha256: pin, partitionRows: 1 }));
      expect(result.ok, result.ok ? undefined : result.error).toBe(true);
      const calls = fake.calls.slice(start); const puts = calls.filter(c => c.method === "PUT");
      expect(puts.filter(c => keyOf(c.url) === ACCT)).toHaveLength(1);
      expect(keyOf(puts[0].url)).toBe(ACCT);
      return calls.filter(c => c.method === "PUT" || new URL(c.url).searchParams.has("list-type")).length;
    };
    expect(await run("1")).toBe(36);
    expect(await run(null)).toBe(5);
    expect(await run("2")).toBe(37);
    const start = fake.calls.length; const gcAdapter = client(fake);
    const gc = await gcAdapter.withExclusivePublisher(() => collectGarbage({ store: gcAdapter, geometrySha256: pin, now: "2026-11-17T02:10:00.000Z", exclusivePublisher: true }));
    expect(gc.ok, gc.error).toBe(true);
    expect(fake.calls.slice(start).filter(c => c.method === "PUT" && keyOf(c.url) === ACCT)).toHaveLength(1);
  });

  it("uses one ledger PUT for publication, GC, and publication with GC", async () => {
    const fake = new FakeR2();
    const opts = { geometry, geometrySha256: pin, sourceUrl: "https://source.invalid", fetch: async () => response(xml()) };
    const count = (start: number) => fake.calls.slice(start).filter(c => c.method === "PUT" && keyOf(c.url) === ACCT).length;
    let start = fake.calls.length;
    await runEntrypoint({ ...opts, adapter: client(fake), clock: makeClock("2026-11-17T02:01:00.000Z") });
    expect(count(start)).toBe(1);
    start = fake.calls.length;
    await runEntrypoint({ ...opts, adapter: client(fake), clock: makeClock("2026-11-17T02:02:00.000Z"), gc: {} });
    expect(count(start)).toBe(1);
    start = fake.calls.length; const adapter = client(fake);
    const result = await adapter.withExclusivePublisher(() => collectGarbage({ store: adapter, geometrySha256: pin, now: "2026-11-17T02:10:00.000Z", exclusivePublisher: true }));
    expect(result.ok, result.error).toBe(true); expect(count(start)).toBe(1);
  });

  it("inventories before the standalone GC ledger PUT and fails closed on LIST failure", async () => {
    const fake = new FakeR2();
    const opts = { geometry, geometrySha256: pin, sourceUrl: "https://source.invalid", fetch: async () => response(xml()) };
    await runEntrypoint({ ...opts, adapter: client(fake), clock: makeClock("2026-11-17T02:01:00.000Z") });
    let start = fake.calls.length; const gcAdapter = client(fake);
    const result = await gcAdapter.withExclusivePublisher(() => collectGarbage({ store: gcAdapter, geometrySha256: pin, now: "2026-11-17T02:10:00.000Z", exclusivePublisher: true }));
    expect(result.ok, result.error).toBe(true);
    const calls = fake.calls.slice(start);
    const listAt = calls.findIndex(c => new URL(c.url).searchParams.has("list-type"));
    const putAt = calls.findIndex(c => c.method === "PUT");
    expect(listAt).toBeGreaterThanOrEqual(0); expect(listAt).toBeLessThan(putAt);
    expect(keyOf(calls[putAt].url)).toBe(ACCT);
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
    // Both the gate and GC's reachability scan are reserved.
    expect(calls.filter(c => new URL(c.url).searchParams.has("list-type"))).toHaveLength(2);
    expect(ledger(fake).classA).toBeGreaterThanOrEqual(66);

    let lists = 0;
    const failing = createR2Adapter({ env: ENV, now: () => NOW, fetch: async (input, init) => {
      if (new URL(String(input)).searchParams.has("list-type")) { lists++; return new Response(null, { status: 503 }); }
      return fake.fetch(input, init);
    } });
    start = fake.calls.length;
    const failed = await failing.withExclusivePublisher(() => collectGarbage({ store: failing, geometrySha256: pin, now: "2026-11-17T02:10:00.000Z", exclusivePublisher: true }));
    expect(failed.ok).toBe(false); expect(failed.error).toContain("r2-list-failed:503");
    expect(lists).toBe(1); expect(fake.calls.slice(start).filter(c => c.method === "PUT")).toHaveLength(0);
  });

  it("charges a preflight LIST once at the Class A monthly boundary", async () => {
    const fake = new FakeR2();
    const opts = { geometry, geometrySha256: pin, sourceUrl: "https://source.invalid" };
    await runEntrypoint({ ...opts, adapter: client(fake), clock: makeClock("2026-11-17T02:01:00.000Z"), fetch: async () => response(xml(), { etag: '"v1"' }) });
    const unchanged = () => runEntrypoint({ ...opts, adapter: client(fake), clock: makeClock("2026-11-17T02:02:00.000Z"), fetch: async () => new Response(null, { status: 304 }) });
    fake.seed(749_996); let start = fake.calls.length;
    await expect(unchanged()).rejects.toThrow("pipeline-budget-exceeded");
    expect(fake.calls.slice(start).filter(c => c.method === "PUT")).toHaveLength(0);
    expect(fake.calls.slice(start).filter(c => new URL(c.url).searchParams.has("list-type"))).toHaveLength(1);
    fake.seed(749_995); start = fake.calls.length;
    await expect(unchanged()).resolves.toMatchObject({ cycle: { ok: true } });
    expect(ledger(fake).classA).toBe(750_000);
    expect(fake.calls.slice(start).filter(c => c.method === "PUT")).toHaveLength(4);
    expect(fake.calls.slice(start).filter(c => new URL(c.url).searchParams.has("list-type"))).toHaveLength(1);
  });

  it("keeps repeated overwrites out of cumulative storage and deletes reduce inventory", async () => {
    const fake = new FakeR2(); const key = `live/v1/${pin}/manifest.json`;
    const checkpoint = assembly().manifest;
    const started = performance.now();
    for (let i = 0; i < 8640; i++) {
      const adapter = client(fake);
      await adapter.withExclusivePublisher(async () => {
        await adapter.reserve({ classA: 3, classB: 3, total: 6 });
        const at = new Date(Date.parse("2026-11-17T02:01:00.000Z") + i * 300_000).toISOString();
        await adapter.put(key, enc.encode(JSON.stringify({ ...checkpoint, checkedAt: at, publishedAt: at })), meta);
      });
      fake.calls.length = 0;
    }
    const elapsed = performance.now() - started;
    console.log(`8640-retention-cycle duration: ${elapsed.toFixed(0)} ms`);
    const index = JSON.parse(dec.decode(fake.objects.get(`live/v1/${pin}/retention.json`)!.body));
    expect(index.manifests).toHaveLength(600);
    const size = () => [...fake.objects.values()].reduce((n, obj) => n + obj.body.length, 0);
    expect(size()).toBeLessThan(2_000_000_000);
    expect(ledger(fake)).not.toHaveProperty("storageBytes");
    const before = size(); const adapter = client(fake);
    await adapter.withExclusivePublisher(async () => {
      await adapter.reserve({ classA: 0, classB: 1, total: 2 });
      await adapter.delete(key);
    });
    expect(size()).toBeLessThan(before);
  }, 120_000);

  it("rejects unsafe whole-bucket inventories before any PUT", async () => {
    const page = (contents: string, truncated = false, token = "next") => `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}</ListBucketResult>`;
    const object = (key: string, bytes: number) => `<Contents><Key>${key}</Key><Size>${bytes}</Size><LastModified>2026-11-17T02:00:00.000Z</LastModified></Contents>`;
    for (const kind of ["large", "failure", "loop", "pages", "malformed", "count"]) {
      const fake = new FakeR2(); let lists = 0;
      const adapter = createR2Adapter({ env: ENV, now: () => NOW, fetch: async (input, init) => {
        const url = new URL(String(input));
        if (!url.searchParams.has("list-type")) return fake.fetch(input, init);
        lists++;
        expect(url.searchParams.has("prefix")).toBe(false);
        if (kind === "failure") return new Response(null, { status: 500 });
        if (kind === "large") return new Response(page(object("other%2Flarge", 1_999_000_000)));
        if (kind === "malformed") return new Response("<ListBucketResult></ListBucketResult>");
        if (kind === "count") return new Response(page(Array.from({ length: 1000 }, (_, i) => object(`other%2F${lists}-${i}`, 1)).join(""), lists < 10, String(lists)));
        return new Response(page("", true, kind === "loop" ? "same" : String(lists)));
      } });
      await expect(adapter.withExclusivePublisher(async () => {
        await adapter.inventory([2_000_000]);
        await adapter.reserve({ classA: 5 + lists, classB: 2, total: 7 + lists });
        await adapter.put("test/object", new Uint8Array(2_000_000), meta);
      })).rejects.toThrow();
      expect(lists, kind).toBeGreaterThan(0);
      expect(fake.calls.filter(c => c.method === "PUT"), kind).toHaveLength(0);
      if (kind === "pages") expect(lists).toBe(10);
    }
    const fake = new FakeR2(); const adapter = client(fake);
    await expect(adapter.withExclusivePublisher(() => adapter.inventory([10_000_001]))).rejects.toThrow("inventory-upload-cap");
    expect(fake.calls.filter(c => c.method === "PUT")).toHaveLength(0);
  });

  it("does not echo configured secrets from the entrypoint", () => {
    const missing = spawnSync(execPath, ["--experimental-transform-types", "../tools/live-status/runner-entrypoint.ts"], {
      encoding: "utf8", env: { PATH: "", R2_ACCOUNT_ID: "abc123", R2_BUCKET: "my-bucket", R2_ACCESS_KEY_ID: ACCESS },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing-r2-env:R2_SECRET_ACCESS_KEY");
    expect(missing.stderr).not.toContain(ACCESS);
    const present = spawnSync(execPath, ["--experimental-transform-types", "../tools/live-status/runner-entrypoint.ts"], {
      encoding: "utf8", env: { PATH: "", ...ENV },
    });
    expect(present.status).toBe(1);
    expect(present.stderr).toContain("missing GITHUB_REPOSITORY");
    expect(present.stderr).not.toContain(SECRET);
    expect(present.stderr).not.toContain(ACCESS);
  });
});
