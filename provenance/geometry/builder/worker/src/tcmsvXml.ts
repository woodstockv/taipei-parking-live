/**
 * Offline TCMSV cell extract. Not imported by the viewport request path.
 * The full city document is only read by the tile tool, which then writes one
 * small status file per geometry page.
 */

const MAX_XML_CHARS = 20_000_000;

export interface TcmsvXmlCell {
  roadSegId: string;
  roadName: string;
  psId: string;
  cellStatus: string;
  collectedAt: string;
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? match[1].trim() : "";
}

/** Every cell with a road id, road name and psId. Roads without cells contribute nothing. */
export function parseTcmsvCells(xml: string): { cells: TcmsvXmlCell[] } | { error: string } {
  if (xml.length > MAX_XML_CHARS) return { error: "xml-too-large" };
  const cells: TcmsvXmlCell[] = [];
  let from = 0;
  while (from < xml.length) {
    const start = xml.indexOf("<ROAD", from);
    if (start === -1) break;
    const end = xml.indexOf("</ROAD>", start);
    if (end === -1) return { error: "truncated-xml" };
    const block = xml.slice(start, end + "</ROAD>".length);
    from = end + "</ROAD>".length;
    const roadSegId = tag(block, "roadSegID");
    const roadName = tag(block, "roadSegName");
    if (!roadSegId || !roadName) continue;
    const listStart = block.indexOf("<cellStatusList>");
    const listEnd = block.indexOf("</cellStatusList>");
    if (listStart === -1 || listEnd === -1 || listEnd < listStart) continue;
    const list = block.slice(listStart, listEnd);
    let cursor = 0;
    while (cursor < list.length) {
      const cellStart = list.indexOf("<cell>", cursor);
      if (cellStart === -1) break;
      const cellEnd = list.indexOf("</cell>", cellStart);
      if (cellEnd === -1) return { error: "truncated-xml" };
      const cell = list.slice(cellStart, cellEnd + "</cell>".length);
      cursor = cellEnd + "</cell>".length;
      const psId = tag(cell, "psId");
      if (!psId) continue;
      cells.push({
        roadSegId,
        roadName,
        psId,
        cellStatus: tag(cell, "cellStatus"),
        collectedAt: tag(cell, "data_Dt"),
      });
    }
  }
  return { cells };
}
