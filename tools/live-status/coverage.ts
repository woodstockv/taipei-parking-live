/** Read-only local coverage analysis. No HTTP client or import-time I/O. */
import process from "node:process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCapture, readGeometry, sha256, type Geometry } from "./assemble.ts";
import { canonicalSpaceId, roadParts, type TcmsvCell } from "../../worker/src/tcmsvJoin.ts";

const key = (road: string, id: string): string => {
  const p = roadParts(road); return JSON.stringify([p.family, p.letter, canonicalSpaceId(id)]);
};
const alias = (c: TcmsvCell): string => JSON.stringify([c.roadSegId, c.psId]);
function counts(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}
export type CoverageReason = "matched" | "ambiguous-source-key" | "ambiguous-source-alias" | "ambiguous-geometry-key" | "no-road-family" | "no-road-letter" | "no-local-id";
export function classifyCoverage(geometry: Geometry, cells: TcmsvCell[]) {
  const families = new Set(geometry.spots.map(s => roadParts(s.road).family));
  const roads = new Set(geometry.spots.map(s => { const p = roadParts(s.road); return JSON.stringify([p.family, p.letter]); }));
  const geometryKeys = counts(geometry.spots.map(s => key(s.road, s.pkid)));
  const sourceKeys = counts(cells.map(c => key(c.roadName, c.psId)));
  const aliases = counts(cells.map(alias));
  return cells.map(cell => {
    const k = key(cell.roadName, cell.psId); const p = roadParts(cell.roadName);
    let reason: CoverageReason;
    // Same ambiguity precedence and raw provider-alias rules as LIVE-1.
    if (sourceKeys.get(k)! > 1) reason = "ambiguous-source-key";
    else if (aliases.get(alias(cell))! > 1) reason = "ambiguous-source-alias";
    else if ((geometryKeys.get(k) ?? 0) > 1) reason = "ambiguous-geometry-key";
    else if (geometryKeys.has(k)) reason = "matched";
    else if (!families.has(p.family)) reason = "no-road-family";
    else if (!roads.has(JSON.stringify([p.family, p.letter]))) reason = "no-road-letter";
    else reason = "no-local-id";
    return { cell, reason };
  });
}
export function localBytes(path: string, cap: number): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > cap) throw new Error("local-input-cap");
  const bytes = readFileSync(path); if (bytes.length > cap) throw new Error("local-input-grew");
  return bytes;
}
export function localGeometry(dir: string, pin: string): Geometry {
  const bytes = localBytes(resolve(dir, "provenance.json"), 2_000_000);
  if (sha256(bytes) !== pin) throw new Error("geometry-pin-mismatch");
  const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { files: { file: string }[]; indexes: { file: string }[] };
  if (!Array.isArray(m.files) || !Array.isArray(m.indexes) || m.files.length + m.indexes.length > 8192) throw new Error("geometry-inventory");
  const files = new Map<string, Uint8Array>();
  for (const f of [...m.files, ...m.indexes]) {
    if (!/^\d{2}\.\d{2}_\d{3}\.\d{2}(?:\.p[1-9]\d*|\.index)?\.json$/.test(f.file)) throw new Error("geometry-path");
    files.set(f.file, localBytes(resolve(dir, f.file), 48_000));
  }
  return readGeometry(bytes, pin, files);
}
/** RFC4180 subset including quoted commas, CRLF, escaped quotes and multiline fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ""; closed = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else { if (closed || c === '"') throw new Error("csv-syntax"); field += c; }
  }
  if (quoted) throw new Error("csv-truncated");
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) throw new Error("csv-header");
  header[0] = header[0].replace(/^\uFEFF/, "");
  if (new Set(header).size !== header.length) throw new Error("csv-header");
  return rows.map(r => { if (r.length !== header.length) throw new Error("csv-columns"); return Object.fromEntries(header.map((h, i) => [h, r[i]])); });
}
function xmlScalar(body: string, tag: string): string {
  const matches = [...body.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))];
  if (matches.length > 1) throw new Error("coverage-duplicate-road-scalar");
  const raw = matches[0]?.[1] ?? "";
  return raw.replace(/&([^;]+);/g, (_, s: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[s] ?? String.fromCodePoint(s.startsWith("#x") ? parseInt(s.slice(2), 16) : Number(s.slice(1)))));
}
export function analyzeCoverage(geometry: Geometry, xml: Uint8Array, ntpc: Record<string, string>[] = []) {
  for (const row of ntpc) if (["roadid", "roadname", "cellid", "countycode"].some(k => typeof row[k] !== "string" || !row[k])) throw new Error("ntpc-schema");
  const capture = parseCapture(xml); const classified = classifyCoverage(geometry, capture.cells);
  const metadata = new Map<string, { carType: string; usage: string }>();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(xml);
  const roadFields: string[] = []; const cellFields: string[] = []; let nonzeroCoordinateCells = 0;
  const coordinates = new Set<string>();
  for (const road of text.matchAll(/<ROAD>([\s\S]*?)<\/ROAD>/g)) {
    metadata.set(xmlScalar(road[1], "roadSegID"), {
      carType: xmlScalar(road[1], "roadSegCarType") || "(missing)", usage: xmlScalar(road[1], "roadSegUsage") || "(missing)",
    });
    const direct = road[1].replace(/<cellStatusList>[\s\S]*?<\/cellStatusList>/g, "<cellStatusList></cellStatusList>");
    roadFields.push(...[...direct.matchAll(/<([A-Za-z][A-Za-z0-9_]*)(?:\s*\/)?>/g)].map(m => m[1]));
    for (const cell of road[1].matchAll(/<cell>([\s\S]*?)<\/cell>/g)) {
      cellFields.push(...[...cell[1].matchAll(/<([A-Za-z][A-Za-z0-9_]*)(?:\s*\/)?>/g)].map(m => m[1]));
      const x = Number(xmlScalar(cell[1], "coord_X")); const y = Number(xmlScalar(cell[1], "coord_Y"));
      if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) { nonzeroCoordinateCells++; coordinates.add(JSON.stringify([x, y])); }
    }
  }
  const reasons = Object.fromEntries(counts(classified.map(c => c.reason)));
  const geometryKeys = new Set(geometry.spots.map(s => key(s.road, s.pkid)));
  const geometryFamilyIds = new Set(geometry.spots.map(s => JSON.stringify([roadParts(s.road).family, canonicalSpaceId(s.pkid)])));
  const ambiguous = classified.filter(c => c.reason.startsWith("ambiguous"));
  const sourceKeyCounts = counts(capture.cells.map(c => key(c.roadName, c.psId)));
  const byRoad = new Map<string, { roadSegId: string; road: string; unmatched: number; ambiguous: number }>();
  const byRoadName = new Map<string, { road: string; unmatched: number; ambiguous: number }>();
  const byType = new Map<string, { carType: string; usage: string; matched: number; unmatched: number; ambiguous: number }>();
  const byCarType = new Map<string, { carType: string; matched: number; unmatched: number; ambiguous: number }>();
  for (const { cell, reason } of classified) {
    const state = reason === "matched" ? "matched" : reason.startsWith("ambiguous") ? "ambiguous" : "unmatched";
    const road = byRoad.get(cell.roadSegId) ?? { roadSegId: cell.roadSegId, road: cell.roadName, unmatched: 0, ambiguous: 0 };
    if (state !== "matched") road[state]++;
    byRoad.set(cell.roadSegId, road);
    const name = byRoadName.get(cell.roadName) ?? { road: cell.roadName, unmatched: 0, ambiguous: 0 };
    if (state !== "matched") name[state]++;
    byRoadName.set(cell.roadName, name);
    const type = metadata.get(cell.roadSegId)!; const typeKey = JSON.stringify(type);
    const group = byType.get(typeKey) ?? { ...type, matched: 0, unmatched: 0, ambiguous: 0 }; group[state]++; byType.set(typeKey, group);
    const carGroup = byCarType.get(type.carType) ?? { carType: type.carType, matched: 0, unmatched: 0, ambiguous: 0 };
    carGroup[state]++; byCarType.set(type.carType, carGroup);
  }
  const sourceRoads = new Set(capture.cells.map(c => c.roadName));
  const sourceKeys = new Set(capture.cells.map(c => key(c.roadName, c.psId)));
  const unmatchedKeys = new Set(classified.filter(c => c.reason.startsWith("no-")).map(c => key(c.cell.roadName, c.cell.psId)));
  const ntpcKeys = new Set(ntpc.map(r => key(r.roadname, r.cellid)));
  const ntpcRoads = new Set(ntpc.map(r => r.roadname));
  const taipeiCountyRows = ntpc.filter(r => r.countycode === "63000");
  const providerAliases = new Set(capture.cells.map(alias));
  const geometryCoordinates = new Set(geometry.spots.map(s => JSON.stringify([s.lat, s.lng])));
  return {
    geometrySha256: geometry.sha256, xmlSha256: sha256(xml), xmlBytes: xml.length, roads: capture.roads, cells: capture.cells.length,
    sourceFields: { roads: Object.fromEntries(counts(roadFields)), cells: Object.fromEntries(counts(cellFields)),
      nonzeroCoordinateCells, distinctNonzeroCoordinates: coordinates.size },
    reasons, unmatched: classified.filter(c => c.reason.startsWith("no-")).length,
    ambiguous: ambiguous.length,
    ambiguityDetails: { duplicateSourceKeys: [...sourceKeyCounts.values()].filter(n => n > 1).length,
      cellsWithExactGeometryKey: ambiguous.filter(c => geometryKeys.has(key(c.cell.roadName, c.cell.psId))).length,
      cellsWithoutExactGeometryKey: ambiguous.filter(c => !geometryKeys.has(key(c.cell.roadName, c.cell.psId))).length },
    crossLetterCandidatesAmongUnmatched: classified.filter(c => c.reason.startsWith("no-") &&
      geometryFamilyIds.has(JSON.stringify([roadParts(c.cell.roadName).family, canonicalSpaceId(c.cell.psId)]))).length,
    byRoad: [...byRoad.values()].filter(r => r.unmatched || r.ambiguous).sort((a, b) => b.unmatched - a.unmatched || a.roadSegId.localeCompare(b.roadSegId)),
    ambiguousByRoadName: [...byRoadName.values()].filter(r => r.ambiguous).sort((a, b) => b.ambiguous - a.ambiguous || a.road.localeCompare(b.road)),
    byRawCarType: [...byCarType.values()].sort((a, b) => a.carType.localeCompare(b.carType)),
    byRawRoadType: [...byType.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    district: "unmeasured: no district/area field or authoritative road-to-district mapping in these inputs",
    spaceType: "unmeasured: XML has no per-cell space-type field; roadSegCarType/roadSegUsage are raw road-level values",
    ntpc: { rows: ntpc.length, countyCodes: Object.fromEntries(counts(ntpc.map(r => r.countycode))),
      rowsWithTaipeiCountyCode: taipeiCountyRows.length, distinctRoadIds: new Set(ntpc.map(r => r.roadid)).size,
      distinctRoads: ntpcRoads.size, exactRoadNamesInTaipei: [...ntpcRoads].filter(r => sourceRoads.has(r)).sort(),
      distinctLocalKeys: ntpcKeys.size, keysAlsoInTaipei: [...ntpcKeys].filter(k => sourceKeys.has(k)).length,
      unmatchedTaipeiCellsWithSameLocalKey: classified.filter(c => unmatchedKeys.has(key(c.cell.roadName, c.cell.psId)) && ntpcKeys.has(key(c.cell.roadName, c.cell.psId))).length,
      rawProviderAliasCollisions: ntpc.filter(r => providerAliases.has(JSON.stringify([r.roadid, r.cellid]))).length,
      coordinatesExactlyEqualToPinnedGeometry: ntpc.filter(r => geometryCoordinates.has(JSON.stringify([Number(r.latitude), Number(r.longitude)]))).length,
      validCrossCityIdentityMatches: taipeiCountyRows.filter(r => sourceKeys.has(key(r.roadname, r.cellid))).length,
      identityRule: "Taipei county code 63000 required before local-key comparisons; NTPC 65000 is a different city. No cross-city bridge supplied. Coordinate equality is diagnostic, not an identity mapping." },
  };
}
function main(args: string[]): void {
  const options = new Map<string, string>();
  const allowed = ["--geometry", "--geometry-sha256", "--xml", "--ntpc-csv", "--compare-xml", "--candidate-material"];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error("expected-unique-known-option-value-pairs");
    options.set(args[i], args[i + 1]);
  }
  const required = (k: string): string => { const v = options.get(k); if (!v) throw new Error(`missing ${k}`); return v; };
  const geometry = localGeometry(required("--geometry"), required("--geometry-sha256"));
  const ntpcBytes = options.has("--ntpc-csv") ? localBytes(required("--ntpc-csv"), 20_000_000) : null;
  const ntpc = ntpcBytes ? parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(ntpcBytes)) : [];
  const xml = localBytes(required("--xml"), 20_000_000);
  const result = analyzeCoverage(geometry, xml, ntpc);
  const comparison = options.has("--compare-xml") ? analyzeCoverage(geometry, localBytes(required("--compare-xml"), 20_000_000), ntpc) : null;
  const candidateMaterial = options.has("--candidate-material") ? required("--candidate-material").split(",").map(path => {
    const bytes = localBytes(path, 20_000_000); const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { path, bytes: bytes.length, sha256: sha256(bytes), htmlTitle: text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null,
      geometryComparison: "unmeasured: this option inventories saved material only; a geometry release requires --geometry and its independently reviewed --geometry-sha256" };
  }) : [];
  console.log(JSON.stringify({ ...result, ntpcCsvSha256: ntpcBytes ? sha256(ntpcBytes) : null, comparison, candidateMaterial }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(new URL(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : "coverage-failed"); process.exitCode = 1; }
}
