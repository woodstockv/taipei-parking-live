// @ts-ignore -- the offline Node strip-types builder requires the explicit .ts extension.
import { normalizePktype } from "./spaceType.ts";

/**
 * Taipei curb-space tiles (FORGE-022).
 *
 * The legal geometry source is the OGDL shapefile (EPSG:3826; pktype retains the source space type).
 * It has no bbox API. This module converts a *bounded* extract to WGS84 grid tiles
 * that a viewport can fetch a few of. It does not download the city file, and nothing
 * here is scheduled.
 *
 * Projection checked against proj4 EPSG:3826 (GRS80, lon0 121, k0 0.9999, false easting
 * 250000) on 2026-11-06. Differences were < 1e-8 degrees on the fixtures in the test.
 */

export const TILE_DEG = 0.08;
/** One offline invocation refuses more than this many input records. */
export const TILE_BUILD_MAX = 2_000;
/** Geometry page cap; dense cells are split offline. */
export const TILE_SPOT_CAP = 80;

const A = 6_378_137;
const F = 1 / 298.257222101;
const K0 = 0.9999;
const LON0 = (121 * Math.PI) / 180;
const FALSE_EASTING = 250_000;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

/** Inverse Transverse Mercator: EPSG:3826 metres -> WGS84. */
export function project3826ToWgs84(x: number, y: number): { lat: number; lng: number } {
  const dx = x - FALSE_EASTING;
  const mu = y / K0 / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 * E1) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = EP2 * cos * cos;
  const n1 = A / Math.sqrt(1 - E2 * sin * sin);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5;
  const d = dx / (n1 * K0);
  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d * d / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lng =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
      cos;
  return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
}

/**
 * Shoelace centroid of a ring of EPSG:3826 [x, y] vertices. Null when the ring is degenerate.
 * Vertices are shifted to the first point first: a curb space is only a few metres wide, and
 * the raw cross product of TWD97 coordinates (~3e5, ~2.7e6) cancels in float64 and lands
 * outside the ring. A closed ring (first point repeated) is not walked twice.
 */
export function ringCentroid(ring: readonly (readonly [number, number])[]): { x: number; y: number } | null {
  if (ring.length < 3) return null;
  const originX = ring[0][0];
  const originY = ring[0][1];
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) return null;
  const closed =
    ring.length > 3 && ring[ring.length - 1][0] === originX && ring[ring.length - 1][1] === originY;
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return null;
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const x0 = ring[i][0] - originX;
    const y0 = ring[i][1] - originY;
    const next = ring[(i + 1) % n];
    const x1 = next[0] - originX;
    const y1 = next[1] - originY;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
    const cross = x0 * y1 - x1 * y0;
    twice += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(twice) < 1e-6) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: originX + cx / (3 * twice), y: originY + cy / (3 * twice) };
}

export function cellOrigin(n: number, deg = TILE_DEG): number {
  const q = Math.floor((n + 1e-9) / deg);
  return Math.round(q * deg * 100) / 100;
}

/** Tile key "lat:lng" of the cell origin that contains the point. */
export function tileKey(lat: number, lng: number, deg = TILE_DEG): string {
  return `${cellOrigin(lat, deg).toFixed(2)}:${cellOrigin(lng, deg).toFixed(2)}`;
}

/** Tile keys overlapping a bbox. Empty when the span would need more than `maxTiles` cells. */
export function tilesOverlapping(
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  maxTiles: number,
  deg = TILE_DEG,
): string[] {
  const keys: string[] = [];
  for (let lat = cellOrigin(bbox.minLat, deg); lat < bbox.maxLat - 1e-12; lat = Math.round((lat + deg) * 100) / 100) {
    for (let lng = cellOrigin(bbox.minLng, deg); lng < bbox.maxLng - 1e-12; lng = Math.round((lng + deg) * 100) / 100) {
      keys.push(`${lat.toFixed(2)}:${lng.toFixed(2)}`);
      if (keys.length > maxTiles) return [];
    }
  }
  return keys;
}

export interface TileSpot {
  id: string;
  lat: number;
  lng: number;
  pktype: string;
}

export interface TileFile {
  v: 1;
  /** Zero-based page. Omitted on a single-page tile. */
  page?: number;
  /** Page count for this cell. Omitted means one page. */
  pages?: number;
  spots: TileSpot[];
}

