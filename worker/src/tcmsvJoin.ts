/**
 * Strict SHP pkid ↔ TCMSV psId join for one road letter.
 *
 * psId is not unique across roads. 伊通街B and 伊通街C are different roads even when
 * the numeric id matches. A cross-letter hit is recorded and not applied.
 *
 * FORGE-027: same-time ID joins agree with TDX on 16,895/16,895 cells.
 * Official map.js getWKTColor confirms occupied/free/設備調整中 labels.
 * See docs/TCMSV-status-codes.md for counts and publisher references.
 */

export const STATUS_FRESH_MS = 20 * 60 * 1000;

export type CellJoin = "matched" | "unmatched" | "ambiguous";

export interface ShpSpaceRef {
  id: string;
  road: string;
  pkid: string;
}

export interface TcmsvCell {
  roadSegId: string;
  roadName: string;
  psId: string;
  cellStatus: string;
  /** Taipei-local `YYYY-MM-DD HH:mm:ss` or an ISO timestamp. */
  collectedAt: string;
}

export interface JoinRow {
  id: string;
  road: string;
  pkid: string;
  join: CellJoin;
  crossLetter: boolean;
  roadSegId: string | null;
  psId: string | null;
  rawCellStatus: string | null;
  /** Original XML data_Dt; never replaced by capture, build or load time. */
  data_Dt?: string | null;
  collectedAt: string | null;
  status: CellStatus;
}

export interface JoinSummary {
  rows: JoinRow[];
  matched: number;
  unmatched: number;
  ambiguous: number;
  crossLetter: number;
}

export type CellStatus = "occupied" | "free" | "unavailable" | "unknown";

/** Occupancy is known only for 1/2. Preserve other raw codes and any service label separately. */
export function mapCellStatus(raw: string | null | undefined): CellStatus {
  switch (raw?.trim()) {
    case "1": return "occupied";
    case "2": return "free";
    default: return "unknown";
  }
}

const SECTION_NUMERALS: Readonly<Record<string, string>> = {
  一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
};

/** Matching only: never use the result as a road label, geometry ID or provider alias. */
export function normalizeRoadName(name: string, roadSegId?: string): string {
  let road = name.trim();
  // Only source records can validate this metadata. Geometry has no roadSegID.
  const prefix = /^([A-Za-z0-9]+)\([0-9]+\)\s+/.exec(road);
  if (prefix && prefix[1] === roadSegId) road = road.slice(prefix[0].length);
  // The observed section spellings are 一–十. Match the whole numeral run so
  // unsupported compound numerals cannot be partially rewritten (十一 -> 十1).
  return road.replace(/[〇零一二三四五六七八九十百千萬]+(?=段)/g, n => SECTION_NUMERALS[n] ?? n);
}

export function roadParts(name: string, roadSegId?: string): { family: string; letter: string } {
  const trimmed = normalizeRoadName(name, roadSegId);
  const match = trimmed.match(/^(.*?)([A-Z])$/);
  if (!match || !match[1]) return { family: trimmed, letter: "" };
  return { family: match[1], letter: match[2] };
}

/** "08" and "8" are the same numeric id. A non-numeric id is compared as text. */
export function canonicalSpaceId(id: string): string {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return String(Number(trimmed));
  return trimmed;
}

