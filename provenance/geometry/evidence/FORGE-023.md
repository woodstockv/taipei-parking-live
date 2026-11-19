# FORGE-023: Taipei car-space tiles and honest per-space status

Geometry comes from the OGDL shapefile, converted offline to WGS84 JSON pages.
Live status for a TDX spot comes only from TDX `SpotStatus` on the segments the
viewport just touched. TCMSV `cellStatus` is stored raw and shown as unknown.
Nothing in this change loads the city into D1.

## What was wrong on the merged viewport

Traced on `57a8eef` (the merged viewport), not from a production log:

- `loadViewportSpaces` stores every new TDX spot with status `unknown` and does not
  set `status_at`. `web/src/spaces.ts` `spaceDetails` then renders
  `狀態：未知 · 更新時間：未知`, and `spaceStyle` draws `?`. That string is the
  honest empty reading, not a client lookup that dropped a known status.
- The non-refresh map path only called `POST /api/spaces/viewport`. It never called
  `ParkingSpotAvailability`. A second look inside the geometry TTL returned
  `cached` and still did not ask for status.
- `正在載入這個範圍，請稍候` is the server busy notice. `這個範圍的車格尚未載完，稍後再繼續`
  is `coverageNote` when `truncated` is set and `retryAfterMs > 0`. The client copied
  both onto the sheet and left them there after the continuation stopped. A `moveend`
  for the same view called `loadArea`, which reset the 24-step cap and aborted the
  in-flight request. The aborted request's `finally` did not clear the spinner when
  a newer generation had already replaced it, so `更新中…` could stay up.

Production row counts were not queried. They are not evidence for this change.

## What a viewport request does now

One `POST /api/spaces/viewport` may do two TDX calls, and only for segments already
in the view (at most 8):

1. `ParkingSpot` page, as before (`$top=120`, one `$skip`).
2. `ParkingSpotAvailability` with `$top=200` for those same segment ids, only when
   the 2.0 point target and the 4/min window still allow it. Token HTTP 429 does
   not pause alerts. `SpotStatus` 2 is free, 1 is occupied, anything else (and
   `DeviceStatus` 0) is unknown. Rows the payload does not mention stay unknown.
   An older `DataCollectTime` does not replace a newer `status_at`. SHP tile rows
   and NTPC rows are not updated by this call.

A missing or unofficial reading is not turned into a free count. After one attempt,
those rows are not a reason to keep `retryAfterMs` at 0.

Taipei geometry tiles are optional static files. An empty `viewport_spaces` table
and all-null segment envelopes still load the tiles that overlap the bbox. Only
spots inside the current bbox are written. A tile page is remembered per view, so
loading the west side of a cell does not mark the east side finished. The centroid
pad stays in force after an envelope is stored. A finished spot page may widen a
segment box to the in-view spots just seen; a full 120-row page does not, and the
box is not described as the whole segment. No coordinate is invented.

`ParkingSpotAvailability` is one segment and one page of 200 per viewport request.
A full page keeps a `$skip` and `retryAfterMs: 0` so a stationary map continues.
A short or empty page finishes that segment for 60 seconds. Rows the page does not
return stay unchecked. A reading without `DataCollectTime`, or an older one, does
not replace a newer status. TCMSV `cellStatus` stays unknown. A collect time is
not stored as `status_at` or `checked_at`, so the sheet does not show an update time.

## Offline files

Measured 2026-11-06 from the public downloads, then discarded the city archive.
Only the 伊通街 car page is in the repo (`web/public/space-tiles/`).

| Item | Value |
| --- | --- |
| Geometry dataset | https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611 |
| Zip sha256 | `a0c239d03f8a080747fb7ff23fafaec0d21566994306ebbbc5d8843e7efef3e5` |
| File | `park01_202610021742` (2026-10-02), EPSG:3826, OGDL-Taiwan-1.0 |
| Features / cars / 伊通街 cars | 334283 / 54938 / 22 (A 5, B 17, no C) |
| 伊通街B 35 | 25.0488306, 121.5346675 (within 1e-5° of 25.048826, 121.534665) |
| Status feed | https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_roadquery.xml |
| XML sha256 | `52c89b57b3c843cbd905b94a9b0c622510f595c78bbe32c94086de9fff714242` |
| Strict letter join | 12 matched, 10 unmatched, 0 ambiguous, 8 cross-letter not applied |
| cellStatus | data.gov.tw dataset 128617 does not define it. Codes 0, 1, 2, 3 stay unknown |

