import { describe, expect, it, vi } from "vitest";
import { LIVE_LIMITS } from "../../shared/liveStatus.ts";
import { acquireSource, AcquisitionError, type FetchOptions, type SourceFetch } from "../../tools/live-status/fetch.ts";
import { encode, makeClock, response, xml } from "./live-status-publish-fixtures.ts";
const url = "https://source.invalid/capture.xml";
const validators = { etag: '"saved"', lastModified: "2026-11-17T01:59:00.000Z" };
function options(fetch: SourceFetch, overrides: Partial<FetchOptions> = {}): FetchOptions { return { url, fetch, previous: null, clock: makeClock(), ...overrides }; }
function streamed(parts: Uint8Array[], headers: Record<string, string> = {}, onCancel?: () => void): Response {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (i === parts.length) controller.close(); else controller.enqueue(parts[i++]); }, cancel: onCancel }), { headers });
}
describe("LIVE-2 injected source acquisition", () => {
  it("acquires and validates a complete chunked 200, with distinct acquisition/check clocks", async () => {
    const bytes = encode(xml()); const fetch = vi.fn(async () => streamed([bytes.slice(0, 19), bytes.slice(19)], {
      etag: '"new"', "last-modified": "Tue, 17 Nov 2026 01:59:00 GMT", "content-length": String(bytes.length),
    }));
    const result = await acquireSource(options(fetch, { previous: validators }));
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("expected 200");
    expect(result.xml).toEqual(bytes); expect(result.attempts).toBe(1);
    expect(result.validators).toEqual({ etag: '"new"', lastModified: validators.lastModified });
    expect(result.capturedAt < result.checkedAt).toBe(true);
    expect(fetch.mock.calls[0]).toEqual([url, expect.objectContaining({ method: "GET", redirect: "error", headers: { "Accept-Encoding": "identity", "If-None-Match": '"saved"' } })]);
  });
  it.each<Record<string, string>>([{}, { etag: '"different"', "last-modified": "Tue, 17 Nov 2026 02:00:00 GMT" }])("304 preserves prior validators even with response headers %j", async headers => {
    const result = await acquireSource(options(async () => new Response(null, { status: 304, headers }), { previous: validators }));
    expect(result).toEqual({ status: 304, checkedAt: "2026-11-17T02:01:00.000Z", validators, attempts: 1 });
  });
  it("falls back to If-Modified-Since when only Last-Modified is available", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    const previous = { etag: null, lastModified: validators.lastModified };
    expect((await acquireSource(options(fetch, { previous }))).validators).toEqual(previous);
    expect(fetch.mock.calls[0]).toEqual([url, expect.objectContaining({ headers: { "Accept-Encoding": "identity", "If-Modified-Since": "Tue, 17 Nov 2026 01:59:00 GMT" } })]);
  });
  it("clears absent validators on a new 200 rather than retaining stale validators", async () => {
    expect((await acquireSource(options(async () => response(), { previous: validators }))).validators).toEqual({ etag: null, lastModified: null });
  });
  it("makes an unconditional request with a validator-less checkpoint", async () => {
    const fetch = vi.fn(async () => response());
    await acquireSource(options(fetch, { previous: { etag: null, lastModified: null } }));
    expect(fetch.mock.calls[0]).toEqual([url, expect.objectContaining({ headers: { "Accept-Encoding": "identity" } })]);
  });
  it.each([null, { etag: null, lastModified: null }])("rejects an unsolicited 304 with checkpoint %j", async previous => {
    await expect(acquireSource(options(async () => new Response(null, { status: 304 }), { previous }))).rejects.toThrow("unsolicited-304");
  });
  it("enforces the streaming cap without Content-Length and cancels the body", async () => {
    const cancel = vi.fn(); const fetch = vi.fn(async () => streamed([new Uint8Array(LIVE_LIMITS.xmlBytes), encode("x"), encode(xml())], {}, cancel));
    await expect(acquireSource(options(fetch))).rejects.toThrow("source-byte-cap");
    expect(fetch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("accepts exactly the byte cap without parsing a prefix", async () => {
    const bytes = encode(xml()); const padded = new Uint8Array(LIVE_LIMITS.xmlBytes).fill(32); padded.set(bytes);
    const result = await acquireSource(options(async () => streamed([padded])));
    expect(result.status === 200 && result.xml.length).toBe(LIVE_LIMITS.xmlBytes);
  });
  it("rejects oversized declared Content-Length before reading or parsing", async () => {
    await expect(acquireSource(options(async () => response(xml(), { "content-length": String(LIVE_LIMITS.xmlBytes + 1) })))).rejects.toThrow("source-byte-cap");
  });
  it.each(["-1", "NaN", "2.5"])("rejects invalid Content-Length %s", async length => {
    await expect(acquireSource(options(async () => response(xml(), { "content-length": length })))).rejects.toThrow("source-content-length");
  });
  it("rejects a short body even when it is independently valid XML", async () => {
    const fetch = vi.fn(async () => response(xml(), { "content-length": String(encode(xml()).length + 10) }));
    await expect(acquireSource(options(fetch))).rejects.toMatchObject({ message: "source-truncated-length", attempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("rejects a stream that errors after a valid prefix", async () => {
    let reads = 0;
    await expect(acquireSource(options(async () => new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(encode(xml())); else controller.error(new Error("connection-cut"));
    } })), { maxAttempts: 1 }))).rejects.toThrow("connection-cut");
  });
  it("retries a failed transport stream with a fresh full response", async () => {
    const clock = makeClock(); let calls = 0;
    const fetch: SourceFetch = async () => ++calls === 1 ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encode(xml().slice(0, 40))); controller.error(new Error("connection-cut"));
    } })) : response();
    const result = await acquireSource(options(fetch, { clock }));
    expect(result.status === 200 && result.xml).toEqual(encode(xml()));
    expect(result.attempts).toBe(2); expect(clock.sleeps).toEqual([1000]);
  });
  it.each([
    xml().slice(0, -7), `${xml()}<`, xml().replace("</ROAD>", "</OTHER>"),
    `<!DOCTYPE DATA SYSTEM "file:///never-read">${xml()}`,
    `<!DOCTYPE DATA [<!ENTITY external SYSTEM "https://entity.invalid/">]>${xml()}`,
    xml().replace("測試路A", "&external;"), "<DATA/>", "<other/>",
  ])("rejects malformed/schema-invalid/DTD XML atomically (%#)", async body => {
    const fetch = vi.fn(async () => response(body));
    await expect(acquireSource(options(fetch))).rejects.toBeInstanceOf(AcquisitionError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed UTF-8", async () => {
    const fetch = vi.fn(async () => streamed([encode(xml()), new Uint8Array([0xff])]));
    await expect(acquireSource(options(fetch))).rejects.toMatchObject({ attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([206, 400, 404])("rejects HTTP %s without retries or accepting its body", async status => {
    const fetch = vi.fn(async () => new Response(xml(), { status }));
    await expect(acquireSource(options(fetch))).rejects.toMatchObject({ message: `source-http-${status}`, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds HTTP 5xx retries with injected exponential sleep", async () => {
    const clock = makeClock(); const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(acquireSource(options(fetch, { clock }))).rejects.toMatchObject({ message: "source-http-503", attempts: 3 });
    expect(clock.sleeps).toEqual([1000, 2000]); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("recovers from a network error and 5xx using the same committed validators", async () => {
    const clock = makeClock(); let calls = 0;
    const fetch = vi.fn(async () => { calls++; if (calls === 1) throw new TypeError("network"); if (calls === 2) return new Response(null, { status: 500 }); return response(); });
    expect((await acquireSource(options(fetch, { clock, previous: validators }))).attempts).toBe(3);
    expect(clock.sleeps).toEqual([1000, 2000]);
    for (const call of fetch.mock.calls) expect(call).toEqual([url, expect.objectContaining({ headers: expect.objectContaining({ "If-None-Match": validators.etag }) })]);
  });
  it.each(["4", "Tue, 17 Nov 2026 02:01:04 GMT"])("honors bounded Retry-After %s", async retryAfter => {
    const clock = makeClock(); let calls = 0;
    const fetch: SourceFetch = async () => ++calls === 1 ? new Response(null, { status: 429, headers: { "retry-after": retryAfter } }) : response();
    await acquireSource(options(fetch, { clock })); expect(clock.sleeps).toEqual([4000]);
  });
  it("stops instead of shortening a Retry-After beyond the configured bound", async () => {
    const clock = makeClock(); const fetch = vi.fn(async () => new Response(null, { status: 503, headers: { "retry-after": "999999" } }));
    await expect(acquireSource(options(fetch, { clock }))).rejects.toMatchObject({ attempts: 1 });
    expect(clock.sleeps).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([0, 4, Infinity])("rejects an unbounded/invalid attempt policy %s before HTTP", async maxAttempts => {
    const fetch = vi.fn(async () => response());
    await expect(acquireSource(options(fetch, { maxAttempts }))).rejects.toThrow("source-retry-policy"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["bad date", "2026-02-30T01:00:00.000Z", "2026-11-17 01:59:00", "Tue, 17 Nov 2026 03:00:00 GMT"])("rejects invalid/future Last-Modified %s", async lastModified => {
    await expect(acquireSource(options(async () => response(xml(), { "last-modified": lastModified })))).rejects.toThrow(/source-(last-modified|object-clock)/);
  });
  it("rejects unexpectedly encoded responses", async () => {
    await expect(acquireSource(options(async () => response(xml(), { "content-encoding": "gzip" })))).rejects.toThrow("source-content-encoding");
  });
  it.each(["headers", "body"])("times out a stalled %s stage and aborts with bounded retries", async stage => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = []; const clock = makeClock();
      const fetch: SourceFetch = async (_, init) => {
        signals.push(init.signal);
        if (stage === "headers") return new Promise(() => {});
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode(xml().slice(0, 20))); } }));
      };
      const pending = acquireSource(options(fetch, { clock, timeoutMs: 25 }));
      const assertion = expect(pending).rejects.toMatchObject({ message: "source-timeout", attempts: 3 });
      await vi.advanceTimersByTimeAsync(100); await assertion;
      expect(signals.length).toBe(3); expect(signals.every(s => s.aborted)).toBe(true); expect(clock.sleeps).toEqual([1000, 2000]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("disposes a late response after timeout without consuming its XML", async () => {
    vi.useFakeTimers();
    try {
      let resolve: ((value: Awaited<ReturnType<SourceFetch>>) => void) | undefined;
      const cancel = vi.fn();
      const fetch: SourceFetch = () => new Promise(done => { resolve = done; });
      const pending = acquireSource(options(fetch, { maxAttempts: 1, timeoutMs: 25 }));
      const assertion = expect(pending).rejects.toMatchObject({ message: "source-timeout", attempts: 1 });
      await vi.advanceTimersByTimeAsync(25); await assertion;
      resolve!(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode(xml())); }, cancel })));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
