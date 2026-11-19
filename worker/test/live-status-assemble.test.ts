import { execPath } from "node:process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assemble, parseCapture, readGeometry, sha256, type AssemblyInput, type Geometry, type GeometrySpot } from "../../tools/live-status/assemble.ts";
import { measured, monthlyWrites } from "../../tools/live-status/measure.ts";
import { LIVE_LIMITS, batchTime, eventTime, reading, validateManifest, validateShard, parseManifestBytes, parseShardBytes } from "../../shared/liveStatus.ts";
const Buffer = { from: (text: string): Uint8Array => new TextEncoder().encode(text), alloc: (length: number): Uint8Array => new Uint8Array(length) };
const fixture = readFileSync(new URL("../../tools/live-status/fixtures/taipei.xml", import.meta.url));
const pin = "a".repeat(64);
function spot(road: string, pkid: string, i = 0): GeometrySpot { return { id: `tpe:${road}:${pkid}`, road, pkid, lng: 121.53 + i / 100000, lat: 25.05 }; }
function xml(cells = '<cell><psId>01</psId><cellStatus>2</cellStatus><data_Dt>2026-11-17 09:00:00</data_Dt></cell>', road = "測試路A", seg = "1000A0"): string {
  return `<DATA><ROAD><roadSegID>${seg}</roadSegID><roadSegName>${road}</roadSegName><roadSegUpdatetime>20261117T095513</roadSegUpdatetime><cellStatusList>${cells}</cellStatusList></ROAD></DATA>`;
}
function input(overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return { xml: Buffer.from(xml()), geometry: { sha256: pin, spots: [spot("測試路A", "1")] },
    capturedAt: "2026-11-17T02:00:00.000Z", checkedAt: "2026-11-17T02:00:01.000Z", publishedAt: "2026-11-17T02:00:02.000Z",
    etag: "saved-etag", lastModified: "2026-11-17T01:57:46.000Z", ...overrides };
}
function geometryRelease(spots = [spot("測試路A", "1")]) {
  const bbox = [Math.min(...spots.map(s => s.lng)), 25.05, Math.max(...spots.map(s => s.lng)), 25.05];
  const page = Buffer.from(JSON.stringify({ v: 1, page: 0, pages: 1, spots: spots.map(s => ({ id: s.id, lat: s.lat, lng: s.lng, pktype: "01" })) }));
  const index = Buffer.from(JSON.stringify({ v: 1, cell: "25.04:121.52", pages: [bbox] }));
  const m = { tileLayout: "spatial-v1", files: [{ file: "25.04_121.52.json", sha256: sha256(page), spots: spots.length }],
    indexes: [{ file: "25.04_121.52.index.json", sha256: sha256(index), pages: 1 }], summary: { kept: spots.length, pages: 1 } };
  const bytes = Buffer.from(JSON.stringify(m));
  return { bytes, pin: sha256(bytes), files: new Map([[m.files[0].file, page], [m.indexes[0].file, index]]), m };
}
describe("LIVE-1 strict joins and preserved source evidence", () => {
  it("normalizes matching keys without rewriting geometry, road letters or original provider IDs", () => {
    const cells = '<cell><psId>136</psId><cellStatus>1</cellStatus></cell><cell><psId>136A </psId><cellStatus>2</cellStatus></cell>';
    const geometry = { sha256: pin, spots: [spot("環河南路2段A", "136"), spot("環河南路2段A", "136A"), spot("環河南路2段B", "136")] };
    const a = assemble(input({ xml: Buffer.from(xml(cells, "4092534(12150) 環河南路二段A", "4092534")), geometry }));
    expect(a.manifest.geometrySha256).toBe(pin);
    expect(a.manifest.geometry).toEqual({ total: 3, matched: 2, unmatched: 1, ambiguous: 0 });
    expect(a.manifest.cells).toEqual({ total: 2, matched: 2, unmatched: 0, ambiguous: 0 });
    expect(a.shards.flatMap(s => s.payload.rows)).toEqual([
      ["tpe:環河南路2段A:136", "matched", "4092534", "136", "1", ""],
      ["tpe:環河南路2段A:136A", "matched", "4092534", "136A ", "2", ""],
      ["tpe:環河南路2段B:136", "unmatched", null, null, null, null],
    ]);
    const wrongPrefix = assemble(input({ xml: Buffer.from(xml(cells, "4092535(12150) 環河南路二段A", "4092534")), geometry }));
    expect(wrongPrefix.manifest.geometry).toEqual({ total: 3, matched: 0, unmatched: 3, ambiguous: 0 });
    expect(wrongPrefix.manifest.cells).toEqual({ total: 2, matched: 0, unmatched: 2, ambiguous: 0 });
  });
  it("excludes newly normalized source collisions and counts both candidates as ambiguous", () => {
    const body = (road: string, seg: string) => xml(undefined, road, seg).replace(/^<DATA>|<\/DATA>$/g, "");
    const capture = `<DATA>${body("信義路五段150巷", "302600A")}${body("3026150(12345) 信義路5段150巷", "3026150")}</DATA>`;
    const a = assemble(input({ xml: Buffer.from(capture), geometry: { sha256: pin, spots: [spot("信義路5段150巷", "1")] } }));
    expect(a.manifest.geometry).toEqual({ total: 1, matched: 0, unmatched: 0, ambiguous: 1 });
    expect(a.manifest.cells).toEqual({ total: 2, matched: 0, unmatched: 0, ambiguous: 2 });
    expect(a.shards[0].payload.rows).toEqual([["tpe:信義路5段150巷:1", "ambiguous", null, null, null, null]]);
  });
  it("rejects two geometry road spellings mapping to one source cell", () => {
    const a = assemble(input({ xml: Buffer.from(xml(undefined, "測試路一段A")),
      geometry: { sha256: pin, spots: [spot("測試路1段A", "1"), spot("測試路一段A", "1")] }, partitionRows: 1 }));
    expect(a.manifest.geometry).toEqual({ total: 2, matched: 0, unmatched: 0, ambiguous: 2 });
    expect(a.manifest.cells).toEqual({ total: 1, matched: 0, unmatched: 0, ambiguous: 1 });
    expect(a.shards).toHaveLength(2);
    expect(a.shards.flatMap(s => s.payload.rows)).toEqual([
      ["tpe:測試路1段A:1", "ambiguous", null, null, null, null],
      ["tpe:測試路一段A:1", "ambiguous", null, null, null, null],
    ]);
  });
  it("uses saved cells with exact road letters and original psId, including whitespace", () => {
    const capture = parseCapture(fixture);
    // The saved source's metadata prefix is not part of the geometry road label.
    const spaces = capture.cells.map((c, i) => spot(c.roadName.replace(/^3084197\(10060\) /, ""), c.psId.trim(), i));
    spaces.push(spot("伊通街A", "19"), spot("伊通街B", "17"), spot("一江街", "9"));
    const a = assemble(input({ xml: fixture, geometry: { sha256: pin, spots: spaces } }));
    const rows = a.shards.flatMap(s => s.payload.rows);
    for (const c of capture.cells) {
      const r = rows.find(r => r[2] === c.roadSegId && r[3] === c.psId)!;
      expect(r).toBeDefined(); expect(r.slice(2)).toEqual([c.roadSegId, c.psId, c.cellStatus, c.collectedAt]);
    }
    for (const s of spaces.slice(-3)) expect(rows.find(r => r[0] === s.id)).toEqual([s.id, "unmatched", null, null, null, null]);
    expect(a.manifest.geometry).toEqual({ total: spaces.length, matched: capture.cells.length, unmatched: 3, ambiguous: 0 });
    expect(rows.find(r => r[3] === "04A ")).toBeDefined();
  });
  it("makes duplicate canonical cells ambiguous, without borrowing aliases or clocks", () => {
    const cell = '<cell><psId>01</psId><cellStatus>2</cellStatus></cell>';
    const a = assemble(input({ xml: Buffer.from(xml(cell + cell.replace('01', '1'))) }));
    expect(a.shards[0].payload.rows[0]).toEqual(["tpe:測試路A:1", "ambiguous", null, null, null, null]);
    expect(a.manifest.cells).toEqual({ total: 2, matched: 0, unmatched: 0, ambiguous: 2 });
  });
  it("rejects many geometry IDs mapping to a single provider cell as ambiguous", () => {
    const a = assemble(input({ geometry: { sha256: pin, spots: [spot("測試路A", "1"), spot("測試路A", "01")] } }));
    expect(a.manifest.geometry.ambiguous).toBe(2); expect(a.manifest.cells.ambiguous).toBe(1);
    expect(a.shards[0].payload.rows.every(r => r[1] === "ambiguous")).toBe(true);
  });
  it("removes a vanished reading while retaining full geometry coverage", () => {
    const a = assemble(input()); const b = assemble(input({ xml: Buffer.from(xml("")) }));
    expect(a.manifest.shards[0].sha256).not.toBe(b.manifest.shards[0].sha256);
    expect(b.shards[0].payload.rows[0]).toEqual(["tpe:測試路A:1", "unmatched", null, null, null, null]);
    expect(b.manifest.geometry.total).toBe(1);
  });
  it.each(["0", "3", "4", "255", "unexpected", " 2 "])("keeps code %s raw and occupancy unknown", code => {
    const a = assemble(input({ xml: Buffer.from(xml().replace('<cellStatus>2</cellStatus>', `<cellStatus>${code}</cellStatus>`)) }));
    const r = a.shards[0].payload.rows[0]; expect(r[4]).toBe(code);
    expect(reading(r, a.manifest.source.capturedAt)).toEqual({ status: "unknown", collectedAt: "2026-11-17T01:00:00.000Z", label: code === "3" ? "設備調整中" : null });
  });
  it.each(["", "2026-02-30 09:00:00", "2026-11-18 09:00:00", "2026-11-17T09:00:00"])("retains invalid/missing/future time %s but does not invent a reading clock", time => {
    const a = assemble(input({ xml: Buffer.from(xml().replace('2026-11-17 09:00:00', time)) }));
    const r = a.shards[0].payload.rows[0]; expect(r[5]).toBe(time);
    expect(reading(r, a.manifest.source.capturedAt)).toEqual({ status: "unknown", collectedAt: null, label: null });
  });
  it("normalizes valid Taipei events without replacing old times with source/check clocks", () => {
    expect(eventTime("2026-11-17 09:00:00")).toBe("2026-11-17T01:00:00.000Z");
    expect(eventTime("2026-11-17T09:00:00+08:00")).toBe("2026-11-17T01:00:00.000Z");
    expect(batchTime("20261117T095513")).toBe("2026-11-17T01:55:13.000Z");
    const a = assemble(input()); expect(reading(a.shards[0].payload.rows[0], a.manifest.source.capturedAt).status).toBe("free");
  });
});
describe("LIVE-1 deterministic spatial packing", () => {
  it("is byte-identical with reversed geometry/source order, and deterministic gzip", () => {
    const cap = parseCapture(fixture); const spots = cap.cells.map((c, i) => spot(c.roadName.replace(/^3084197\(10060\) /, ""), c.psId.trim(), i));
    const opts = input({ xml: fixture, geometry: { sha256: pin, spots }, partitionRows: 4 });
    const a = assemble(opts);
    const b = assemble({ ...opts, geometry: { sha256: pin, spots: [...spots].reverse() } });
    expect(b.manifestBytes).toEqual(a.manifestBytes);
    expect(b.shards.map(s => s.gzip)).toEqual(a.shards.map(s => s.gzip));
    for (const s of a.shards) { expect(new Uint8Array(gunzipSync(s.gzip))).toEqual(s.bytes); expect(sha256(s.bytes)).toBe(a.manifest.shards.find(r => r.id === s.payload.id)!.sha256); }
    const reversed = Buffer.from(new TextDecoder().decode(fixture).replace(/<DATA>([\s\S]*)<\/DATA>/, (_, body: string) => `<DATA>${[...body.matchAll(/<ROAD>[\s\S]*?<\/ROAD>/g)].map(m => m[0]).reverse().join("")}</DATA>`));
    expect(assemble({ ...opts, xml: reversed }).shards.map(s => s.bytes)).toEqual(a.shards.map(s => s.bytes));
  });
  it("batch/check/capture/publication clock changes leave shards and generation unchanged", () => {
    const a = assemble(input()); const b = assemble(input({ xml: Buffer.from(xml().replace('095513', '100013')),
      capturedAt: "2026-11-17T02:05:00.000Z", checkedAt: "2026-11-17T02:05:01.000Z", publishedAt: "2026-11-17T02:05:02.000Z" }));
    expect(b.shards).toEqual(a.shards); expect(b.manifest.generation).toBe(a.manifest.generation);
    expect(b.manifest.source.sha256).not.toBe(a.manifest.source.sha256);
    expect(b.manifest.source.batchNewestAt).not.toBe(a.manifest.source.batchNewestAt);
  });
  it("splits spatially and only changes the affected shard", () => {
    const spaces = Array.from({ length: 9 }, (_, i) => spot("測試路A", String(i), i));
    const a = assemble(input({ geometry: { sha256: pin, spots: spaces }, partitionRows: 3 }));
    const b = assemble(input({ geometry: { sha256: pin, spots: spaces }, partitionRows: 3, xml: Buffer.from(xml().replace('<cellStatus>2', '<cellStatus>1')) }));
    expect(a.shards.length).toBe(4);
    expect(a.manifest.shards.filter((s, i) => s.sha256 !== b.manifest.shards[i].sha256)).toHaveLength(1);
    const rows = a.shards.flatMap(s => s.payload.rows); expect(new Set(rows.map(r => r[0])).size).toBe(spaces.length);
    for (const s of a.manifest.shards) expect(s.bbox[2] - s.bbox[0]).toBeLessThan(0.00004);
  });
  it("rejects a geometry that would require more than 64 shards", () => {
    const geometry: Geometry = { sha256: pin, spots: Array.from({ length: 65 }, (_, i) => spot("測試路A", String(i), i)) };
    expect(() => assemble(input({ geometry, partitionRows: 1 }))).toThrow("combined-shard-cap");
  });
  it("reports real sizes and conservative 30/31-day write arithmetic", () => {
    const a = assemble(input()); expect(measured(a).manifestBytes).toBe(a.manifestBytes.length);
    expect(monthlyWrites(32, 31)).toEqual([
      { days: 30, runs: 8640, worstCase: 285120, diffOnlyEstimate: 276480, freeTier: 1000000 },
      { days: 31, runs: 8928, worstCase: 294624, diffOnlyEstimate: 285696, freeTier: 1000000 },
    ]);
  });
  it("has no file/network/log side effects when imported by node", () => {
    const url = new URL("../../tools/live-status/assemble.ts", import.meta.url).href;
    const result = spawnSync(execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module'; const bad=()=>{throw Error('side-effect')}; const original=fs.readFileSync; fs.readFileSync=(path,...args)=>{const name=path instanceof URL ? path.pathname : String(path); if(name.endsWith('.ts') || name.endsWith('package.json')) return original(path,...args); return bad()}; fs.writeFileSync=bad; http.request=bad; https.request=bad; globalThis.fetch=bad; syncBuiltinESMExports(); await import(${JSON.stringify(url)});`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe("");
  });
});
describe("LIVE-1 pinned geometry integrity", () => {
  it("validates every page/index hash, exact membership, counts and bounds", () => {
    const r = geometryRelease(); const g = readGeometry(r.bytes, r.pin, r.files);
    expect(g.sha256).toBe(r.pin); expect(g.spots).toEqual([{ ...spot("測試路A", "1"), pktype: "01" }]);
    expect(() => readGeometry(r.bytes, pin, r.files)).toThrow("geometry-pin-mismatch");
    for (const name of r.files.keys()) {
      const files = new Map(r.files); files.set(name, Buffer.from("{}"));
      expect(() => readGeometry(r.bytes, r.pin, files)).toThrow("geometry-file-hash");
      files.delete(name); expect(() => readGeometry(r.bytes, r.pin, files)).toThrow("geometry-file-hash");
    }
  });
  it.each(["count", "layout", "path", "pagecount", "duplicate-file"])("rejects pinned but inconsistent geometry %s", kind => {
    const r = geometryRelease();
    if (kind === "count") r.m.summary.kept++;
    if (kind === "layout") r.m.tileLayout = "legacy";
    if (kind === "path") r.m.files[0].file = "../escape.json";
    if (kind === "pagecount") r.m.indexes[0].pages++;
    if (kind === "duplicate-file") { r.m.files.push(r.m.files[0]); r.m.summary.pages++; }
    const bytes = Buffer.from(JSON.stringify(r.m)); expect(() => readGeometry(bytes, sha256(bytes), r.files)).toThrow();
  });
});
describe("LIVE-1 atomic schema and size rejection", () => {
  it.each([
    '<DATA>', '<OTHER/>', '<DATA/>', '<DATA><ROAD></DATA>', '<DATA></DATA>garbage',
    '<!DOCTYPE DATA [<!ENTITY x SYSTEM "file:///etc/passwd">]><DATA/>',
    xml().replace('<psId>01</psId>', '<psId>&evil;</psId>'),
    xml().replace('<psId>01</psId>', ''), xml().replace('<psId>01</psId>', '<psId>1</psId><psId>2</psId>'),
    xml().replace('<cellStatusList>', '<cellStatusList bad="x">'),
  ])("rejects malformed/incomplete XML atomically: %s", text => {
    expect(() => assemble(input({ xml: Buffer.from(text) }))).toThrow();
  });
  it("rejects byte and source-row overflow before accepting a partial capture", () => {
    expect(() => parseCapture(Buffer.alloc(LIVE_LIMITS.xmlBytes + 1))).toThrow("xml-byte-cap");
    const cell = '<cell><psId>1</psId></cell>';
    expect(() => parseCapture(Buffer.from(xml(cell.repeat(LIVE_LIMITS.sourceCells + 1))))).toThrow("xml-cell-cap");
  });
  it("rejects duplicate road IDs and trailing/truncated root data", () => {
    const body = xml().replace('<DATA>', '').replace('</DATA>', '');
    expect(() => parseCapture(Buffer.from(`<DATA>${body}${body}</DATA>`))).toThrow("xml-duplicate-road");
    expect(() => parseCapture(Buffer.from(xml() + '<'))).toThrow();
  });
  it("checks version, geometry, IDs, join semantics, hashes, sizes and manifest totals", () => {
    const a = assemble(input()); const s = a.shards[0].payload;
    expect(() => validateShard(s, "b".repeat(64), s.id)).toThrow();
    expect(() => validateShard({ ...s, v: 2 }, pin, s.id)).toThrow();
    expect(() => validateShard({ ...s, rows: [...s.rows, ...s.rows] }, pin, s.id)).toThrow("shard-ids");
    expect(() => validateShard(s, pin, s.id, ["wrong-id"])).toThrow("shard-membership");
    expect(() => validateShard({ ...s, rows: [[s.rows[0][0], "unmatched", "alias", null, null, null]] }, pin, s.id)).toThrow();
    expect(() => validateShard({ ...s, rows: Array(2049).fill(s.rows[0]) }, pin, s.id)).toThrow("shard-row-cap");
    for (const mutate of [
      (m: typeof a.manifest) => { m.v = 2 as 1; },
      (m: typeof a.manifest) => { m.shards[0].sha256 = "bad"; },
      (m: typeof a.manifest) => { m.shards[0].key = "https://evil.example/x"; },
      (m: typeof a.manifest) => { m.shards[0].bytes = 131073; },
      (m: typeof a.manifest) => { m.shards[0].gzipBytes = 32769; },
      (m: typeof a.manifest) => { m.geometry.total++; },
      (m: typeof a.manifest) => { m.source.capturedAt = "2027-01-01T00:00:00.000Z"; },
      (m: typeof a.manifest) => { m.source.batchNewestAt = m.checkedAt; },
      (m: typeof a.manifest) => { m.shards = Array(65).fill(m.shards[0]); },
    ]) { const m = structuredClone(a.manifest); mutate(m); expect(() => validateManifest(m, pin)).toThrow(); }
  });
});

describe("LIVE-1 byte-level reader integrity", () => {
  it("verifies exact decoded hashes, generation, row counts and expected membership", async () => {
    const a = assemble(input()); const s = a.shards[0]; const ref = a.manifest.shards[0];
    expect(await parseManifestBytes(a.manifestBytes, pin)).toEqual(a.manifest);
    expect(await parseShardBytes(s.bytes, pin, ref, s.payload.rows.map(r => r[0]))).toEqual(s.payload);
    const modified = new Uint8Array(s.bytes); modified[modified.length - 2] ^= 1;
    await expect(parseShardBytes(modified, pin, ref)).rejects.toThrow("shard-hash-mismatch");
    await expect(parseShardBytes(s.bytes, pin, { ...ref, rows: ref.rows + 1 })).rejects.toThrow("shard-ref-count");
    await expect(parseShardBytes(s.bytes, pin, { ...ref, bytes: ref.bytes + 1 })).rejects.toThrow("shard-byte-cap-or-length");
    await expect(parseShardBytes(s.bytes, pin, ref, ["other"])).rejects.toThrow("shard-membership");
    await expect(parseManifestBytes(Buffer.from(JSON.stringify({ ...a.manifest, generation: "b".repeat(64) })), pin)).rejects.toThrow("generation-hash-mismatch");
    await expect(parseManifestBytes(Buffer.alloc(32769), pin)).rejects.toThrow("manifest-byte-cap");
  });
  it("rejects decoded shard and gzip overflow without silently adding unbudgeted objects", () => {
    const large = { sha256: pin, spots: Array.from({ length: 1800 }, (_, i) => spot("長".repeat(50), String(i), i)) };
    expect(() => assemble(input({ geometry: large }))).toThrow("shard-byte-cap");
    const cells = Array.from({ length: 400 }, (_, i) => `<cell><psId>${sha256(`id${i}`)}</psId><cellStatus>${sha256(`status${i}`)}</cellStatus><data_Dt>${sha256(`time${i}`)}</data_Dt></cell>`).join("");
    const geometry = { sha256: pin, spots: Array.from({ length: 400 }, (_, i) => spot("測試路A", sha256(`id${i}`), i)) };
    expect(() => assemble(input({ geometry, xml: Buffer.from(xml(cells)) }))).toThrow("shard-gzip-cap");
  });
});