```
node --experimental-strip-types tools/build-taipei-space-tiles.ts \
  --shp park.shp --dbf park.dbf --out ./space-tiles --chunk 2000 \
  --status-xml ./TCMSV_roadquery.xml
```

`--count-only` prints counts and writes nothing. `--road 伊通街` keeps one street.
Each cell page has at most 80 spots. A denser cell continues as `{lat}_{lng}.pN.json`
instead of dropping rows. FORGE-025 groups these pages spatially and adds a bounded
`{lat}_{lng}.index.json` per cell; see the current layout and republishing command
below. The tool does not open a database.

### FORGE-023e local input check (2026-11-15)

The builder skips selected car records that fail the existing `tileSpotId`
validator. Valid ids are still formed in exactly the same way. Its stdout summary
and `provenance.json` include `skipped` and mutually exclusive `skippedByReason`
counts: `missingRoadName`, `missingSpaceNumber`, `missingBoth`, and `other` (both
fields present but rejected by the validator). These counts apply after `--road`
filtering; `cars` includes cars before that filter. Geometry errors and short reads
remain hard errors.

The first full-city attempt then exposed another source problem: 70 repeated-id
rows, across 65 ids, with geometry different from the first occurrence. The CLI
now omits **every copy** of a repeated id and counts those rows as `duplicateId`.
It removes the earlier copy even if a previous chunk already ingested it, rather
than arbitrarily picking one location or inventing another id. This is an
additional record-level skip; the shared `ingestTileChunk` duplicate-id error is
unchanged. Non-car records and road-filtered records keep their separate counters.

On 2026-11-15, SHA-256 of the local
`/workspace/forge-022/TCMSV_roadquery.xml` was
`126583745bcc353794d4f9a22ca2e25ce562c59b28581f593d1609b8fb7af812`.
This differs from the documented 2026-11-06 download hash
`52c89b57b3c843cbd905b94a9b0c622510f595c78bbe32c94086de9fff714242`
in the table above. The local file was checked directly; the feed was not fetched
again, and the historical hash has not been replaced.

The complete local build used:

```bash
node --experimental-strip-types tools/build-taipei-space-tiles.ts \
  --shp /workspace/forge-022/shp/park01_202610021742.shp \
  --dbf /workspace/forge-022/shp/park01_202610021742.dbf \
  --status-xml /workspace/forge-022/TCMSV_roadquery.xml \
  --out /tmp/forge023e-tiles
```

| Full-city result (2026-11-15) | Count |
| --- | ---: |
| Total source records | 334,283 |
| Deleted / non-car / road-filtered | 0 / 279,345 / 0 |
| Car records | 54,938 |
| Cars kept | 51,536 |
| Geometry pages / status pages | 647 / 647 |
| Skipped: missing road only | 1,921 |
| Skipped: missing space number only | 279 |
| Skipped: both missing | 1,067 |
| Skipped: other invalid id | 0 |
| Skipped: all copies of repeated ids | 135 |
| Total skipped car records | 3,402 |
| Elapsed wall time (including status join and file writes) | 3.909 s |

Exit status was 0. The local artifact check verified all geometry file hashes,
unique ids, the 80-space page cap, corresponding status pages, and summary totals.
Build output is in `/workspace/forge/forge023e-progress.log`; provenance is in
`/tmp/forge023e-tiles/provenance.json`. No database, Wrangler, Cloudflare service,
upload, or network write was used for this build.

### FORGE-023f geometry validation and chunk invariance (2026-11-15)

FORGE-023e could remove a buffered duplicate before ingestion checked its
coordinates. The repro `[ID35 with a NaN vertex, valid ID35, valid ID36]` failed
with chunk 1 but succeeded with larger chunks. Geometry is now checked on every
source record before any skip or duplicate removal: polygon parts and all
vertices (including inner parts), finite centroid and Taiwan projection bounds.
Malformed shapes and non-finite vertices are hard `bad-geometry at record N`
errors even when the row would otherwise be omitted. Checked centroids go to
ingestion; the drop-all-duplicates policy and skip counters are unchanged.

