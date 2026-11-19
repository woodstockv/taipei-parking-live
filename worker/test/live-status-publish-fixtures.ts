import { assemble, type Geometry } from "../../tools/live-status/assemble.ts";
import { type CycleClock, type SourceFetch } from "../../tools/live-status/fetch.ts";
import { type ObjectMetadata, type ObjectStore } from "../../tools/live-status/publish.ts";
export const pin = "a".repeat(64);
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export function xml(code = "2", batch = "20261117T095000"): string {
  const cells = [1, 2, 3, 4].map(i => `<cell><psId>0${i}</psId><cellStatus>${i === 1 ? code : "1"}</cellStatus><data_Dt>2026-11-17 09:00:00</data_Dt></cell>`).join("");
  return `<DATA><ROAD><roadSegID>1000A0</roadSegID><roadSegName>測試路A</roadSegName><roadSegUpdatetime>${batch}</roadSegUpdatetime><cellStatusList>${cells}</cellStatusList></ROAD></DATA>`;
}
export const geometry: Geometry = { sha256: pin, spots: [1, 2, 3, 4].map(i => ({ id: `tpe:測試路A:${i}`, road: "測試路A", pkid: String(i), lat: 25.05, lng: 121.53 + i / 10000 })) };
export function assembly(code = "2") {
  return assemble({ xml: encode(xml(code)), geometry, capturedAt: "2026-11-17T02:00:00.000Z", checkedAt: "2026-11-17T02:00:01.000Z", publishedAt: "2026-11-17T02:00:02.000Z", etag: '"v1"', lastModified: "2026-11-17T01:59:00.000Z", partitionRows: 2 });
}
export function makeClock(start = "2026-11-17T02:01:00.000Z"): CycleClock & { sleeps: number[] } {
  let ms = Date.parse(start); const sleeps: number[] = [];
  return { sleeps, now: () => { const at = new Date(ms).toISOString(); ms += 1000; return at; }, sleep: async delay => { sleeps.push(delay); ms += delay; },
    setTimer: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
}
export function response(body = xml(), headers: Record<string, string> = {}): Awaited<ReturnType<SourceFetch>> {
  return new Response(body, { status: 200, headers });
}
export class MemoryStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  puts: { key: string; bytes: Uint8Array; metadata: ObjectMetadata }[] = [];
  gets: string[] = [];
  fail: ((key: string) => boolean) | null = null;
  async get(key: string, options: { maxBytes: number }): Promise<Uint8Array | null> {
    this.gets.push(key); const value = this.objects.get(key);
    if (value && value.length > options.maxBytes) throw new Error("store-byte-cap");
    return value?.slice() ?? null;
  }
  async put(key: string, bytes: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    this.puts.push({ key, bytes: bytes.slice(), metadata: { ...metadata } });
    if (this.fail?.(key)) throw new Error("injected-put-failure");
    const old = this.objects.get(key);
    if (old && !key.endsWith("/manifest.json") && (old.length !== bytes.length || old.some((b, i) => b !== bytes[i]))) throw new Error("immutable-object-conflict");
    this.objects.set(key, bytes.slice());
  }
}
