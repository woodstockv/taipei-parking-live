/** GIS pktype is a different code system from TDX SpaceType.
 * Verified repo evidence: docs/api.md (01/07). Synthetic fixtures do not
 * establish code meanings; all other codes stay raw pending a source table.
 */
export function normalizePktype(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return String(raw).padStart(2, '0');
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function pktypeLabel(code: string): string {
  switch (code) {
    case '01': return '一般車格';
    case '07': return '貨車裝卸格';
    default: return `其他車格（代碼 ${code}）`;
  }
}

/** Keep geometry metadata in the existing extensible JSON detail, independently
 * of provider readings. Legacy text is wrapped without losing its label.
 * Only internal SQL expressions are accepted here, never user input.
 */
export function withPktypeSql(detail: string, code: string): string {
  return `CASE WHEN ${code} IS NOT NULL THEN json_set(
    CASE WHEN json_valid(${detail}) AND json_type(${detail}) = 'object' THEN ${detail}
      ELSE json_object('v', 1, 'label', ${detail}) END, '$.pktype', ${code}) ELSE ${detail} END`;
}

export function detailPktype(text: string | null): string | null {
  if (!text?.startsWith('{')) return null;
  try { return normalizePktype((JSON.parse(text) as { pktype?: unknown }).pktype); }
  catch { return null; }
}

export function detailLabel(text: string | null): string | null {
  if (!text?.startsWith('{')) return text;
  try {
    const label = (JSON.parse(text) as { label?: unknown }).label;
    return typeof label === 'string' ? label : null;
  } catch { return text; }
}

export function storedPktypeSql(table: string): string {
  return `CASE WHEN json_valid(${table}.status_detail) THEN json_extract(${table}.status_detail, '$.pktype') END`;
}