CLI regression tests cover corrupt first/later/already-ambiguous duplicate copies
and invalid-id rows at chunks 1, 2, 3 and 2000. They check exit 1, the same record
error, no summary and no output files. A valid duplicate case compares all
geometry, status and provenance bytes, and counts, across those chunk sizes.

The full-city rerun used the same local inputs:

```bash
set -o pipefail
timeout 900 node --experimental-strip-types tools/build-taipei-space-tiles.ts \
  --shp /workspace/forge-022/shp/park01_202610021742.shp \
  --dbf /workspace/forge-022/shp/park01_202610021742.dbf \
  --status-xml /workspace/forge-022/TCMSV_roadquery.xml \
  --out /tmp/forge023f-tiles \
  2>&1 | tee -a /workspace/forge/forge023f-progress.log
```

Exit 0, 5.823 s: **647 geometry + 647 status pages**, **54,938 cars**,
**51,536 kept**, skipped **1,921 / 279 / 1,067 / 0 + 135 duplicates = 3,402**.
All counts match the FORGE-023e table. Repeating with `--chunk 1` and
`--out /tmp/forge023f-tiles-chunk1` also exited 0 (3.124 s). All 1,295 JSON files,
including provenance, match byte for byte between both chunk sizes and the prior
`/tmp/forge023e-tiles` output. Hashes, page caps, unique ids, coordinate bounds,
status correspondence and totals were checked locally. Provenance is at
`/tmp/forge023f-tiles/provenance.json`; evidence is appended to
`/workspace/forge/forge023f-progress.log`. No uploads or database writes occurred.

## FORGE-025 spatial layout and republication

The 0.08° cells and page names stay the same. Previously pages were sorted only
by ID: the local downtown cell `25.04_121.52` has 285 pages, so a small view could
exhaust the client's 24 progress steps before reaching most of its spaces.

The builder now recursively splits on the widest coordinate axis, using IDs to
break ties. Leaves contain at most 80 spaces and are sorted by ID. Each cell's
`{lat}_{lng}.index.json` contains:

```json
{"v":1,"cell":"25.04:121.52","pages":[[121.53,25.048,121.535,25.051]]}
```

Each bbox is `[west,south,east,north]`, tightly enclosing that page's centroids;
its array offset is the zero-based page number. Geometry/status formats and
page names remain compatible: page 0 is `{lat}_{lng}.json`, later pages are
`{lat}_{lng}.pN.json`, status uses the corresponding name under `status/`.
Indexes are capped at 512 pages per cell and 48,000 bytes; the offline build
refuses a larger cell. Provenance records the layout and index hashes too.

A viewport step reads at most four indexes and one intersecting geometry page
per due cell (at most four), plus matching optional status pages. All bodies
retain the 48,000-byte cap. Selection uses the existing outward 0.005° snap,
which is the cache coverage and write boundary. The cursor jumps directly to
the next intersecting page. It never walks intervening pages. Fresh complete
snaps and covered subviews still make no fetches or budgeted writes. Tile cache
keys use `tile:spatial1:{cell}@{bbox}` to avoid old sequential cursor/completion
state; no schema or migration change is needed.

If an index returns 404, the loader checks only legacy page 0: a single-page tile
or an absent cell is supported; a multi-page tile produces the explicit
「車格圖磚索引缺少或無效，請管理員重新發布圖磚」 error. Invalid or oversized indexes
also fail without reading geometry. There is no sequential fallback, and existing
cooldowns/client limits still bound retries. Missing/mismatched indexed pages
remain incomplete. TCMSV statuses remain unknown.

Rebuild from the supplied local files, from the repository root:

```bash
set -o pipefail
timeout 900 node --experimental-strip-types tools/build-taipei-space-tiles.ts \
  --shp /workspace/forge-022/shp/park01_202610021742.shp \
  --dbf /workspace/forge-022/shp/park01_202610021742.dbf \
  --status-xml /workspace/forge-022/TCMSV_roadquery.xml \
  --out /tmp/forge025-tiles \
  2>&1 | tee -a /workspace/forge/forge025-progress.log
```

