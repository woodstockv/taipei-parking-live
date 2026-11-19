import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assemble, parseCapture, sha256, type Geometry } from "../../tools/live-status/assemble.ts";
import { analyzeCoverage } from "../../tools/live-status/coverage.ts";
import { joinSpaces } from "../src/tcmsvJoin.ts";
import type { LiveManifest } from "../../shared/liveStatus.ts";

const pin = "e7a882774f11a7d78c0ff1606290a76fd1dea45403c8949f2c593373f1cc0608";
const sourceHash = "95570650b1ac419e8e8b972bf91d407bbb8b9066153c0669b9fde0ffe404129f";
const fixture = (name: string) => readFileSync(new URL(`../../tools/live-status/fixtures/live7/${name}`, import.meta.url));
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

describe("LIVE-7Q1 full-snapshot offline replay", () => {
  it("recovers road aliases and fails closed on all 68 ambiguous geometry keys", () => {
    const xml = gunzipSync(fixture("source.xml.gz"));
    const geometryBytes = gunzipSync(fixture("geometry.json.gz"));
    const manifestBytes = fixture("published-manifest.json");
    const ambiguousBytes = fixture("published-ambiguous-ids.json");
    // Independent byte pins: geometrySha256 is the provenance pin, not a hash
    // of the later geometry-partitions file. Keep those two identities distinct.
    expect(sha256(xml)).toBe(sourceHash);
    expect(xml.length).toBe(8_533_693);
    expect(sha256(geometryBytes)).toBe("55c9fc8d4487d8b0cf67a244d59ccf0b4d4520ec9038d71eb446af77fa0987d1");
    expect(sha256(manifestBytes)).toBe("05861f80cb1a3364a9ed1f6ad83071bdcc09b0109459cfb6cc8476fb28ff4645");
    expect(sha256(ambiguousBytes)).toBe("e9166105787b1b61c662e49bf434b1ec624388f8484aa29ce94cc77e01861d0b");
    const published = JSON.parse(text(manifestBytes)) as LiveManifest;
    const raw = JSON.parse(text(geometryBytes)) as {
      sha256: string; shards: { id: string; points: [string, number, number][] }[];
    };
    expect(raw.sha256).toBe(pin);
    expect(published.geometrySha256).toBe(pin);
    expect(published.source.sha256).toBe(sourceHash);
    const geometry: Geometry = { sha256: pin, spots: raw.shards.flatMap(s => s.points.map(([id, lng, lat]) => {
      const [, road, pkid] = id.split(":"); return { id, road, pkid, lng, lat };
    })) };
    const before = sha256(JSON.stringify(geometry));
    const a = assemble({ xml, geometry, capturedAt: published.source.capturedAt, checkedAt: published.checkedAt,
      publishedAt: published.publishedAt, etag: published.source.etag, lastModified: published.source.lastModified });
    expect(a.manifest.geometry).toEqual({ total: 51_536, matched: 21_332, unmatched: 30_136, ambiguous: 68 });
    expect(a.manifest.cells).toEqual({ total: 29_422, matched: 21_332, unmatched: 7_812, ambiguous: 278 });
    expect(a.manifest.source).toEqual(published.source);
    expect(a.manifest.geometrySha256).toBe(pin);
    expect(sha256(JSON.stringify(geometry))).toBe(before);
    expect(a.shards).toHaveLength(32);
    for (let i = 0; i < a.shards.length; i++) {
      expect(a.shards[i].payload.id).toBe(raw.shards[i].id);
      expect(a.shards[i].payload.rows.map(r => r[0])).toEqual(raw.shards[i].points.map(p => p[0]).sort());
      expect(a.manifest.shards[i].bbox).toEqual(published.shards[i].bbox);
    }
    const rows = a.shards.flatMap(s => s.payload.rows);
    expect(new Set(rows.map(r => r[0])).size).toBe(51_536);
    const previousAmbiguous = JSON.parse(text(ambiguousBytes)) as string[];
    expect(previousAmbiguous).toHaveLength(64);
    const newAmbiguous = ["tpe:信義路5段150巷:03", "tpe:信義路5段150巷:04", "tpe:信義路5段150巷:05", "tpe:內湖路2段:21"];
    expect(rows.filter(r => r[1] === "ambiguous").map(r => r[0]).sort()).toEqual([...previousAmbiguous, ...newAmbiguous].sort());
    const cells = parseCapture(xml).cells;
    const source = new Map(cells.map(c => [JSON.stringify([c.roadSegId, c.psId]), c]));
    const aliases = new Set<string>();
    for (const r of rows) {
      if (r[1] !== "matched") { expect(r.slice(2)).toEqual([null, null, null, null]); continue; }
      const alias = JSON.stringify([r[2], r[3]]);
      expect(aliases.has(alias)).toBe(false); aliases.add(alias);
      const c = source.get(alias)!;
      expect(c).toBeDefined();
      expect(r.slice(2)).toEqual([c.roadSegId, c.psId, c.cellStatus, c.collectedAt]);
    }
    expect(aliases.size).toBe(21_332);
    const joined = joinSpaces(geometry.spots, cells);
    expect(joined).toMatchObject({ matched: 21_332, unmatched: 30_136, ambiguous: 68 });
    // Every caller must see the same assignments; the assembler's additional
    // guard must no longer be needed to clear any shared-join matches.
    const sharedRows = new Map(joined.rows.map(r => [r.id, [r.id, r.join, r.roadSegId, r.psId, r.rawCellStatus, r.data_Dt]]));
    expect(rows).toEqual(rows.map(r => sharedRows.get(r[0])));
    const coverage = analyzeCoverage(geometry, xml);
    expect(coverage.reasons.matched).toBe(21_332);
    expect(coverage.unmatched).toBe(7_812);
    expect(coverage.ambiguous).toBe(278);
    expect(coverage.ambiguityDetails.cellsWithExactGeometryKey).toBe(136);
    // 4,499 formerly unmatched rows gain unique matches; four previously
    // matched keys become ambiguous. Net improvement is 4,495, not 4,499.
    expect(a.manifest.geometry.matched - published.geometry.matched).toBe(4_495);
  }, 20_000);
});
