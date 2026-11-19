/** Header-only AWS Signature Version 4. No retries, no presigned query, no logging.
 * Locked to the published S3 example in worker/test/live-status-r2.test.ts. */
const enc = new TextEncoder();

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQuery(pairs: readonly (readonly [string, string])[]): string {
  const encoded = pairs.map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const);
  encoded.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  return encoded.map(([key, value]) => `${key}=${value}`).join("&");
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return hex(new Uint8Array(digest));
}

export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const raw = new Uint8Array(key.byteLength);
  raw.set(key);
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return new Uint8Array(signed);
}

export interface SigV4Request {
  method: string;
  canonicalUri: string;
  query: readonly (readonly [string, string])[];
  /** Lowercase names. Host is signed even when fetch forbids setting it. */
  headers: readonly (readonly [string, string])[];
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
}

/** Returns the Authorization header value. Never includes a presigned URL. */
export async function authorizationHeader(input: SigV4Request): Promise<string> {
  const pairs = input.headers.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/[ \t]+/g, " ")] as const);
  pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const canonicalHeaders = pairs.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = pairs.map(([name]) => name).join(";");
  const canonical = `${input.method}\n${input.canonicalUri}\n${canonicalQuery(input.query)}\n${canonicalHeaders}\n${signedHeaders}\n${input.payloadHash}`;
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${input.amzDate}\n${scope}\n${await sha256Hex(enc.encode(canonical))}`;
  let key = await hmacSha256(enc.encode(`AWS4${input.secretAccessKey}`), dateStamp);
  key = await hmacSha256(key, input.region);
  key = await hmacSha256(key, input.service);
  key = await hmacSha256(key, "aws4_request");
  const signature = hex(await hmacSha256(key, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
