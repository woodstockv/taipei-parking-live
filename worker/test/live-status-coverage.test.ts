import { execPath } from "node:process";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeCoverage, classifyCoverage, parseCsv } from "../../tools/live-status/coverage.ts";
import { assemble, type Geometry, type GeometrySpot } from "../../tools/live-status/assemble.ts";
import { joinSpaces, type TcmsvCell } from "../src/tcmsvJoin.ts";

const pin = "a".repeat(64);
const spot = (road: string, pkid: string): GeometrySpot => ({ road, pkid, id: `tpe:${road}:${pkid}`, lat: 25.05, lng: 121.53 });
const g: Geometry = { sha256: pin, spots: [spot("測試路A", "1"), spot("測試路A", "01"), spot("測試路A", "2")] };
const cell = (roadName: string, psId: string, roadSegId = "100"): TcmsvCell => ({ roadName, psId, roadSegId, cellStatus: "2", collectedAt: "2026-11-17 09:00:00" });
describe("LIVE-3 reproducible coverage", () => {
  it.each(['geometry key', 'source key', 'provider alias'])('agrees with the shared join on %s collisions', kind => {
    const geometry = { sha256: pin, spots: [spot('測試路1段A', '1'), spot(kind === 'provider alias' ? '另一條路B' : '測試路一段A', '1')] };
    const cells = [cell('測試路一段A', '1', '100')];
    if (kind !== 'geometry key') cells.push(cell(geometry.spots[1].road, '1', kind === 'provider alias' ? '100' : '200'));
    const expected = kind === 'geometry key' ? 'ambiguous-geometry-key' : kind === 'source key' ? 'ambiguous-source-key' : 'ambiguous-source-alias';
    expect(classifyCoverage(geometry, cells).map(c => c.reason)).toEqual(cells.map(() => expected));
    expect(joinSpaces(geometry.spots, cells)).toMatchObject({ matched: 0, unmatched: 0, ambiguous: 2 });
  });

  it("uses the same validated road aliases for keys and family/letter diagnostics, retaining raw labels", () => {
    const geometry = { sha256: pin, spots: [spot("環河南路2段A", "136"), spot("環河南路2段A", "136A"), spot("中山北路一段", "1")] };
    const cells = [cell("4092534(12150) 環河南路二段A", "136", "4092534"),
      cell("環河南路二段A", "136A", "200"), cell("中山北路1段", "01", "300"),
      cell("環河南路二段B", "136", "400"), cell("環河南路二段A", "136B", "500"),
      cell("4092535(12150) 環河南路二段A", "136", "600")];
    const classified = classifyCoverage(geometry, cells);
    expect(classified.map(c => c.reason)).toEqual(["matched", "matched", "matched", "no-road-letter", "no-local-id", "no-road-family"]);
    expect(classified.map(c => c.cell)).toEqual(cells);
    expect(classified[0].cell.roadName).toBe("4092534(12150) 環河南路二段A");
  });
  it("keeps normalized source and geometry collisions ambiguous", () => {
    const geometry = { sha256: pin, spots: [spot("信義路5段150巷", "03"), spot("內湖路2段", "21"), spot("內湖路二段", "21")] };
    const classified = classifyCoverage(geometry, [cell("信義路五段150巷", "03", "302600A"),
      cell("3026150(12345) 信義路5段150巷", "3", "3026150"), cell("內湖路二段", "21", "2108000")]);
    expect(classified.map(c => c.reason)).toEqual(["ambiguous-source-key", "ambiguous-source-key", "ambiguous-geometry-key"]);
  });
  it("separates family, exact road letter, and local ID misses", () => {
    const reasons = classifyCoverage(g, [cell("未知路A", "1", "100"), cell("測試路B", "2", "200"), cell("測試路A", "3", "300"), cell("測試路A", "2", "400")]).map(c => c.reason);
    expect(reasons).toEqual(["no-road-family", "no-road-letter", "no-local-id", "matched"]);
  });
  it("preserves ambiguity from canonical source keys, raw aliases and geometry collisions", () => {
    expect(classifyCoverage(g, [cell("測試路A", "1")])[0].reason).toBe("ambiguous-geometry-key");
    expect(classifyCoverage(g, [cell("測試路A", "02"), cell("測試路A", "2", "200")]).every(c => c.reason === "ambiguous-source-key")).toBe(true);
    expect(classifyCoverage(g, [cell("測試路A", "2"), cell("別的路A", "2")]).every(c => c.reason === "ambiguous-source-alias")).toBe(true);
  });
  it("does not borrow across an absent road letter", () => { expect(classifyCoverage(g, [cell("測試路", "2")])[0].reason).toBe("no-road-letter"); });
  it("distinguishes duplicate-key ambiguity from an available cross-letter candidate", () => {
    const road = (id: string, name: string, ids: string[]) => `<ROAD><roadSegID>${id}</roadSegID><roadSegName>${name}</roadSegName><roadSegCarType>1</roadSegCarType><cellStatusList>${ids.map(psId => `<cell><psId>${psId}</psId><cellStatus>2</cellStatus></cell>`).join("")}</cellStatusList></ROAD>`;
    const xml = new TextEncoder().encode(`<DATA>${road("100", "測試路A", ["2", "02", "7", "07"])}${road("200", "測試路B", ["2"])}</DATA>`);
    const c = analyzeCoverage(g, xml);
    expect(c.ambiguityDetails).toEqual({ duplicateSourceKeys: 2, cellsWithExactGeometryKey: 2, cellsWithoutExactGeometryKey: 2 });
    expect(c.crossLetterCandidatesAmongUnmatched).toBe(1);
    expect(c.ambiguousByRoadName).toEqual([{ road: "測試路A", unmatched: 0, ambiguous: 4 }]);
    expect(c.byRawCarType).toEqual([{ carType: "1", matched: 0, unmatched: 1, ambiguous: 4 }]);
    expect(c.sourceFields).toMatchObject({ cells: { psId: 5, cellStatus: 5 }, roads: { roadSegCarType: 2, cellStatusList: 2 }, nonzeroCoordinateCells: 0 });
  });
  it("agrees with LIVE-1 full counts on saved sanitized fixture", () => {
    const xml = readFileSync(new URL("../../tools/live-status/fixtures/taipei.xml", import.meta.url));
    const geometry = { sha256: pin, spots: [spot("伊通街A", "19"), spot("伊通街B", "17"), spot("一江街", "9"), ...g.spots] };
    const a = assemble({ geometry, xml, capturedAt: "2026-11-17T02:00:00.000Z", checkedAt: "2026-11-17T02:00:00.000Z", publishedAt: "2026-11-17T02:00:00.000Z", etag: null, lastModified: null });
    const c = analyzeCoverage(geometry, xml);
    expect(c.cells).toBe(a.manifest.cells.total); expect(c.unmatched).toBe(a.manifest.cells.unmatched); expect(c.ambiguous).toBe(a.manifest.cells.ambiguous);
    expect(c.reasons.matched ?? 0).toBe(a.manifest.cells.matched);
  });
  it("reports raw road types and cross-city name collisions without claiming identity", () => {
    const xml = new TextEncoder().encode('<DATA><ROAD><roadSegID>100</roadSegID><roadSegName>別的路A</roadSegName><roadSegCarType>1</roadSegCarType><roadSegUsage>-99.0</roadSegUsage><cellStatusList><cell><psId>1</psId><cellStatus>2</cellStatus></cell></cellStatusList></ROAD></DATA>');
    const c = analyzeCoverage(g, xml, [{ roadid: "K03", roadname: "別的路A", cellid: "1", countycode: "65000" }]);
    expect(c.byRawRoadType).toEqual([{ carType: "1", usage: "-99.0", matched: 0, unmatched: 1, ambiguous: 0 }]);
    expect(c.ntpc).toMatchObject({ rows: 1, keysAlsoInTaipei: 1, unmatchedTaipeiCellsWithSameLocalKey: 1, validCrossCityIdentityMatches: 0 });
    expect(c.district).toContain("unmeasured"); expect(c.spaceType).toContain("unmeasured");
  });
  it("parses BOM, commas, escaped quotes, CRLF and multiline CSV fields", () => {
    expect(parseCsv('\uFEFFid,name\r\n1,"a,b"\r\n2,"say ""hi""\nnext"\r\n')).toEqual([{ id: "1", name: "a,b" }, { id: "2", name: 'say "hi"\nnext' }]);
  });
  it.each(['id,name\n1,"truncated', 'id,name\n1', 'id,id\n1,2', '\uFEFFid,id\n1,2', 'id,name\n1,"x"oops'])('rejects malformed CSV %#', text => { expect(() => parseCsv(text)).toThrow(); });
  it("CLI rejects unknown options before local input reads", () => {
    const cli = spawnSync(execPath, ["--experimental-strip-types", "../tools/live-status/coverage.ts", "--url", "https://source.invalid"], { encoding: "utf8" });
    expect(cli.status).toBe(1); expect(cli.stderr).toContain("expected-unique-known-option-value-pairs");
  });
  it("entrypoint CLI fails closed when R2 env is missing, before source I/O", () => {
    const cli = spawnSync(execPath, ["--experimental-transform-types", "../tools/live-status/runner-entrypoint.ts"], {
      encoding: "utf8", env: { PATH: "" },
    });
    expect(cli.status).toBe(1); expect(cli.stderr).toContain("missing-r2-env");
    expect(cli.stderr).not.toContain("R2_ADAPTER_NOT_IMPLEMENTED");
    expect(cli.stdout).toBe("");
  });
});
