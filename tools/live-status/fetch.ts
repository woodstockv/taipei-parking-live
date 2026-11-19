/** Taipei-only acquisition. No default HTTP client, credentials, or import-time I/O. */
import { LIVE_LIMITS, isIso } from "../../shared/liveStatus.ts";
import { parseCapture } from "./assemble.ts";

export interface CycleClock {
  now(): string;
  sleep(milliseconds: number): Promise<void>;
  /** Schedule a deadline; return a function that cancels it. */
  setTimer(callback: () => void, milliseconds: number): () => void;
}
export interface Validators { etag: string | null; lastModified: string | null }
export type SourceFetch = (url: string, init: {
  method: "GET"; headers: Record<string, string>; signal: AbortSignal; redirect: "error";
}) => Promise<{ status: number; headers: Pick<Headers, "get">; body: ReadableStream<Uint8Array> | null }>;
export interface FetchOptions {
  url: string; fetch: SourceFetch; clock: CycleClock; previous: Validators | null;
  timeoutMs?: number; maxAttempts?: number; backoffMs?: number; maxBackoffMs?: number;
}
export type Acquisition =
  | { status: 200; xml: Uint8Array; capturedAt: string; checkedAt: string; validators: Validators; attempts: number }
  | { status: 304; checkedAt: string; validators: Validators; attempts: number };
export class AcquisitionError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs = 0, readonly attempts = 0) { super(message); }
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new AcquisitionError(message); }
function timestamp(clock: CycleClock): string { const t = clock.now(); need(isIso(t), "source-clock"); return t; }
function etag(value: string | null): string | null {
  if (value === null || value === "") return null;
  need(value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value), "source-etag"); return value;
}
function modified(value: string | null): string | null {
  if (value === null || value === "") return null;
  const ms = Date.parse(value);
  need(Number.isFinite(ms) && (isIso(value) || new Date(ms).toUTCString() === value), "source-last-modified");
  return new Date(ms).toISOString();
}
function retryDelay(value: string | null, clock: CycleClock): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const ms = Date.parse(value); return Number.isFinite(ms) ? Math.max(0, ms - Date.parse(timestamp(clock))) : 0;
}

/** Fully buffer a capped, complete response before invoking the strict LIVE-1 parser. */
export async function acquireSource(options: FetchOptions): Promise<Acquisition> {
  const { clock, previous } = options;
  const timeout = options.timeoutMs ?? 30_000; const attempts = options.maxAttempts ?? 3;
  const backoff = options.backoffMs ?? 1000; const maxBackoff = options.maxBackoffMs ?? 30_000;
  need(Number.isInteger(timeout) && timeout > 0 && timeout <= 120_000 && Number.isInteger(attempts) && attempts >= 1 && attempts <= 3 &&
    Number.isFinite(backoff) && backoff >= 0 && Number.isFinite(maxBackoff) && maxBackoff >= backoff && maxBackoff <= 120_000, "source-retry-policy");
  const headers: Record<string, string> = { "Accept-Encoding": "identity" };
  if (previous) {
    etag(previous.etag); need(previous.lastModified === null || isIso(previous.lastModified), "checkpoint-last-modified");
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    else if (previous.lastModified) headers["If-Modified-Since"] = new Date(previous.lastModified).toUTCString();
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelTimer: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        cancelTimer = clock.setTimer(() => {
          reject(new AcquisitionError("source-timeout", true)); controller.abort();
          if (reader) void reader.cancel().catch(() => {});
        }, timeout);
      });
      const work = async (): Promise<Acquisition> => {
        let response: Awaited<ReturnType<SourceFetch>>;
        try {
          response = await options.fetch(options.url, { method: "GET", headers: { ...headers }, signal: controller.signal, redirect: "error" });
        } catch (error) {
          throw new AcquisitionError(error instanceof Error ? error.message : "source-network", true);
        }
        // A timed-out injected client may still resolve later: never consume that body.
        if (controller.signal.aborted) { if (response.body) void response.body.cancel().catch(() => {}); throw new AcquisitionError("source-timeout", true); }
        reader = response.body?.getReader();
        if (response.status === 304) {
          need(previous && (headers["If-None-Match"] || headers["If-Modified-Since"]), "unsolicited-304");
          return { status: 304, checkedAt: timestamp(clock), validators: { ...previous }, attempts: attempt };
        }
        if (response.status !== 200) throw new AcquisitionError(`source-http-${response.status}`, response.status === 429 || response.status >= 500 && response.status <= 599,
          retryDelay(response.headers.get("retry-after"), clock));
        need(!response.headers.get("content-encoding") || response.headers.get("content-encoding")!.toLowerCase() === "identity", "source-content-encoding");
        const lengthHeader = response.headers.get("content-length");
        need(lengthHeader === null || /^\d+$/.test(lengthHeader), "source-content-length");
        const length = lengthHeader === null ? null : Number(lengthHeader);
        need(length === null || Number.isSafeInteger(length) && length <= LIVE_LIMITS.xmlBytes, "source-byte-cap");
        need(reader, "source-missing-body");
        const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); }
          catch (error) { throw new AcquisitionError(error instanceof Error ? error.message : "source-stream", true); }
          if (controller.signal.aborted) throw new AcquisitionError("source-timeout", true);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          need(bytes <= LIVE_LIMITS.xmlBytes, "source-byte-cap");
          chunks.push(chunk.value.slice());
        }
        if (length !== null && length !== bytes) throw new AcquisitionError("source-truncated-length", true);
        const xml = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { xml.set(chunk, offset); offset += chunk.length; }
        const capturedAt = timestamp(clock);
        // Never hand a prefix, DTD, malformed UTF-8, or invalid schema to publication.
        try { parseCapture(xml); }
        catch (error) { throw new AcquisitionError(error instanceof Error ? error.message : "source-xml"); }
        const validators = { etag: etag(response.headers.get("etag")), lastModified: modified(response.headers.get("last-modified")) };
        need(validators.lastModified === null || validators.lastModified <= capturedAt, "source-object-clock");
        const checkedAt = timestamp(clock); need(capturedAt <= checkedAt, "source-clock-regressed");
        return { status: 200, xml, capturedAt, checkedAt, validators, attempts: attempt };
      };
      return await Promise.race([work(), deadline]);
    } catch (error) {
      const failure = error instanceof AcquisitionError ? error : new AcquisitionError(error instanceof Error ? error.message : "source-error");
      const delay = Math.max(backoff * 2 ** (attempt - 1), failure.retryAfterMs);
      // A longer Retry-After stops the cycle; never retry earlier than requested.
      if (!failure.retryable || attempt === attempts || delay > maxBackoff) throw new AcquisitionError(failure.message, failure.retryable, failure.retryAfterMs, attempt);
      // Release/abort the attempt before waiting for its retry.
      controller.abort(); if (reader) void reader.cancel().catch(() => {});
      cancelTimer?.();
      await clock.sleep(delay);
    } finally {
      cancelTimer?.(); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  throw new AcquisitionError("source-attempts-exhausted");
}
