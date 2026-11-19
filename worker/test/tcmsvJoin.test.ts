import { describe, expect, it } from "vitest";
import { canonicalSpaceId, joinSpaces, normalizeRoadName, roadParts, type TcmsvCell } from "../src/tcmsvJoin.ts";

const cell = (roadName: string, roadSegId = "4092534", psId = "01"): TcmsvCell => ({
  roadName, roadSegId, psId, cellStatus: "2", collectedAt: "2026-11-19 16:00:00",
});
const space = (road: string, pkid = "1") => ({ id: `tpe:${road}:${pkid}`, road, pkid });

describe("LIVE-7Q1 matching-only road normalization", () => {
  it.each(["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"])("normalizes section %s and preserves the road letter", n => {
    const number = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"].indexOf(n) + 1;
    expect(normalizeRoadName(` 中山北路${n}段53巷A `)).toBe(`中山北路${number}段53巷A`);
    expect(roadParts(`中山北路${n}段53巷A`)).toEqual({ family: `中山北路${number}段53巷`, letter: "A" });
  });
  it("strips an anchored metadata prefix only with its own exact source ID", () => {
    expect(normalizeRoadName(" 4092534(12150) 萬大路534巷 ", "4092534")).toBe("萬大路534巷");
    expect(normalizeRoadName("409253A(12150) 環河南路二段A", "409253A")).toBe("環河南路2段A");
    expect(normalizeRoadName("4092534(12150) 萬大路534巷", "4092535")).toBe("4092534(12150) 萬大路534巷");
    expect(normalizeRoadName("4092534(12150) 萬大路534巷")).toBe("4092534(12150) 萬大路534巷");
    expect(normalizeRoadName("04092534(12150) 萬大路534巷", "4092534")).toBe("04092534(12150) 萬大路534巷");
  });
  it.each([
    "萬大路4092534(12150) 534巷", "4092534(12150)萬大路534巷", "4092534(foo) 萬大路534巷",
    "一江街", "三民路十巷", "中山北路1段", "路十一段", "路二十段", "路一百段", "路零一段",
  ])("preserves non-section text and unsupported spellings: %s", name => {
    expect(normalizeRoadName(name, "4092534")).toBe(name);
  });
  it("is idempotent and leaves local ID suffixes distinct", () => {
    const name = "4092534(12150) 環河南路二段A";
    expect(normalizeRoadName(normalizeRoadName(name, "4092534"), "4092534")).toBe("環河南路2段A");
    expect(canonicalSpaceId("136")).toBe("136");
    expect(canonicalSpaceId("136A ")).toBe("136A");
  });
  it("matches both rules while retaining original geometry fields and provider psId", () => {
    const s = space("環河南路2段A", "136A");
    const c = cell("4092534(12150) 環河南路二段A", "4092534", "136A ");
    const original = structuredClone({ s, c });
    expect(joinSpaces([s], [c]).rows[0]).toMatchObject({ ...s, join: "matched", roadSegId: c.roadSegId, psId: "136A " });
    expect({ s, c }).toEqual(original);
  });
  it("rejects a mismatched prefix, cross-road letters and local ID letters", () => {
    const result = joinSpaces([
      space("萬大路534巷"), space("環河南路2段B"), space("環河南路2段A", "136A"),
    ], [cell("4092535(12150) 萬大路534巷"), cell("環河南路二段A"), cell("環河南路二段A", "4092534", "136")]);
    expect(result).toMatchObject({ matched: 0, unmatched: 3, ambiguous: 0, crossLetter: 1 });
    expect(result.rows.every(r => r.psId === null && r.rawCellStatus === null)).toBe(true);
  });
  it("fails closed on source collisions exposed by either rule, regardless of source order", () => {
    const s = space("信義路5段150巷", "03");
    const cells = [cell("信義路五段150巷", "302600A", "03"), cell("3026150(12345) 信義路5段150巷", "3026150", "3")];
    cells[1].cellStatus = "1";
    for (const candidates of [cells, [...cells].reverse()]) {
      expect(joinSpaces([s], candidates)).toMatchObject({ matched: 0, unmatched: 0, ambiguous: 1 });
      expect(joinSpaces([s], candidates).rows[0]).toMatchObject({ join: "ambiguous", roadSegId: null, psId: null, rawCellStatus: null, collectedAt: null, status: "unknown" });
    }
  });
  it.each([
    [space("測試路1段A"), space("測試路一段A")],
    [space("測試路1段A", "01"), space("測試路1段A", "1")],
  ])("rejects every geometry sharing a normalized provider key %#", (a, b) => {
    const cells = [cell("測試路一段A", "100", "1"), cell("測試路一段A", "100", "136A ")];
    const unique = space("測試路1段A", "136A");
    for (const spaces of [[a, b, unique], [unique, b, a]]) {
      const result = joinSpaces(spaces, cells);
      expect(result).toMatchObject({ matched: 1, unmatched: 0, ambiguous: 2 });
      for (const s of [a, b]) expect(result.rows.find(r => r.id === s.id)).toEqual({
        ...s, join: "ambiguous", crossLetter: false, roadSegId: null, psId: null,
        rawCellStatus: null, data_Dt: null, collectedAt: null, status: "unknown",
      });
      expect(result.rows.find(r => r.id === unique.id)).toMatchObject({ join: "matched", psId: "136A ", status: "free" });
    }
  });
  it("rejects all geometries reusing a raw provider alias under distinct source keys", () => {
    const cells = [cell("測試路一段A", "100", "1"), cell("另一條路B", "100", "1")];
    const spaces = [space("測試路1段A"), space("另一條路B")];
    for (const candidates of [cells, [...cells].reverse()]) {
      const result = joinSpaces(spaces, candidates);
      expect(result).toMatchObject({ matched: 0, unmatched: 0, ambiguous: 2 });
      for (const row of result.rows) expect(row).toMatchObject({
        join: "ambiguous", roadSegId: null, psId: null, rawCellStatus: null, data_Dt: null, collectedAt: null, status: "unknown",
      });
      // Even if the other source record has no geometry, this alias is not unique.
      expect(joinSpaces(spaces.slice(0, 1), candidates)).toMatchObject({ matched: 0, unmatched: 0, ambiguous: 1 });
    }
  });
  it("keeps duplicated geometry keys unmatched when no provider candidate exists", () => {
    expect(joinSpaces([space("測試路1段A"), space("測試路一段A")], [])).toMatchObject({ matched: 0, unmatched: 2, ambiguous: 0 });
  });
});
