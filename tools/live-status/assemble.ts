/// <reference path="./node.d.ts" />
/** Offline, injected-input assembler. Importing this module performs no I/O. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { joinSpaces, canonicalSpaceId, roadParts, type TcmsvCell } from "../../worker/src/tcmsvJoin.ts";
import { parseTile, parseTileIndex, tileObjectName } from "../../worker/src/spaceTiles.ts";
import { LIVE_LIMITS, batchTime, isHash, isIso, shardKey, validBbox, validateManifest, validateShard, type Bbox, type JoinCounts, type LiveManifest, type LiveRow, type LiveShard } from "../../shared/liveStatus.ts";
export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export interface GeometrySpot { id: string; road: string; pkid: string; lat: number; lng: number }
export interface Geometry { sha256: string; spots: GeometrySpot[] }
interface GeometryManifest {
  tileLayout: string; files: { file: string; sha256: string; spots: number }[];
  indexes: { file: string; sha256: string; pages: number }[]; summary: { kept: number; pages: number };
}
/** All manifest, index and page bytes supplied by caller; paths never evaluated here. */
export function readGeometry(manifestBytes: Uint8Array, expectedHash: string, files: ReadonlyMap<string, Uint8Array>): Geometry {
  need(isHash(expectedHash) && manifestBytes.length <= 2_000_000 && sha256(manifestBytes) === expectedHash, "geometry-pin-mismatch");
  const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as GeometryManifest;
  need(m?.tileLayout === "spatial-v1" && Array.isArray(m.files) && m.files.length > 0 && m.files.length <= 4096 &&
    Array.isArray(m.indexes) && m.indexes.length > 0 && m.indexes.length <= 4096 && m.summary?.pages === m.files.length, "geometry-manifest");
  const listed = new Map<string, GeometryManifest["files"][number]>();
  for (const f of m.files) {
    need(f && /^\d{2}\.\d{2}_\d{3}\.\d{2}(?:\.p[1-9]\d*)?\.json$/.test(f.file) && isHash(f.sha256) &&
      Number.isInteger(f.spots) && f.spots > 0 && f.spots <= 80 && !listed.has(f.file), "geometry-file");
    listed.set(f.file, f);
  }
  const checked = (file: string, hash: string): unknown => {
    const b = files.get(file);
    need(b && b.length <= 48_000 && isHash(hash) && sha256(b) === hash, "geometry-file-hash");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  };
  const spots: GeometrySpot[] = []; const ids = new Set<string>(); const pages = new Set<string>(); const indexes = new Set<string>();
  for (const index of m.indexes) {
    need(index && /^\d{2}\.\d{2}_\d{3}\.\d{2}\.index\.json$/.test(index.file) && !indexes.has(index.file), "geometry-index");
    indexes.add(index.file);
    const key = index.file.replace(".index.json", "").replace("_", ":");
    const parsed = parseTileIndex(checked(index.file, index.sha256), key);
    need(!("error" in parsed) && parsed.pages.length === index.pages, "geometry-index-pages");
    for (let p = 0; p < parsed.pages.length; p++) {
      const name = tileObjectName(key, p); const f = listed.get(name);
      need(f && !pages.has(name), "geometry-page-set"); pages.add(name);
      const raw = checked(name, f.sha256) as { v: number; spots: unknown[] };
      const tile = parseTile(raw);
      need(raw.v === 1 && !("error" in tile) && tile.page === p && tile.pages === parsed.pages.length && tile.spots.length === f.spots && raw.spots.length === f.spots, "geometry-page");
      const bbox = bounds(tile.spots);
      need(bbox.every((n, i) => Math.abs(n - parsed.pages[p][i]) <= 1e-7), "geometry-page-bounds");
      for (const s of tile.spots) {
        const parts = s.id.split(":");
        need(parts.length === 3 && parts[0] === "tpe" && parts[1] && parts[2] && !ids.has(s.id), "geometry-id");
        ids.add(s.id); spots.push({ ...s, road: parts[1], pkid: parts[2] });
      }
    }
  }
  need(pages.size === listed.size && spots.length === m.summary.kept && spots.length <= LIVE_LIMITS.geometryRows, "geometry-coverage");
  return { sha256: expectedHash, spots: spots.sort((a, b) => compare(a.id, b.id)) };
}
interface Node { name: string; text: string; children: Node[] }
function xmlText(text: string): string {
  // No general entities, DTD, CDATA, or expansion. Only XML's predefined/numeric scalars.
  need(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);)/.test(text), "xml-entity");
  return text.replace(/&([^;]+);/g, (_, v: string) => {
    const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (v in predefined) return predefined[v];
    const code = v.startsWith("#x") ? parseInt(v.slice(2), 16) : Number(v.slice(1));
    need(code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), "xml-character");
    return String.fromCodePoint(code);
  });
}
function parseXml(bytes: Uint8Array): Node {
  need(bytes.length > 0 && bytes.length <= LIVE_LIMITS.xmlBytes, "xml-byte-cap");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document: Node = { name: "document", text: "", children: [] }; const stack = [document];
  const tokens = /<[^>]*>|[^<]+/g; let end = 0; let count = 0;
  for (const match of text.matchAll(tokens)) {
    need(match.index === end, "xml-truncated"); end += match[0].length; const t = match[0];
    if (t.startsWith("<?")) { need(match.index === 0 && /^<\?xml\s[^<>]*\?>$/.test(t), "xml-declaration"); continue; }
    if (!t.startsWith("<")) { stack.at(-1)!.text += xmlText(t); continue; }
    need(!t.startsWith("<!"), "xml-dtd-or-declaration");
    const closing = /^<\/([A-Za-z_][\w]*)\s*>$/.exec(t);
    if (closing) { need(stack.length > 1 && stack.at(-1)!.name === closing[1], "xml-unbalanced"); stack.pop(); continue; }
    const opening = /^<([A-Za-z_][\w]*)\s*(\/?)>$/.exec(t);
    need(opening && ++count <= 500_000 && stack.length < 8, "xml-element");
    const n: Node = { name: opening[1], text: "", children: [] }; stack.at(-1)!.children.push(n);
    if (!opening[2]) stack.push(n);
  }
  need(end === text.length && stack.length === 1 && !document.text.trim() && document.children.length === 1 && document.children[0].name === "DATA", "xml-root-or-truncated");
  return document.children[0];
}
function scalar(node: Node, name: string, required = false): string {
  const nodes = node.children.filter(n => n.name === name);
  need(nodes.length <= 1 && (!required || nodes.length === 1), `xml-field-${name}`);
  const n = nodes[0]; need(!n || (n.children.length === 0 && n.text.length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(n.text)), "xml-scalar");
  const value = n?.text ?? "";
  if (required) need(value.trim().length > 0, `xml-id-${name}`);
  return value;
}
export interface Capture { cells: TcmsvCell[]; batchTimes: string[]; roads: number }
export function parseCapture(bytes: Uint8Array): Capture {
  const root = parseXml(bytes); need(!root.text.trim() && root.children.length > 0 && root.children.length <= 4096, "xml-roads");
  const cells: TcmsvCell[] = []; const batches = new Set<string>(); const roadIds = new Set<string>();
  for (const road of root.children) {
    need(road.name === "ROAD" && !road.text.trim() && road.children.every(n => n.name === "cellStatusList" || n.children.length === 0), "xml-road");
    const roadSegId = scalar(road, "roadSegID", true); const roadName = scalar(road, "roadSegName", true);
    need(!roadIds.has(roadSegId), "xml-duplicate-road"); roadIds.add(roadSegId);
    batches.add(scalar(road, "roadSegUpdatetime"));
    const lists = road.children.filter(n => n.name === "cellStatusList"); need(lists.length === 1 && !lists[0].text.trim(), "xml-cell-list");
    for (const cell of lists[0].children) {
      need(cell.name === "cell" && !cell.text.trim() && cell.children.every(n => n.children.length === 0), "xml-cell");
      cells.push({ roadSegId, roadName, psId: scalar(cell, "psId", true), cellStatus: scalar(cell, "cellStatus"), collectedAt: scalar(cell, "data_Dt") });
      need(cells.length <= LIVE_LIMITS.sourceCells, "xml-cell-cap");
    }
  }
  return { cells, batchTimes: [...batches].sort(compare), roads: root.children.length };
}
function bounds(spots: readonly { lng: number; lat: number }[]): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of spots) { b[0] = Math.min(b[0], s.lng); b[1] = Math.min(b[1], s.lat); b[2] = Math.max(b[2], s.lng); b[3] = Math.max(b[3], s.lat); }
  return b;
}
function count(total: number, matched: number, ambiguous: number): JoinCounts { return { total, matched, unmatched: total - matched - ambiguous, ambiguous }; }
function cellKey(c: TcmsvCell): string { const r = roadParts(c.roadName, c.roadSegId); return JSON.stringify([r.family, r.letter, canonicalSpaceId(c.psId)]); }
export interface AssemblyInput {
  xml: Uint8Array; geometry: Geometry; capturedAt: string; checkedAt: string; publishedAt: string;
  etag: string | null; lastModified: string | null;
  /** Geometry-only split limit, fixed for the release. Never tuned to a capture. */
  partitionRows?: number;
}
export interface PackedShard { payload: LiveShard; bytes: Uint8Array; gzip: Uint8Array }
export interface Assembly { manifest: LiveManifest; manifestBytes: Uint8Array; shards: PackedShard[]; roads: number }
export function assemble(input: AssemblyInput): Assembly {
  const { geometry: g } = input;
  need(isHash(g.sha256) && g.spots.length > 0 && g.spots.length <= LIVE_LIMITS.geometryRows, "geometry-input");
  const ids = new Set<string>();
  for (const s of g.spots) {
    need(s.id === `tpe:${s.road}:${s.pkid}` && s.road && s.pkid && !ids.has(s.id) && validBbox([s.lng, s.lat, s.lng, s.lat]), "geometry-input-spot"); ids.add(s.id);
  }
  need(isIso(input.capturedAt) && isIso(input.checkedAt) && isIso(input.publishedAt), "input-clocks");
  const capture = parseCapture(input.xml);
  const aliasCounts = new Map<string, number>();
  for (const c of capture.cells) { const alias = JSON.stringify([c.roadSegId, c.psId]); aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1); }
  const joined = joinSpaces(g.spots, capture.cells);
  // The repo's exact road family/letter/local-number join chooses the provider
  // roadSegID + original psId. Require a one-to-one geometry/provider mapping too.
  const providerCounts = new Map<string, number>();
  const key = (r: { roadSegId: string | null; psId: string | null }) => JSON.stringify([r.roadSegId, r.psId]);
  for (const r of joined.rows) if (r.join === "matched") providerCounts.set(key(r), (providerCounts.get(key(r)) ?? 0) + 1);
  const rows = new Map<string, LiveRow>(); let matched = 0; let ambiguous = 0;
  const matchedCells = new Set<string>(); const ambiguousKeys = new Set<string>();
  for (const r of joined.rows) {
    const join = r.join === "matched" && (providerCounts.get(key(r)) !== 1 || aliasCounts.get(key(r)) !== 1) ? "ambiguous" : r.join;
    if (join === "matched") { matched++; matchedCells.add(key(r)); }
    if (join === "ambiguous") { ambiguous++; const p = roadParts(r.road); ambiguousKeys.add(JSON.stringify([p.family, p.letter, canonicalSpaceId(r.pkid)])); }
    rows.set(r.id, join === "matched" ? [r.id, join, r.roadSegId, r.psId, r.rawCellStatus, r.data_Dt ?? ""] : [r.id, join, null, null, null, null]);
  }
  const sourceKeyCounts = new Map<string, number>(); const aliases = new Map<string, number>();
  for (const c of capture.cells) {
    sourceKeyCounts.set(cellKey(c), (sourceKeyCounts.get(cellKey(c)) ?? 0) + 1);
    const alias = JSON.stringify([c.roadSegId, c.psId]); aliases.set(alias, (aliases.get(alias) ?? 0) + 1);
  }
  let sourceMatched = 0; let sourceAmbiguous = 0;
  for (const c of capture.cells) {
    if (sourceKeyCounts.get(cellKey(c))! > 1 || aliases.get(JSON.stringify([c.roadSegId, c.psId]))! > 1 || ambiguousKeys.has(cellKey(c))) sourceAmbiguous++;
    else if (matchedCells.has(JSON.stringify([c.roadSegId, c.psId]))) sourceMatched++;
  }
  const limit = input.partitionRows ?? 2048;
  need(Number.isInteger(limit) && limit > 0 && limit <= LIVE_LIMITS.rows, "partition-row-limit");
  const partitions: GeometrySpot[][] = [];
  function split(spots: GeometrySpot[]): void {
    if (spots.length <= limit) { partitions.push(spots); return; }
    const b = bounds(spots); const axis = (b[2] - b[0]) * Math.cos((b[1] + b[3]) * Math.PI / 360) >= b[3] - b[1] ? "lng" : "lat";
    const sorted = [...spots].sort((a, b) => a[axis] - b[axis] || compare(a.id, b.id)); const mid = Math.floor(sorted.length / 2);
    split(sorted.slice(0, mid)); split(sorted.slice(mid));
  }
  split(g.spots);
  need(partitions.length <= LIVE_LIMITS.shards, "combined-shard-cap");
  const shards: PackedShard[] = partitions.map((spots, i) => {
    const id = `s${String(i).padStart(2, "0")}`;
    const payload: LiveShard = { v: 1, kind: "live-status-shard", geometrySha256: g.sha256, id,
      rows: spots.map(s => rows.get(s.id)!).sort((a, b) => compare(a[0], b[0])) };
    validateShard(payload, g.sha256, id, spots.map(s => s.id));
    const bytes = new TextEncoder().encode(JSON.stringify(payload)); const gzip = gzipSync(bytes, { level: 9 });
    gzip.fill(0, 4, 8); gzip[9] = 255; // Fixed mtime and OS header.
    need(gzip.length <= LIVE_LIMITS.gzipBytes, "shard-gzip-cap");
    return { payload, bytes, gzip };
  });
  const refs = shards.map((s, i) => ({ id: s.payload.id, bbox: bounds(partitions[i]), sha256: sha256(s.bytes), gzipSha256: sha256(s.gzip),
    bytes: s.bytes.length, gzipBytes: s.gzip.length, rows: s.payload.rows.length, key: shardKey(g.sha256, s.payload.id, sha256(s.bytes)) }));
  const batch = capture.batchTimes.map(batchTime).filter((v): v is string => v !== null).sort(compare);
  const manifest: LiveManifest = { v: 1, kind: "live-status-manifest", geometrySha256: g.sha256,
    generation: sha256(JSON.stringify(refs.map(r => [r.id, r.sha256]))),
    source: { name: "tcmsv", sha256: sha256(input.xml), bytes: input.xml.length, etag: input.etag, lastModified: input.lastModified,
      capturedAt: input.capturedAt, batchTimes: capture.batchTimes, batchOldestAt: batch[0] ?? null, batchNewestAt: batch.at(-1) ?? null },
    checkedAt: input.checkedAt, publishedAt: input.publishedAt, geometry: count(g.spots.length, matched, ambiguous),
    cells: count(capture.cells.length, sourceMatched, sourceAmbiguous), shards: refs };
  validateManifest(manifest, g.sha256);
  return { manifest, manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)), shards, roads: capture.roads };
}