export function taipeiLocalToIso(text: string): string | null {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface IndexedCell {
  cell: TcmsvCell;
  ambiguous: boolean;
}

function joinKey(parts: ReturnType<typeof roadParts>, id: string): string {
  return `${parts.family}\u0000${parts.letter}\u0000${id}`;
}

function providerAlias(cell: TcmsvCell): string {
  return JSON.stringify([cell.roadSegId, cell.psId]);
}

export function joinSpaces(spaces: readonly ShpSpaceRef[], cells: readonly TcmsvCell[]): JoinSummary {
  // Count the complete inputs before assigning any row: neither input order nor
  // page boundaries may select a winner when several geometries share a key.
  const geometryKeys = new Map<string, number>();
  for (const space of spaces) {
    const key = joinKey(roadParts(space.road), canonicalSpaceId(space.pkid));
    geometryKeys.set(key, (geometryKeys.get(key) ?? 0) + 1);
  }
  const byKey = new Map<string, IndexedCell>();
  const byFamilyId = new Map<string, Set<string>>();
  const aliases = new Map<string, number>();
  for (const cell of cells) {
    const parts = roadParts(cell.roadName, cell.roadSegId);
    const id = canonicalSpaceId(cell.psId);
    const key = joinKey(parts, id);
    const alias = providerAlias(cell);
    aliases.set(alias, (aliases.get(alias) ?? 0) + 1);
    const familyKey = `${parts.family}\u0000${id}`;
    const letters = byFamilyId.get(familyKey) ?? new Set<string>();
    letters.add(parts.letter);
    byFamilyId.set(familyKey, letters);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { cell, ambiguous: false });
    else prev.ambiguous = true;
  }
  const rows: JoinRow[] = [];
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let crossLetter = 0;
  for (const space of spaces) {
    const parts = roadParts(space.road);
    const id = canonicalSpaceId(space.pkid);
    const key = joinKey(parts, id);
    const indexed = byKey.get(key);
    const letters = byFamilyId.get(`${parts.family}\u0000${id}`);
    const cross = !!letters && [...letters].some((letter) => letter !== parts.letter);
    let join: CellJoin = "unmatched";
    let cell: TcmsvCell | null = null;
    // A match requires one geometry, one source key and one raw provider alias.
    // Repeated aliases can occur under different source road labels/keys too.
    if (indexed && (indexed.ambiguous || geometryKeys.get(key)! > 1 || aliases.get(providerAlias(indexed.cell))! > 1)) {
      join = "ambiguous";
    } else if (indexed) {
      join = "matched";
      cell = indexed.cell;
    }
    if (join === "matched") matched += 1;
    else if (join === "ambiguous") ambiguous += 1;
    else unmatched += 1;
    if (cross && join !== "matched") crossLetter += 1;
    const collectedAt = cell ? taipeiLocalToIso(cell.collectedAt) : null;
    rows.push({
      id: space.id,
      road: space.road,
      pkid: space.pkid,
      join,
      crossLetter: cross && join !== "matched",
      roadSegId: cell?.roadSegId ?? null,
      psId: cell?.psId ?? null,
      rawCellStatus: cell?.cellStatus ?? null,
      data_Dt: cell?.collectedAt ?? null,
      collectedAt,
      status: join === "matched" ? mapCellStatus(cell?.cellStatus) : "unknown",
    });
  }
  return { rows, matched, unmatched, ambiguous, crossLetter };
}

export interface StatusPartition {
  v: 1;
  mapping: "tcmsv-v1";
  mappingNote: string;
  entries: JoinRow[];
}

export const MAPPING_NOTE =
  "FORGE-027: TCMSV 1=occupied, 2=free, 3=equipment adjustment; verified against same-ID/time TDX and official map labels. TDX takes precedence.";

export function parseStatusPartition(json: unknown, expectedIds?: readonly string[]): { entries: JoinRow[] } | { error: string } {
  if (!json || typeof json !== "object") return { error: "bad-status" };
  const header = json as { v?: unknown; mapping?: unknown };
  // Headerless and pre-mapping "unknown" partitions remain readable.
  if ((header.v !== undefined && header.v !== 1) ||
      (header.mapping !== undefined && header.mapping !== "tcmsv-v1" && header.mapping !== "unknown")) return { error: "status-version-mismatch" };
  const entries = (json as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return { error: "bad-status" };
  if (entries.length > 80) return { error: "status-too-dense" };
  const out: JoinRow[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") return { error: "bad-status" };
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const join = row.join;
    if (!id || (join !== "matched" && join !== "unmatched" && join !== "ambiguous")) return { error: "bad-status" };
    if (seen.has(id)) return { error: "duplicate-id" };
    seen.add(id);
    const collectedAt = typeof row.collectedAt === "string" ? taipeiLocalToIso(row.collectedAt) ?? (Date.parse(row.collectedAt) ? new Date(row.collectedAt).toISOString() : null) : null;
    out.push({
      id,
      road: typeof row.road === "string" ? row.road : "",
      pkid: typeof row.pkid === "string" ? row.pkid : "",
      join,
      crossLetter: row.crossLetter === true,
      roadSegId: typeof row.roadSegId === "string" ? row.roadSegId : null,
      psId: typeof row.psId === "string" ? row.psId : null,
      rawCellStatus: typeof row.rawCellStatus === "string" ? row.rawCellStatus : null,
      data_Dt: typeof row.data_Dt === "string" ? row.data_Dt : null,
      collectedAt,
      status: join === "matched" ? mapCellStatus(typeof row.rawCellStatus === "string" ? row.rawCellStatus : null) : "unknown",
    });
  }
  if (expectedIds && (new Set(expectedIds).size !== expectedIds.length ||
      expectedIds.length !== out.length || expectedIds.some(id => !seen.has(id)))) return { error: "status-ids-mismatch" };
  return { entries: out };
}

/** Unknown/unmatched readings never acquire an update clock. Old known readings retain their age. */
export function statusReading(
  entry: JoinRow,
  nowMs: number,
): { status: CellStatus; statusAt: string | null; stale: boolean } {
  const status = mapCellStatus(entry.rawCellStatus);
  if (status === "unknown" || entry.join !== "matched" || !entry.collectedAt) return { status: "unknown", statusAt: null, stale: false };
  const at = Date.parse(entry.collectedAt);
  if (!Number.isFinite(at) || at > nowMs + 60_000) return { status: "unknown", statusAt: null, stale: false };
  return { status, statusAt: new Date(at).toISOString(), stale: nowMs - at > STATUS_FRESH_MS };
}