The rebuilt **output directory is `/tmp/forge025-tiles/`**. DevOps must publish
**all its contents together**, including `*.index.json`, all geometry pages,
`status/` and `provenance.json`, at the existing Pages site's **`space-tiles/`**
path. To prepare an unambiguous Pages upload root locally:

```bash
mkdir -p /tmp/forge025-pages/space-tiles
cp -a /tmp/forge025-tiles/. /tmp/forge025-pages/space-tiles/
```

DevOps uploads **`/tmp/forge025-pages/` as the Pages site root**, so the public
objects become `https://taipei-parking-tiles.pages.dev/space-tiles/*.index.json`,
`.../space-tiles/*.json` and `.../space-tiles/status/*.json`. Publish the complete
build atomically (a single Pages release); do not mix old ID-sorted pages with
new indexes. Keep `TAIPEI_SPACE_TILE_BASE` at
`https://taipei-parking-tiles.pages.dev/space-tiles`; if configured,
`TAIPEI_SPACE_STATUS_BASE` points to the same base plus `/status`. No database
import or production migration is part of republishing. These are operator
instructions: **this run did not upload or deploy anything**.

| Local full-city build (2026-11-15) | Result |
| --- | ---: |
| Source records / car records | 334,283 / 54,938 |
| Cars kept / skipped | 51,536 / 3,402 (unchanged) |
| Geometry / status pages / indexes / provenance | 647 / 647 / 8 / 1 |
| Total JSON files / bytes | 1,303 / 15,480,855 |
| Maximum geometry page spaces / bytes | 80 / 9,469 |
| Maximum status page / index bytes | 21,816 / 13,604 |

Skip reasons remain 1,921 missing road, 279 missing number, 1,067 both, 0 other,
135 ambiguous duplicate rows. Local checks verified geometry/index hashes,
unique IDs, tight page bounds, status correspondence and all size/count caps.

The production box's exact coordinates were not supplied. The explicit local
伊通街 test box `121.5338,25.048,121.5351,25.051` (west/south/east/north) has
**25 spaces** on old pages **14, 97, 179, 273**, now on spatial page **15**.
The real loader's existing snap is `121.530,25.045,121.540,25.055`: it reads only
intersecting geometry pages **9, 10, 11, 14, 15, 16, 26, 28, 36, 39, 40** in
11 steps, plus 11 index and 11 optional status reads. All **25** raw-box spaces
are found; 510 snap-contained spaces are stored in the local SQLite fixture.
The total is 2,348 guard-units, each step within the unchanged 2,800 reserve;
a cached repeat uses no fetches or budgeted writes. No TDX/network provider was
called by this check: fetches read the generated files locally.

Only the small companion index for the existing checked-in 22-space 伊通街
sample is committed in `web/public/space-tiles/`; it keeps local static serving
representative of the new layout. The full-city build and upload root remain
outside git.

## Publish, then set the variables

Do not load the city into D1. Do not schedule this tool. Do not provision a bucket
from this tree.

1. Publish the complete spatial build as described above. Required keys include
   `space-tiles/{lat}_{lng}.index.json`, `space-tiles/{lat}_{lng}.json`, any
   `space-tiles/{lat}_{lng}.pN.json`, and corresponding `space-tiles/status/` pages.
   Use one complete Pages release so indexes and geometry agree.
2. Set `TAIPEI_SPACE_TILE_BASE` to the directory URL of the geometry pages.
   Set `TAIPEI_SPACE_STATUS_BASE` to the directory URL of the status pages.
   Both are public URLs, not secrets. Leave them unset until the files exist.
   `.dev.vars.example` points at `http://127.0.0.1:8788/space-tiles` for
   `wrangler pages dev --local` only.
3. Check one cell: 伊通街 at zoom 17 shows 22 separate car markers. B35 is near
   25.04883, 121.53467. Status is unknown unless a TDX `SpotStatus` reading exists.
4. Roll back by unsetting the two variables. The map returns to TDX spots that
   already have coordinates. Delete the uploaded objects if you want the files gone.
   There is no database migration to undo.

Workers Free CPU (10 ms) was not measured on a live worker. The caps (120 spot rows,
200 availability rows, 4 tile indexes + 4 geometry pages + 4 optional status
pages, 48,000-byte bodies) are the bound, not a profile.
D1 `rows_written` is not proven by the SQLite tests.
