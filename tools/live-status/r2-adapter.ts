/** S3-compatible Cloudflare R2 client for the one-shot live-status runner.
 * Importing this module reads no env and performs no I/O. */
import { LIVE_LIMITS } from "../../shared/liveStatus.ts";
import { assertBudget, retainedKey, retentionKey, type GcStorage, type UsageBudget } from "./gc.ts";
import { manifestKey, type ObjectMetadata, type ObjectStore } from "./publish.ts";
import { amzDate, authorizationHeader, canonicalQuery, encodeRfc3986, sha256Hex } from "./sigv4.ts";

const enc = new TextEncoder();

const REQUIRED_ENV = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

export interface R2ObjectHead {
  bytes: number;
  uploadedAt: string;
  contentType: string | null;
  contentEncoding: string | null;
  cacheControl: string | null;
}
export interface R2AdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
interface Ledger {
  v: 1;
  month: string;
  classA: number;
  classB: number;
}
interface StoredObject { body: Uint8Array; metadata: ObjectMetadata }

const zero = (): UsageBudget => ({ classA: 0, classB: 0, total: 0 });
function add(a: UsageBudget, b: UsageBudget): UsageBudget {
  return { classA: a.classA + b.classA, classB: a.classB + b.classB, total: a.total + b.total };
}
function sub(a: UsageBudget, b: UsageBudget): UsageBudget {
  return { classA: a.classA - b.classA, classB: a.classB - b.classB, total: a.total - b.total };
}
function covers(have: UsageBudget, need: UsageBudget): boolean {
  return have.classA >= need.classA && have.classB >= need.classB && have.total >= need.total;
}
function emptyBudget(b: UsageBudget): boolean {
  return b.classA === 0 && b.classB === 0 && b.total === 0;
}
function budgetOf(ledger: Ledger): UsageBudget {
  return { classA: ledger.classA, classB: ledger.classB, total: ledger.classA + ledger.classB };
}
function failClosed(message: string): never { throw new Error(message); }

export function readR2Config(env: Record<string, string | undefined>): R2Config {
  const missing = REQUIRED_ENV.filter(key => typeof env[key] !== "string" || env[key]!.trim() === "");
  if (missing.length > 0) failClosed(`missing-r2-env:${missing.join(",")}`);
  const accountId = env.R2_ACCOUNT_ID!.trim();
  const bucket = env.R2_BUCKET!.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID!.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY!.trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(accountId)) failClosed("invalid-r2-account-id");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) failClosed("invalid-r2-bucket");
  if (!/^[\x21-\x7e]{1,128}$/.test(accessKeyId) || !/^[\x21-\x7e]{1,128}$/.test(secretAccessKey)) failClosed("invalid-r2-credentials");
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

function processEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 512 || key.startsWith("/") || key.endsWith("/")) failClosed("r2-key");
  if (/[\u0000-\u001f\u007f?#\\]/.test(key)) failClosed("r2-key");
  for (const segment of key.split("/")) if (segment === "" || segment === "." || segment === "..") failClosed("r2-key");
}
function assertMeta(metadata: ObjectMetadata): void {
  if (metadata.contentType !== "application/json") failClosed("r2-metadata");
  if (metadata.contentEncoding !== undefined && metadata.contentEncoding !== "gzip") failClosed("r2-metadata");
  if (typeof metadata.cacheControl !== "string" || metadata.cacheControl.length === 0 || metadata.cacheControl.length > 256 || /[\r\n\u0000]/.test(metadata.cacheControl)) failClosed("r2-metadata");
}
function pinOfManifest(key: string): string | null {
  const match = /^live\/v1\/([a-f0-9]{64})\/manifest\.json$/.exec(key);
  if (!match) return null;
  if (manifestKey(match[1]) !== key) failClosed("r2-key");
  return match[1];
}
function monthOf(now: Date): string {
  const iso = now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) failClosed("r2-clock");
  return iso.slice(0, 7);
}
function emptyLedger(month: string): Ledger {
  return { v: 1, month, classA: 0, classB: 0 };
}
function parseLedger(bytes: Uint8Array, month: string): Ledger {
  if (bytes.length > 4096) failClosed("r2-accounting-invalid");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { failClosed("r2-accounting-invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) failClosed("r2-accounting-invalid");
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.month !== month) failClosed("r2-accounting-invalid");
  const ledger = emptyLedger(month);
  for (const field of ["classA", "classB"] as const) {
    const number = record[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) failClosed("r2-accounting-invalid");
    ledger[field] = number;
  }
  return ledger;
}
function encodeLedger(ledger: Ledger): Uint8Array {
  return enc.encode(JSON.stringify({ v: 1, month: ledger.month, classA: ledger.classA, classB: ledger.classB }));
}
function parseIndex(bytes: Uint8Array, pin: string): { v: 1; geometrySha256: string; manifests: string[]; pins?: string[] } {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { failClosed("r2-retention-invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) failClosed("r2-retention-invalid");
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.geometrySha256 !== pin || !Array.isArray(record.manifests)) failClosed("r2-retention-invalid");
  const manifests: string[] = [];
  const seenManifests = new Set<string>();
  for (const key of record.manifests) {
    if (typeof key !== "string" || seenManifests.has(key)) failClosed("r2-retention-invalid");
    seenManifests.add(key); manifests.push(key);
  }
  let pins: string[] | undefined;
  if (record.pins !== undefined) {
    if (!Array.isArray(record.pins) || record.pins.length > 400 || record.pins.some(key => typeof key !== "string") || new Set(record.pins).size !== record.pins.length) failClosed("r2-retention-invalid");
    pins = record.pins as string[];
  }
  return { v: 1, geometrySha256: pin, manifests, ...(pins ? { pins } : {}) };
}
async function drain(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* already consumed */ }
}
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await drain(response);
    failClosed("r2-object-too-large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    let buffered: Uint8Array;
    try { buffered = new Uint8Array(await response.arrayBuffer()); } catch { failClosed("r2-response-read"); }
    if (buffered.byteLength > maxBytes) failClosed("r2-object-too-large");
    return buffered;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try { step = await reader.read(); } catch { failClosed("r2-response-read"); }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* oversized even if cancellation fails */ }
      failClosed("r2-object-too-large");
    }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
function httpDateIso(value: string | null): string {
  if (!value) failClosed("r2-object-metadata");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) failClosed("r2-object-metadata");
  return new Date(ms).toISOString();
}

/** Counts Class A/B the way R2 bills them: PUT and LIST are A, GET and HEAD are B, DELETE is free.
 * A bounded batch is written into the month ledger before dispatch. There is no retry loop. */
class R2Client {
  private locked = false;
  private loaded = false;
  private month = "";
  private persisted: Ledger = emptyLedger("0000-00");
  private owed: UsageBudget = zero();
  private prepaid: UsageBudget = zero();
  private reserved = false;
  private unrecordedAccountingFailures = 0;
  private unrecordedLoadGets = 0;
  constructor(private readonly config: R2Config, private readonly fetchImpl: typeof fetch, private readonly now: () => Date) {}

