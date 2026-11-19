/**
 * Offline Taipei car-space tiles (FORGE-023).
 *
 * Reads a local OGDL shapefile (EPSG:3826) and optional TCMSV XML. Writes WGS84
 * JSON pages of at most 80 spaces, plus a status file per page. Does not open D1,
 * does not call the network, and is not scheduled.
 *
 *   node --experimental-strip-types tools/build-taipei-space-tiles.ts \
 *     --shp park.shp --dbf park.dbf --out ./space-tiles --chunk 2000
 *
 *   --road 伊通街     keep pkroad values that contain this text
 *   --status-xml f   write status pages from a local TCMSV_roadquery.xml
 *   --count-only     print counts and write nothing
 *
 * Publish the files, then set TAIPEI_SPACE_TILE_BASE and TAIPEI_SPACE_STATUS_BASE.
 * See docs/FORGE-023.md. Do not load the city into D1.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbfValue, outerRing, readDbfLayout, type DbfLayout } from "../worker/src/shp.ts";
import { createTileAccumulator, emitTilePages, ingestTileChunk, project3826ToWgs84, ringCentroid, tileSpotId, TILE_BUILD_MAX, type TileAccumulator } from "../worker/src/spaceTiles.ts";
import { joinSpaces, MAPPING_NOTE, type ShpSpaceRef, type TcmsvCell } from "../worker/src/tcmsvJoin.ts";
import { parseTcmsvCells } from "../worker/src/tcmsvXml.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function readExact(fd: number, position: number, length: number): Uint8Array {
  const buf = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = readSync(fd, buf, offset, length - offset, position + offset);
    if (n <= 0) throw new Error(`short read at ${position}`);
    offset += n;
  }
  return buf;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileSha(path: string): string {
  return sha256(readFileSync(path));
}

interface SourceRow {
  pktype: string;
  pkid: string;
  pkroad: string;
  x: number;
  y: number;
}

function streamRows(shpPath: string, dbfPath: string, onRow: (row: SourceRow, index: number) => void): { records: number; deleted: number } {
  const dbfFd = openSync(dbfPath, "r");
  const shpFd = openSync(shpPath, "r");
  try {
    const head = readExact(dbfFd, 0, 32);
    const headerLength = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(8, true);
    const layoutBuf = readExact(dbfFd, 0, headerLength);
    const layout = readDbfLayout(layoutBuf);
    if ("error" in layout) throw new Error(layout.error);
    let records = 0;
    let deleted = 0;
    let shpAt = 100;
    for (let index = 0; index < layout.count; index += 1) {
      const record = readExact(dbfFd, layout.headerLength + index * layout.recordLength, layout.recordLength);
      const recHead = readExact(shpFd, shpAt, 8);
      const contentLength = new DataView(recHead.buffer, recHead.byteOffset, recHead.byteLength).getInt32(4, false);
      shpAt += 8;
      const content = readExact(shpFd, shpAt, contentLength * 2);
      shpAt += contentLength * 2;
      records += 1;
      // Validate geometry before any record-level skip or duplicate removal.
      // Chunking must only batch ingestion, never decide which errors are seen.
      const ring = outerRing(content);
      const centre = ring && ringCentroid(ring);
      if (!centre || !Number.isFinite(centre.x) || !Number.isFinite(centre.y)) {
        throw new Error(`bad-geometry at record ${index}`);
      }
      const wgs = project3826ToWgs84(centre.x, centre.y);
      if (!(wgs.lat >= 21 && wgs.lat <= 26 && wgs.lng >= 119 && wgs.lng <= 123)) {
        throw new Error(`outside-taiwan at record ${index}`);
      }
      if (record[0] === 0x2a) {
        deleted += 1;
        continue;
      }
      onRow(
        {
          pktype: dbfValue(record, layout as DbfLayout, "pktype"),
          pkid: dbfValue(record, layout as DbfLayout, "pkid"),
          pkroad: dbfValue(record, layout as DbfLayout, "pkroad"),
          x: centre.x,
          y: centre.y,
        },
        index,
      );
    }
    return { records, deleted };
  } finally {
    closeSync(dbfFd);
    closeSync(shpFd);
  }
}

const shpPath = arg("--shp");
const dbfPath = arg("--dbf");
const outDir = arg("--out");
const road = arg("--road") ?? "";
const statusXml = arg("--status-xml");
const chunk = Number(arg("--chunk") ?? "2000");
const countOnly = has("--count-only");

if (!shpPath || !dbfPath || (!countOnly && !outDir) || !Number.isInteger(chunk) || chunk < 1 || chunk > TILE_BUILD_MAX) {
  console.error("usage: --shp <file> --dbf <file> --out <dir> [--chunk 2000] [--road 伊通街] [--status-xml <file>] [--count-only]");
  process.exit(2);
}

const state: TileAccumulator = createTileAccumulator();
let pending: SourceRow[] = [];
let cars = 0;
let filtered = 0;
let nonCar = 0;
const skippedByReason = { missingRoadName: 0, missingSpaceNumber: 0, missingBoth: 0, other: 0, duplicateId: 0 };
const seenIds = new Set<string>();
const ambiguousIds = new Set<string>();

function flush(force = false): void {
  if (pending.length === 0) return;
  if (!force && pending.length < chunk) return;
  const ingested = ingestTileChunk(state, pending, { max: chunk });
  if (!ingested.ok) {
    console.error(ingested.error);
    process.exit(1);
  }
  pending = [];
}

const scanned = streamRows(shpPath, dbfPath, (row) => {
  if (row.pktype !== "01") {
    nonCar += 1;
    return;
  }
  cars += 1;
  if (road && !row.pkroad.includes(road)) {
    filtered += 1;
    return;
  }
  // Use the same validator as ingestion; never invent or repair an id.
  const id = tileSpotId(row.pkroad, row.pkid);
  if (!id) {
    const missingRoad = !row.pkroad.trim();
    const missingNumber = !row.pkid.trim();
    const reason = missingRoad && missingNumber ? "missingBoth"
      : missingRoad ? "missingRoadName"
      : missingNumber ? "missingSpaceNumber" : "other";
    skippedByReason[reason] += 1;
    return;
  }
  // A repeated id cannot identify one geometry reliably. Omit every copy,
  // including the first, whether it is still pending or was already ingested.
  if (seenIds.has(id)) {
    skippedByReason.duplicateId += 1;
    if (!ambiguousIds.has(id)) {
      ambiguousIds.add(id);
      skippedByReason.duplicateId += 1;
      state.spots.delete(id);
      pending = pending.filter((candidate) => tileSpotId(candidate.pkroad, candidate.pkid) !== id);
    }
    return;
  }
  seenIds.add(id);
  pending.push(row);
  if (pending.length === chunk) flush(true);
});
flush(true);

const emitted = emitTilePages(state);
if (emitted.kept !== state.spots.size) {
  console.error("emit-dropped");
  process.exit(1);
}

const summary = {
  records: scanned.records,
  deleted: scanned.deleted,
  nonCar,
  cars,
  filtered,
  kept: emitted.kept,
  pages: emitted.pages.length,
  skipped: emitted.skipped + Object.values(skippedByReason).reduce((sum, n) => sum + n, 0),
  skippedByReason,
};
console.log(JSON.stringify(summary));
if (countOnly) process.exit(0);
if (!outDir) process.exit(1);

mkdirSync(outDir, { recursive: true });
const statusDir = resolve(outDir, "status");
mkdirSync(statusDir, { recursive: true });

let cells: TcmsvCell[] = [];
if (statusXml) {
  const parsed = parseTcmsvCells(readFileSync(statusXml, "utf8"));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }
  cells = parsed.cells;
}

const spaces: ShpSpaceRef[] = [];
for (const spot of state.spots.values()) {
  const parts = spot.id.split(":");
  spaces.push({ id: spot.id, road: parts[1] ?? "", pkid: parts.slice(2).join(":") });
}
const joined = cells.length > 0 ? joinSpaces(spaces, cells) : null;
const joinById = new Map(joined?.rows.map((row) => [row.id, row]) ?? []);

const files: { file: string; sha256: string; spots: number }[] = [];
for (const page of emitted.pages) {
  const body = JSON.stringify(page.tile);
  const path = resolve(outDir, page.file);
  writeFileSync(path, body);
  files.push({ file: page.file, sha256: sha256(Buffer.from(body)), spots: page.tile.spots.length });
  if (!joined) continue;
  const entries = page.tile.spots.map((spot) => joinById.get(spot.id)).filter((row) => row !== undefined);
  const statusBody = JSON.stringify({ v: 1, mapping: "unknown", mappingNote: MAPPING_NOTE, entries });
  writeFileSync(resolve(statusDir, page.file), statusBody);
}

const indexes = emitted.indexes.map(({ file, index }) => {
  const body = JSON.stringify(index);
  if (Buffer.byteLength(body) > 48_000) throw new Error(`tile-index-too-large: ${file}`);
  writeFileSync(resolve(outDir, file), body);
  return { file, sha256: sha256(Buffer.from(body)), pages: index.pages.length };
});

const provenance = {
  tileLayout: "spatial-v1",
  indexes,
  license: "OGDL-Taiwan-1.0",
  crs: "EPSG:3826 to EPSG:4326",
  shp: { path: shpPath, bytes: statSync(shpPath).size, sha256: fileSha(shpPath) },
  dbf: { path: dbfPath, bytes: statSync(dbfPath).size, sha256: fileSha(dbfPath) },
  statusXml: statusXml ? { path: statusXml, bytes: statSync(statusXml).size, sha256: fileSha(statusXml) } : null,
  roadFilter: road || null,
  summary,
  join: joined
    ? { matched: joined.matched, unmatched: joined.unmatched, ambiguous: joined.ambiguous, crossLetter: joined.crossLetter, mapping: "unknown" }
    : null,
  files,
  d1: "not used",
};
writeFileSync(resolve(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`wrote ${files.length} pages to ${outDir}`);