const ID_OK = /^tpe:[^\s:]{1,40}:[A-Za-z0-9_-]{1,32}$/;

export function tileSpotId(pkroad: string, pkid: string): string | null {
  const road = pkroad.trim();
  const id = pkid.trim();
  const full = `tpe:${road}:${id}`;
  return ID_OK.test(full) ? full : null;
}

/** Page 0 keeps the historical `{lat}_{lng}.json` name. Later pages are `{lat}_{lng}.pN.json`. */
export function tileObjectName(key: string, page = 0): string {
  const stem = key.replace(":", "_");
  return page === 0 ? `${stem}.json` : `${stem}.p${page}.json`;
}

/** A bounded per-cell index; page numbers are the array offsets. */
export const TILE_INDEX_PAGE_CAP = 512;
export type TileBounds = [number, number, number, number]; // west, south, east, north
export interface TileIndex {
  v: 1;
  cell: string;
  pages: TileBounds[];
}

export function tileIndexObjectName(key: string): string {
  return `${key.replace(":", "_")}.index.json`;
}

export function parseTileIndex(json: unknown, key: string): TileIndex | { error: string } {
  if (!json || typeof json !== "object") return { error: "bad-tile-index" };
  const body = json as Partial<TileIndex>;
  if (body.v !== 1 || body.cell !== key || !Array.isArray(body.pages) ||
      body.pages.length < 1 || body.pages.length > TILE_INDEX_PAGE_CAP) return { error: "bad-tile-index" };
  const [lat, lng] = key.split(":").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "bad-tile-index" };
  for (const b of body.pages) {
    if (!Array.isArray(b) || b.length !== 4 || !b.every(n => typeof n === "number" && Number.isFinite(n)) ||
        b[0] > b[2] || b[1] > b[3] || b[0] < lng - 1e-7 || b[1] < lat - 1e-7 ||
        b[2] > lng + TILE_DEG + 1e-7 || b[3] > lat + TILE_DEG + 1e-7) return { error: "bad-tile-index" };
  }
  return body as TileIndex;
}

export function intersectingTilePages(index: TileIndex, bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }): number[] {
  return index.pages.flatMap((b, page) =>
    b[0] <= bbox.maxLng && b[2] >= bbox.minLng && b[1] <= bbox.maxLat && b[3] >= bbox.minLat ? [page] : []);
}

function spotBounds(spots: TileSpot[]): TileBounds {
  return [Math.min(...spots.map(s => s.lng)), Math.min(...spots.map(s => s.lat)),
    Math.max(...spots.map(s => s.lng)), Math.max(...spots.map(s => s.lat))];
}

/** Split along the widest axis, keeping full 80-space leaves except the final leaf. */
function spatialPages(spots: TileSpot[]): TileSpot[][] {
  if (spots.length <= TILE_SPOT_CAP) {
    return [spots.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)];
  }
  const b = spotBounds(spots);
  const axis = b[2] - b[0] > b[3] - b[1] ? "lng" : "lat";
  spots.sort((a, b) => a[axis] - b[axis] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const middle = Math.floor(Math.ceil(spots.length / TILE_SPOT_CAP) / 2) * TILE_SPOT_CAP;
  return [...spatialPages(spots.slice(0, middle)), ...spatialPages(spots.slice(middle))];
}