  async withExclusivePublisher<T>(run: () => Promise<T>): Promise<T> {
    if (this.locked) failClosed("publisher-lock-held");
    this.locked = true;
    this.loaded = false; this.reserved = false; this.prepaid = zero(); this.owed = zero(); this.month = "";
    try { return await run(); }
    catch (error) { throw this.fail("r2-publisher", error); }
    finally { this.locked = false; }
  }
  async usage(): Promise<UsageBudget> {
    this.assertLock();
    await this.ensureLoaded();
    return add(budgetOf(this.persisted), this.owed);
  }
  /** Write-ahead one batch. Later matching attempts consume it and do not rewrite the ledger. */
  async reserve(delta: UsageBudget): Promise<void> {
    this.assertLock();
    assertBudget(zero(), delta);
    await this.ensureLoaded();
    if (emptyBudget(delta)) return;
    if (!covers(delta, this.owed)) failClosed("r2-reservation-short");
    const remaining = sub(delta, this.owed);
    await this.commit(remaining, false);
    this.prepaid = remaining;
    this.reserved = true;
  }
  async head(key: string): Promise<R2ObjectHead | null> {
    this.assertLock();
    this.assertDataKey(key);
    await this.ensureLoaded();
    await this.consume({ classA: 0, classB: 1, total: 1 });
    const response = await this.s3("HEAD", key);
    if (response.status === 404) { await drain(response); return null; }
    if (response.status !== 200) { await drain(response); throw this.fail(`r2-head-failed:${response.status}`); }
    const bytes = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(bytes) || bytes < 0) { await drain(response); failClosed("r2-object-metadata"); }
    const head = {
      bytes,
      uploadedAt: httpDateIso(response.headers.get("last-modified")),
      contentType: response.headers.get("content-type"),
      contentEncoding: response.headers.get("content-encoding"),
      cacheControl: response.headers.get("cache-control"),
    };
    await drain(response);
    return head;
  }
  async get(key: string, options: { maxBytes: number }): Promise<Uint8Array | null> {
    this.assertLock();
    this.assertDataKey(key);
    if (!options || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) failClosed("r2-max-bytes");
    await this.ensureLoaded();
    await this.consume({ classA: 0, classB: 1, total: 1 });
    const response = await this.s3("GET", key);
    if (response.status === 404) { await drain(response); return null; }
    if (response.status !== 200) { await drain(response); throw this.fail(`r2-get-failed:${response.status}`); }
    return readLimited(response, options.maxBytes);
  }
  async put(key: string, bytes: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    this.assertLock();
    this.assertDataKey(key);
    assertMeta(metadata);
    await this.ensureLoaded();
    await this.retainIfManifest(key);
    await this.putObject(key, bytes, metadata);
  }
  async list(options: { prefix: string; cursor: string | null; limit: number }): Promise<{ objects: { key: string; bytes: number; uploadedAt: string }[]; cursor: string | null }> {
    this.assertLock();
    if (!options || typeof options.prefix !== "string" || options.prefix.length > 512 || /[\u0000-\u001f?#\\]/.test(options.prefix) || options.prefix.startsWith("/")) failClosed("r2-list");
    if (options.cursor !== null && (typeof options.cursor !== "string" || options.cursor.length === 0 || options.cursor.length > 4096 || /[\u0000-\u001f]/.test(options.cursor))) failClosed("r2-list");
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) failClosed("r2-list");
    await this.ensureLoaded();
    if (!this.reserved) {
      const delta = { classA: 1, classB: 0, total: 1 };
      assertBudget(budgetOf(this.persisted), add(this.owed, delta));
      this.owed = add(this.owed, delta);
    } else await this.consume({ classA: 1, classB: 0, total: 1 });
    const query: (readonly [string, string])[] = [
      ["list-type", "2"], ...(options.prefix ? [["prefix", options.prefix] as const] : []), ["max-keys", String(options.limit)], ["encoding-type", "url"],
    ];
    if (options.cursor) query.push(["continuation-token", options.cursor]);
    const response = await this.s3("GET", null, { query });
    if (response.status !== 200) { await drain(response); throw this.fail(`r2-list-failed:${response.status}`); }
    const bytes = await readLimited(response, 2_000_000);
    let xml: string;
    try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { failClosed("r2-list-xml"); }
    return parseList(xml, options.prefix, options.limit);
  }
  async inventory(uploadSizes: number[]): Promise<number> {
    this.assertLock();
    if (this.reserved || uploadSizes.some(n => !Number.isSafeInteger(n) || n < 0 || n > 10_000_000)) failClosed("inventory-upload-cap");
    const seen = new Set<string>(); const cursors = new Set<string>();
    let cursor: string | null = null; let bytes = 0;
    for (let page = 1; page <= 10; page++) {
      const batch = await this.list({ prefix: "", cursor, limit: 1000 });
      for (const object of batch.objects) {
        if (!object.key || seen.has(object.key) || !Number.isSafeInteger(object.bytes) || object.bytes < 0) failClosed("inventory-page-invalid");
        seen.add(object.key); bytes += object.bytes;
        if (!Number.isSafeInteger(bytes)) failClosed("inventory-page-invalid");
      }
      if (batch.cursor === null) {
        // Four additional PUTs: manifest, retention snapshot and index, ledger.
        if (seen.size + uploadSizes.length + 4 > 10_000 || bytes + uploadSizes.reduce((a, b) => a + b, 0) + 750_000 > 1_500_000_000) failClosed("inventory-cap");
        return page;
      }
      if (cursors.has(batch.cursor)) failClosed("inventory-cursor-loop");
      cursors.add(batch.cursor); cursor = batch.cursor;
    }
    failClosed("inventory-page-cap");
  }
  async delete(key: string): Promise<void> {
    this.assertLock();
    this.assertDataKey(key);
    await this.ensureLoaded();
    // R2 DeleteObject is free. The ledger rewrite that records it is the Class A PutObject.
    await this.consume({ classA: 0, classB: 0, total: 1 });
    const response = await this.s3("DELETE", key);
    if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
      await drain(response);
      throw this.fail(`r2-delete-failed:${response.status}`);
    }
    await drain(response);
  }

  private assertLock(): void { if (!this.locked) failClosed("publisher-lock-required"); }
  private assertDataKey(key: string): void {
    assertKey(key);
    if (key.startsWith("live-status/accounting/")) failClosed("r2-accounting-key");
  }
  private accountingKey(): string { return `live-status/accounting/${this.month}.json`; }
  private fail(message: string, cause?: unknown): Error {
    const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return new Error(this.redact(detail ? `${message}:${detail}` : message));
  }
  private redact(text: string): string {
    let out = text;
    for (const secret of [this.config.secretAccessKey, this.config.accessKeyId]) {
      if (secret.length === 0) continue;
      out = out.split(secret).join("[REDACTED]");
      out = out.split(encodeURIComponent(secret)).join("[REDACTED]");
      const encoded = encodeRfc3986(secret);
      out = out.replace(new RegExp(encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED]");
    }
    out = out.replace(/AWS4-HMAC-SHA256\s+Credential=[^\s,]+/gi, "AWS4-HMAC-SHA256 Credential=[REDACTED]");
    out = out.replace(/Signature=[0-9a-f]+/gi, "Signature=[REDACTED]");
    out = out.replace(/X-Amz-Signature=[^&\s]+/gi, "X-Amz-Signature=[REDACTED]");
    out = out.replace(/X-Amz-Credential=[^&\s]+/gi, "X-Amz-Credential=[REDACTED]");
    out = out.replace(/Authorization:\s*\S.*/gi, "Authorization: [REDACTED]");
    if (out.includes(this.config.secretAccessKey) || out.includes(this.config.accessKeyId)) return "[REDACTED]";
    return out.slice(0, 240);
  }
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.month) this.month = monthOf(this.now());
    let response: Response;
    try { response = await this.s3("GET", this.accountingKey()); }
    catch (error) {
      this.unrecordedLoadGets += 1;
      throw error;
    }
    if (response.status === 404) {
      await drain(response);
      this.persisted = emptyLedger(this.month);
    } else if (response.status === 200) {
      const bytes = await readLimited(response, 4096);
      this.persisted = parseLedger(bytes, this.month);
    } else {
      await drain(response);
      this.unrecordedLoadGets += 1;
      throw this.fail(`r2-accounting-read:${response.status}`);
    }
    this.loaded = true;
    const reads = 1 + this.unrecordedLoadGets;
    this.unrecordedLoadGets = 0;
    this.owed = add(this.owed, { classA: 0, classB: reads, total: reads });
  }
  /** Persist `delta` plus any owed reads and this accounting PUT before returning.
   * `keepOnFailure` retains delta when that attempt already left this process. */
  private async commit(delta: UsageBudget, keepOnFailure: boolean): Promise<void> {
    if (emptyBudget(delta) && emptyBudget(this.owed) && this.unrecordedAccountingFailures === 0) return;
    const overheadA = 1 + this.unrecordedAccountingFailures;
    const extra: UsageBudget = { classA: overheadA, classB: 0, total: overheadA };
    this.owed = add(this.owed, delta);
    try {
      assertBudget(budgetOf(this.persisted), add(this.owed, extra));
      const summed = add(budgetOf(this.persisted), add(this.owed, extra));
      const next: Ledger = { v: 1, month: this.persisted.month, classA: summed.classA, classB: summed.classB };
      await this.putLedger(next);
      this.persisted = next;
      this.owed = zero();
      this.unrecordedAccountingFailures = 0;
    } catch (error) {
      if (!keepOnFailure) this.owed = sub(this.owed, delta);
      if (error instanceof Error && error.message === "pipeline-budget-exceeded") throw error;
      this.unrecordedAccountingFailures += 1;
      throw error instanceof Error && error.message.startsWith("r2-") ? error : this.fail("r2-accounting-write", error);
    }
  }
  private async consume(delta: UsageBudget): Promise<void> {
    if (covers(this.prepaid, delta)) {
      this.prepaid = sub(this.prepaid, delta);
      return;
    }
    // Only reads before the reservation may be held in memory.
    if (!this.reserved && emptyBudget(this.prepaid) && delta.classA === 0 && delta.classB === 1 && this.owed.classB < 2) {
      this.owed = add(this.owed, delta);
      return;
    }
    failClosed("r2-reservation-short");
  }
  private async putLedger(ledger: Ledger): Promise<void> {
    const response = await this.s3("PUT", this.accountingKey(), {
      body: encodeLedger(ledger),
      headers: [["content-type", "application/json"], ["cache-control", "no-store"]],
    });
    if (response.status !== 200 && response.status !== 201) {
      await drain(response);
      throw this.fail(`r2-accounting-write:${response.status}`);
    }
    await drain(response);
  }
  private async putObject(key: string, bytes: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    if (bytes.byteLength > 10_000_000) failClosed("inventory-upload-cap");
    await this.consume({ classA: 1, classB: 0, total: 1 });
    const headers: (readonly [string, string])[] = [["content-type", metadata.contentType], ["cache-control", metadata.cacheControl]];
    if (metadata.contentEncoding) headers.push(["content-encoding", metadata.contentEncoding]);
    const response = await this.s3("PUT", key, { body: bytes, headers });
    if (response.status !== 200 && response.status !== 201) {
      await drain(response);
      throw this.fail(`r2-put-failed:${response.status}`);
    }
    await drain(response);
  }
  private async retainIfManifest(key: string): Promise<void> {
    const pin = pinOfManifest(key);
    if (!pin) return;
    const indexKey = retentionKey(pin);
    const current = await this.get(key, { maxBytes: LIVE_LIMITS.manifestBytes });
    const indexBytes = await this.get(indexKey, { maxBytes: 250_000 });
    if (current && !indexBytes) failClosed("r2-retention-missing");
    if (!current && !indexBytes) {
      await this.putObject(indexKey, enc.encode(JSON.stringify({ v: 1, geometrySha256: pin, manifests: [] })), jsonMeta("public, max-age=60"));
      return;
    }
    if (!current || !indexBytes) return;
    const snapshot = retainedKey(pin, current);
    await this.putObject(snapshot, current, jsonMeta("public, max-age=31536000, immutable"));
    const index = parseIndex(indexBytes, pin);
    if (!index.manifests.includes(snapshot)) index.manifests.push(snapshot);
    // Keep a bounded recent rollback window; GC retains unindexed objects for its grace period.
    index.manifests = index.manifests.slice(-600);
    await this.putObject(indexKey, enc.encode(JSON.stringify(index)), jsonMeta("public, max-age=60"));
  }
  private async s3(method: string, key: string | null, init: { body?: Uint8Array; query?: readonly (readonly [string, string])[]; headers?: readonly (readonly [string, string])[] } = {}): Promise<Response> {
    if (key !== null) assertKey(key);
    const segments = key === null ? [this.config.bucket] : [this.config.bucket, ...key.split("/")];
    const canonicalUri = `/${segments.map(encodeRfc3986).join("/")}`;
    const query = init.query ?? [];
    const body = init.body ?? new Uint8Array();
    const payloadHash = await sha256Hex(method === "GET" || method === "HEAD" || method === "DELETE" ? new Uint8Array() : body);
    const stamped = amzDate(this.now());
    const host = `${this.config.accountId}.r2.cloudflarestorage.com`;
    const signed = [
      ["host", host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", stamped],
      ...(init.headers ?? []),
    ] as const;
    const authorization = await authorizationHeader({
      method, canonicalUri, query, headers: signed, payloadHash,
      accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey,
      region: "auto", service: "s3", amzDate: stamped,
    });
    const queryString = canonicalQuery(query);
    const url = `https://${host}${canonicalUri}${queryString ? `?${queryString}` : ""}`;
    const headers = new Headers();
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", stamped);
    headers.set("authorization", authorization);
    for (const [name, value] of init.headers ?? []) headers.set(name, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method, headers, redirect: "manual",
        body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : copyBytes(body) as BodyInit,
      });
    } catch { throw new Error("r2-network"); }
    if (response.status >= 300 && response.status < 400) {
      await drain(response);
      throw new Error("r2-redirect-blocked");
    }
    return response;
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
function jsonMeta(cacheControl: string): ObjectMetadata {
  return { contentType: "application/json", cacheControl };
}
function xmlText(source: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) out.push(match[1]);
  return out;
}
function decodeXml(text: string): string {
  return text.replace(/&#x([0-9a-fA-F]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/g, (_all, hex: string, dec: string, named: string) => {
    if (named) return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[named] ?? failClosed("r2-list-xml");
    const code = parseInt(hex ?? dec, hex ? 16 : 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) failClosed("r2-list-xml");
    return String.fromCodePoint(code);
  });
}
function parseList(xml: string, prefix: string, limit: number): { objects: { key: string; bytes: number; uploadedAt: string }[]; cursor: string | null } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/^\s*(?:<\?xml[^?]*\?>\s*)?<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>\s*$/.test(xml) || xmlText(xml, "IsTruncated").length !== 1 || !["true", "false"].includes(xmlText(xml, "IsTruncated")[0]) || (xml.match(/<Contents>/g) ?? []).length !== (xml.match(/<\/Contents>/g) ?? []).length) failClosed("r2-list-xml");
  // Validate nesting before extracting fields: a partial/malformed XML page must
  // never look like a successful empty inventory.
  const body = xml.replace(/^\s*<\?xml[^?]*\?>/, "");
  const stack: string[] = []; let offset = 0;
  const tags = /<[^>]*>/g;
  for (let match = tags.exec(body); match; match = tags.exec(body)) {
    const between = body.slice(offset, match.index);
    if (between.includes("<") || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(between)) failClosed("r2-list-xml");
    const tag = match[0];
    const close = /^<\/([A-Za-z][\w:.-]*)\s*>$/.exec(tag);
    const open = /^<([A-Za-z][\w:.-]*)(?:\s+[^<>]*)?\s*(\/)?>$/.exec(tag);
    if (close) { if (stack.pop() !== close[1]) failClosed("r2-list-xml"); }
    else if (open) {
      if (open[1] === "Contents" && (stack.length !== 1 || stack[0] !== "ListBucketResult")) failClosed("r2-list-xml");
      if (!/\/\s*>$/.test(tag)) stack.push(open[1]);
    } else failClosed("r2-list-xml");
    offset = tags.lastIndex;
  }
  if (stack.length || body.slice(offset).trim()) failClosed("r2-list-xml");
  const objects = xmlText(xml, "Contents").map(block => {
    const keyRaw = xmlText(block, "Key")[0];
    const sizeRaw = xmlText(block, "Size")[0];
    const modified = xmlText(block, "LastModified")[0];
    if (xmlText(block, "Key").length !== 1 || xmlText(block, "Size").length !== 1 || xmlText(block, "LastModified").length !== 1 || keyRaw === undefined || sizeRaw === undefined || modified === undefined) failClosed("r2-list-xml");
    let key = decodeXml(keyRaw);
    try { key = decodeURIComponent(key); } catch { failClosed("r2-list-xml"); }
    if (!key.startsWith(prefix) || !/^\d+$/.test(sizeRaw)) failClosed("r2-list-xml");
    return { key, bytes: Number(sizeRaw), uploadedAt: httpDateIso(decodeXml(modified)) };
  });
  if (objects.length > limit) failClosed("r2-list-xml");
  if ((xml.match(/<Contents(?=[\s/>])/g) ?? []).length !== objects.length) failClosed("r2-list-xml");
  const truncated = xmlText(xml, "IsTruncated")[0] === "true";
  const token = xmlText(xml, "NextContinuationToken")[0];
  if (truncated && (token === undefined || token.length === 0 || token.length > 4096)) failClosed("r2-list-xml");
  return { objects, cursor: truncated ? decodeXml(token!) : null };
}

export interface R2Adapter extends ObjectStore, GcStorage {
  inventory(uploadSizes: number[]): Promise<number>;
  /** In-process sole publisher. Cross-process exclusion stays the workflow concurrency group. */
  withExclusivePublisher<T>(run: () => Promise<T>): Promise<T>;
  /** Durable month-to-date totals. Missing or corrupt ledgers throw; a new UTC month starts at zero. */
  usage(): Promise<UsageBudget>;
  /** Persist a batch before those attempts run. One ledger rewrite covers the whole batch. */
  reserve(reservation: UsageBudget): Promise<void>;
  /** Class B. Null only when the object is absent. */
  head(key: string): Promise<R2ObjectHead | null>;
}
export function createR2Adapter(options: R2AdapterOptions = {}): R2Adapter {
  const config = readR2Config(options.env ?? processEnv());
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  if (typeof fetchImpl !== "function") failClosed("r2-fetch-unavailable");
  return new R2Client(config, fetchImpl, options.now ?? (() => new Date()));
}
