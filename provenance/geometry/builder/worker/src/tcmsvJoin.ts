/**
 * Strict SHP pkid ↔ TCMSV psId join for one road letter.
 *
 * psId is not unique across roads. 伊通街B and 伊通街C are different roads even when
 * the numeric id matches. A cross-letter hit is recorded and not applied.
 *
 * cellStatus has no official dictionary on data.gov.tw dataset 128617 (the published
 * fields are the road-level ones). Observed codes 0, 1, 2 and 3 stay `unknown`.
 * TDX SpotStatus 1/2 is a different feed and is not reused here.
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
  collectedAt: string | null;
  status: "unknown";
}

export interface JoinSummary {
  rows: JoinRow[];
  matched: number;
  unmatched: number;
  ambiguous: number;
  crossLetter: number;
}

/** Always unknown until an official cellStatus dictionary is published. */
export function mapCellStatus(_raw: string | null | undefined): "unknown" {
  return "unknown";
}

export function roadParts(name: string): { family: string; letter: string } {
  const trimmed = name.trim();
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

export function joinSpaces(spaces: readonly ShpSpaceRef[], cells: readonly TcmsvCell[]): JoinSummary {
  const byKey = new Map<string, IndexedCell>();
  const byFamilyId = new Map<string, Set<string>>();
  for (const cell of cells) {
    const parts = roadParts(cell.roadName);
    const id = canonicalSpaceId(cell.psId);
    const key = `${parts.family}\u0000${parts.letter}\u0000${id}`;
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
    const key = `${parts.family}\u0000${parts.letter}\u0000${id}`;
    const indexed = byKey.get(key);
    const letters = byFamilyId.get(`${parts.family}\u0000${id}`);
    const cross = !!letters && [...letters].some((letter) => letter !== parts.letter);
    let join: CellJoin = "unmatched";
    let cell: TcmsvCell | null = null;
    if (indexed?.ambiguous) join = "ambiguous";
    else if (indexed) {
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
      collectedAt,
      status: "unknown",
    });
  }
  return { rows, matched, unmatched, ambiguous, crossLetter };
}

export interface StatusPartition {
  v: 1;
  mapping: "unknown";
  mappingNote: string;
  entries: JoinRow[];
}

export const MAPPING_NOTE =
  "data.gov.tw dataset 128617 does not define cellStatus. Observed codes are stored raw and shown as unknown. TDX SpotStatus is not applied to this feed.";

export function parseStatusPartition(json: unknown): { entries: JoinRow[] } | { error: string } {
  if (!json || typeof json !== "object") return { error: "bad-status" };
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
      collectedAt,
      status: "unknown",
    });
  }
  return { entries: out };
}

/**
 * There is no official cellStatus map, so a reading is unknown and carries no time.
 * A fresh collect time is not status_at and is not a user-visible update.
 */
export function statusReading(
  entry: JoinRow,
  nowMs: number,
): { status: "unknown"; statusAt: null; stale: boolean } {
  mapCellStatus(entry.rawCellStatus);
  if (entry.join !== "matched" || !entry.collectedAt) return { status: "unknown", statusAt: null, stale: false };
  const at = Date.parse(entry.collectedAt);
  if (!Number.isFinite(at) || at > nowMs + 60_000) return { status: "unknown", statusAt: null, stale: false };
  return { status: "unknown", statusAt: null, stale: nowMs - at > STATUS_FRESH_MS };
}
