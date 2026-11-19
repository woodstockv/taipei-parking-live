/**
 * Bounded readers for the Taipei curb shapefile (SHP polygons + DBF attributes).
 * The offline tool streams the city file. Nothing here talks to D1.
 */

export interface DbfField {
  name: string;
  length: number;
  offset: number;
}

export interface DbfLayout {
  count: number;
  headerLength: number;
  recordLength: number;
  fields: DbfField[];
}

export function readDbfLayout(buf: Uint8Array): DbfLayout | { error: string } {
  if (buf.byteLength < 32) return { error: "short-dbf" };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  if (headerLength < 33 || recordLength < 2 || buf.byteLength < headerLength) return { error: "bad-dbf" };
  const fields: DbfField[] = [];
  let offset = 1;
  let i = 32;
  while (i + 32 <= headerLength && buf[i] !== 0x0d) {
    let name = "";
    for (let c = 0; c < 11 && buf[i + c] !== 0; c += 1) name += String.fromCharCode(buf[i + c]);
    const length = buf[i + 16];
    if (!name || length < 1) return { error: "bad-dbf" };
    fields.push({ name, length, offset });
    offset += length;
    i += 32;
  }
  if (offset !== recordLength) return { error: "bad-dbf" };
  return { count, headerLength, recordLength, fields };
}

export function dbfValue(record: Uint8Array, layout: DbfLayout, name: string): string {
  const field = layout.fields.find((item) => item.name === name);
  if (!field || record.byteLength < field.offset + field.length) return "";
  return new TextDecoder("utf-8").decode(record.subarray(field.offset, field.offset + field.length)).trim();
}

/** Outer ring of a Polygon record (shape type 5). Null for invalid shapes or vertices. */
export function outerRing(content: Uint8Array): [number, number][] | null {
  if (content.byteLength < 44) return null;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const type = view.getInt32(0, true);
  if (type !== 5) return null;
  const numParts = view.getInt32(36, true);
  const numPoints = view.getInt32(40, true);
  if (numParts < 1 || numPoints < 4) return null;
  const partsBytes = numParts * 4;
  const need = 44 + partsBytes + numPoints * 16;
  if (content.byteLength < need) return null;
  for (let part = 0; part < numParts; part += 1) {
    const start = view.getInt32(44 + part * 4, true);
    const end = part + 1 < numParts ? view.getInt32(48 + part * 4, true) : numPoints;
    if ((part === 0 && start !== 0) || start < 0 || end - start < 4 || end > numPoints) return null;
  }
  const end = numParts > 1 ? view.getInt32(48, true) : numPoints;
  const ptsOff = 44 + partsBytes;
  const ring: [number, number][] = [];
  // Validate every vertex, including parts that are not used for the centroid.
  for (let k = 0; k < numPoints; k += 1) {
    const x = view.getFloat64(ptsOff + k * 16, true);
    const y = view.getFloat64(ptsOff + k * 16 + 8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (k < end) ring.push([x, y]);
  }
  return ring;
}