export function parseTile(
  json: unknown,
  maxSpots = TILE_SPOT_CAP,
): { spots: TileSpot[]; page: number; pages: number } | { error: string } {
  if (!json || typeof json !== "object") return { error: "bad-tile" };
  const body = json as { spots?: unknown; page?: unknown; pages?: unknown };
  const spots = body.spots;
  if (!Array.isArray(spots)) return { error: "bad-tile" };
  if (spots.length > maxSpots) return { error: "tile-too-dense" };
  const page = body.page === undefined ? 0 : body.page;
  const pages = body.pages === undefined ? 1 : body.pages;
  if (!Number.isInteger(page) || !Number.isInteger(pages) || (page as number) < 0 || (pages as number) < 1 || (page as number) >= (pages as number)) {
    return { error: "bad-tile" };
  }
  const out: TileSpot[] = [];
  const seen = new Set<string>();
  for (const raw of spots) {
    if (!raw || typeof raw !== "object") return { error: "bad-tile" };
    const row = raw as Record<string, unknown>;
    // Historical tiles omitted the field and represented regular car spaces.
    const pktype = row.pktype === undefined ? "01" : normalizePktype(row.pktype);
    if (!pktype) return { error: "bad-tile" };
    const id = typeof row.id === "string" ? row.id : "";
    const lat = typeof row.lat === "number" ? row.lat : Number.NaN;
    const lng = typeof row.lng === "number" ? row.lng : Number.NaN;
    if (!ID_OK.test(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "bad-tile" };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return { error: "bad-tile" };
    if (seen.has(id)) return { error: "duplicate-id" };
    seen.add(id);
    out.push({ id, lat, lng, pktype });
  }
  return { spots: out, page: page as number, pages: pages as number };
}

interface InputRecord {
  pktype?: unknown;
  pkid?: unknown;
  pkroad?: unknown;
  x?: unknown;
  y?: unknown;
  ring?: unknown;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Convert a bounded extract to tiles. Refuses when `records.length > max` or a cell
 * would exceed TILE_SPOT_CAP, so a full-city file cannot be partially written by accident.
 * Records without a space type are skipped; unknown codes are retained. Coordinates are EPSG:3826 metres.
 */
export function buildTiles(
  records: readonly unknown[],
  opts: { max: number; cellDeg?: number },
): { ok: true; tiles: Record<string, TileFile>; kept: number; skipped: number } | { ok: false; error: string } {
  const max = opts.max;
  if (!Number.isInteger(max) || max < 1 || max > TILE_BUILD_MAX) return { ok: false, error: "max-out-of-range" };
  if (records.length > max) return { ok: false, error: "over-max" };
  const deg = opts.cellDeg ?? TILE_DEG;
  const tiles = new Map<string, TileSpot[]>();
  let kept = 0;
  let skipped = 0;
  for (const raw of records) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "bad-record" };
    const row = raw as InputRecord;
    const pktype = normalizePktype(row.pktype);
    if (!pktype) {
      skipped += 1;
      continue;
    }
    const pkid = typeof row.pkid === "string" || typeof row.pkid === "number" ? String(row.pkid) : "";
    const pkroad = typeof row.pkroad === "string" ? row.pkroad : "";
    const id = tileSpotId(pkroad, pkid);
    if (!id) return { ok: false, error: "bad-id" };
    let x = asNumber(row.x);
    let y = asNumber(row.y);
    if (x === null || y === null) {
      if (!Array.isArray(row.ring)) return { ok: false, error: "bad-geometry" };
      const ring: [number, number][] = [];
      for (const point of row.ring) {
        if (!Array.isArray(point) || point.length < 2) return { ok: false, error: "bad-geometry" };
        const px = asNumber(point[0]);
        const py = asNumber(point[1]);
        if (px === null || py === null) return { ok: false, error: "bad-geometry" };
        ring.push([px, py]);
      }
      const centre = ringCentroid(ring);
      if (!centre) return { ok: false, error: "bad-geometry" };
      x = centre.x;
      y = centre.y;
    }
    const wgs = project3826ToWgs84(x, y);
    if (!(wgs.lat >= 21 && wgs.lat <= 26 && wgs.lng >= 119 && wgs.lng <= 123)) return { ok: false, error: "outside-taiwan" };
    const key = tileKey(wgs.lat, wgs.lng, deg);
    const list = tiles.get(key) ?? [];
    if (list.length >= TILE_SPOT_CAP) return { ok: false, error: "tile-too-dense" };
    list.push({ id, lat: Math.round(wgs.lat * 1e7) / 1e7, lng: Math.round(wgs.lng * 1e7) / 1e7, pktype });
    tiles.set(key, list);
    kept += 1;
  }
  const out: Record<string, TileFile> = {};
  for (const [key, spots] of tiles) out[key] = { v: 1, spots };
  return { ok: true, tiles: out, kept, skipped };
}

export interface TileAccumulator {
  spots: Map<string, TileSpot & { cell: string }>;
  /** Records without a usable pktype. */
  skipped: number;
  seen: number;
}

export interface EmittedTilePage {
  key: string;
  page: number;
  pages: number;
  file: string;
  tile: TileFile;
}

export function createTileAccumulator(): TileAccumulator {
  return { spots: new Map(), skipped: 0, seen: 0 };
}

/**
 * One bounded chunk of a larger extract. `max` is still at most TILE_BUILD_MAX, and a
 * chunk over that max is refused. Typed rows are kept in `state` instead of being dropped
 * when a cell passes 80: `emitTilePages` splits the cell into pages of TILE_SPOT_CAP.
 * The same stable id twice is an error, not a silent skip.
 */
export function ingestTileChunk(
  state: TileAccumulator,
  records: readonly unknown[],
  opts: { max: number; cellDeg?: number },
): { ok: true } | { ok: false; error: string } {
  const max = opts.max;
  if (!Number.isInteger(max) || max < 1 || max > TILE_BUILD_MAX) return { ok: false, error: "max-out-of-range" };
  if (records.length > max) return { ok: false, error: "over-max" };
  const deg = opts.cellDeg ?? TILE_DEG;
  for (const raw of records) {
    state.seen += 1;
    if (!raw || typeof raw !== "object") return { ok: false, error: "bad-record" };
    const row = raw as InputRecord;
    const pktype = normalizePktype(row.pktype);
    if (!pktype) {
      state.skipped += 1;
      continue;
    }
    const pkid = typeof row.pkid === "string" || typeof row.pkid === "number" ? String(row.pkid) : "";
    const pkroad = typeof row.pkroad === "string" ? row.pkroad : "";
    const id = tileSpotId(pkroad, pkid);
    if (!id) return { ok: false, error: "bad-id" };
    if (state.spots.has(id)) return { ok: false, error: "duplicate-id" };
    let x = asNumber(row.x);
    let y = asNumber(row.y);
    if (x === null || y === null) {
      if (!Array.isArray(row.ring)) return { ok: false, error: "bad-geometry" };
      const ring: [number, number][] = [];
      for (const point of row.ring) {
        if (!Array.isArray(point) || point.length < 2) return { ok: false, error: "bad-geometry" };
        const px = asNumber(point[0]);
        const py = asNumber(point[1]);
        if (px === null || py === null) return { ok: false, error: "bad-geometry" };
        ring.push([px, py]);
      }
      const centre = ringCentroid(ring);
      if (!centre) return { ok: false, error: "bad-geometry" };
      x = centre.x;
      y = centre.y;
    }
    const wgs = project3826ToWgs84(x, y);
    if (!(wgs.lat >= 21 && wgs.lat <= 26 && wgs.lng >= 119 && wgs.lng <= 123)) return { ok: false, error: "outside-taiwan" };
    const cell = tileKey(wgs.lat, wgs.lng, deg);
    state.spots.set(id, {
      id,
      lat: Math.round(wgs.lat * 1e7) / 1e7,
      lng: Math.round(wgs.lng * 1e7) / 1e7,
      pktype,
      cell,
    });
  }
  return { ok: true };
}

/** Spatial pages and bbox indexes are deterministic across input/chunk order. */
export function emitTilePages(state: TileAccumulator): { pages: EmittedTilePage[]; indexes: { file: string; index: TileIndex }[]; kept: number; skipped: number } {
  const byCell = new Map<string, TileSpot[]>();
  for (const spot of state.spots.values()) {
    const list = byCell.get(spot.cell) ?? [];
    list.push({ id: spot.id, lat: spot.lat, lng: spot.lng, pktype: spot.pktype });
    byCell.set(spot.cell, list);
  }
  const pages: EmittedTilePage[] = [];
  const indexes: { file: string; index: TileIndex }[] = [];
  for (const key of [...byCell.keys()].sort()) {
    const spots = byCell.get(key) ?? [];
    const slices = spatialPages(spots);
    const pageCount = slices.length;
    if (pageCount > TILE_INDEX_PAGE_CAP) throw new Error(`tile-index-too-dense: ${key}`);
    indexes.push({ file: tileIndexObjectName(key), index: { v: 1, cell: key, pages: slices.map(spotBounds) } });
    for (let page = 0; page < pageCount; page += 1) {
      const slice = slices[page];
      if (slice.length > TILE_SPOT_CAP) return { pages: [], indexes: [], kept: 0, skipped: state.skipped };
      pages.push({
        key,
        page,
        pages: pageCount,
        file: tileObjectName(key, page),
        tile: { v: 1, page, pages: pageCount, spots: slice },
      });
    }
  }
  const listed = pages.reduce((sum, page) => sum + page.tile.spots.length, 0);
  if (listed !== state.spots.size) return { pages: [], indexes: [], kept: 0, skipped: state.skipped };
  return { pages, indexes, kept: state.spots.size, skipped: state.skipped };
}
