# Geometry provenance

The pinned geometry is reproducible offline from the source archive already on this machine. `npm run verify:geometry` rebuilds the historical tiles, verifies every page/index, recomputes the namespace, and regenerates the reader gzip byte-for-byte. No dataset download, TDX, credentials or network access is used. The input record and evidence are in [source.json](../provenance/geometry/source.json); the recovered historical manifest is [tile-provenance.json](../provenance/geometry/tile-provenance.json).

## Licensed input and acquisition evidence

The provider is **臺北市停車管理工程處**, dataset **臺北市路邊停車格位**, ID `5a911ea5-1694-4301-808e-e1780d971611`, under **Government Open Data License v1 / OGDL-Taiwan-1.0**. The [dataset page](https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611) and [recorded resource URL](https://data.taipei/api/dataset/5a911ea5-1694-4301-808e-e1780d971611/resource/7e2f32a0-9201-4666-a0ed-11034e6c2b66/download) are attribution/reference links; verification never fetches them.

The recorded fetch date is **2026-11-06 (Asia/Taipei)**. Evidence: the locally retained FORGE-022 report is dated 2026-11-06 and identifies the dataset, download URL, license and `park01_202610021742` source; its [geometry excerpt](../provenance/geometry/evidence/FORGE-022-geometry-excerpt.md) is preserved here. The private repo's `docs/FORGE-023.md` at `8302f9df9f4b8083cef3b42b7ab8d7ec26ad2516`, lines 59–68, records the 2026-11-06 public download and exact archive hash; a [verbatim copy](../provenance/geometry/evidence/FORGE-023.md) is preserved. The currently available archive hashes to that same value. Exact HTTP request time and response headers were not retained; filesystem timestamps from the restored workspace are not acquisition evidence.

| Actual local input | Bytes | SHA-256 |
| --- | ---: | --- |
| `taipei-parking-shp.zip` | 56,300,005 | `a0c239d03f8a080747fb7ff23fafaec0d21566994306ebbbc5d8843e7efef3e5` |
| ZIP member `park01_202610021742.shp` | 45,514,168 | `8a5b5047afde29dd1bb829c38d739a2d41a8c60ca52123e2baaaafd9be3c382c` |
| ZIP member `park01_202610021742.dbf` | 490,060,576 | `89959e2cc58e72b53407b7abc427036e8a91ba176fc11565e8fe9445478b062c` |
| Historical `TCMSV_roadquery.xml` | 8,635,288 | `126583745bcc353794d4f9a22ca2e25ce562c59b28581f593d1609b8fb7af812` |

The inputs remain at `/workspace/forge-022/` (SHP/DBF under `shp/`); their paths, sizes, hashes and archive member names are recorded. The verifier checks the archive itself, streams and hashes its SHP/DBF members, and checks that the extracted builder inputs have those same hashes. Large raw inputs are recorded rather than bundled in this repository.

**Correction to the prior handoff:** FORGE-023's differing local input is explicitly `/workspace/forge-022/TCMSV_roadquery.xml`, not the geometry archive. See the preserved [FORGE-023 record](../provenance/geometry/evidence/FORGE-023.md), lines 106–112: its local XML hash `126583...f812` differs from the earlier XML hash `52c89b...4242`. This does not establish any geometry archive discrepancy. XML does not supply the geometry coordinates, but the historical tile manifest embeds its hash and join summary, so the exact XML is required to reproduce the namespace. Its exact acquisition time is not established; its bytes and the 2026-11-15 local verification are recorded.

## Exact offline reconstruction

Git history traces the spatial tile builder to **`64646b0f55fd134939d8791aa06b8a79eec65f15`** (FORGE-025, 2026-11-15). The entrypoint `tools/build-taipei-space-tiles.ts` and its four runtime imports are copied verbatim under [builder/](../provenance/geometry/builder/). Their individual SHA-256 values are in `source.json`, and `npm run verify:provenance` compares them to that Git commit. Historical [FORGE-023 instructions](../provenance/geometry/evidence/FORGE-023.md), lines 219–230, give the same SHP, DBF and XML inputs. The private `docs/STATUS.md` at `8302f9d`, lines 1552–1553, records namespace `e7a882...0608` for `/tmp/forge025-tiles/provenance.json` (647 pages and eight indexes).

The available `/workspace/forge-023-tiles/space-tiles/provenance.json` hashes to `a069102d63948b95508b0c2f2ce7affb05a212e761eccf915558e002e2af176b`; it is a different build and was not substituted for the namespace manifest. The manifest committed here was **recovered by running the historical builder on the hash-verified local inputs**. Its exact bytes reproduce the recorded namespace hash. The generated 647 geometry pages and eight indexes are transient outputs; the verifier reads and validates all of them against the recovered manifest.

Use Node **24.22.1 on Linux** and Python 3 (standard-library ZIP inspection only):

```sh
npm run verify:geometry
# Or supply a different directory containing the same hash-pinned inputs:
node --experimental-transform-types scripts/verify-geometry.mjs /path/to/forge-022
npm run verify:provenance -- /workspace/taipei-parking-alert
```

The verifier creates and removes a temporary output directory. It runs the unmodified historical builder, restores the original input path labels in the generated manifest when a different input directory is supplied (paths are part of its bytes), then compares the manifest byte-for-byte and by SHA-256. `localGeometry` checks every generated tile/index hash. The reader artifact is rebuilt using the assembler's deterministic spatial bisection (2,048-row leaf limit), `[id,lng,lat]` point order, compact JSON, and Node gzip level 9 with its original Linux gzip header. This yields **51,536 points / 32 partitions**. The namespace and artifact stay unchanged.

| Reproduced object | SHA-256 |
| --- | --- |
| Historical tile manifest / namespace | `e7a882774f11a7d78c0ff1606290a76fd1dea45403c8949f2c593373f1cc0608` |
| Decoded reader JSON | `55c9fc8d4487d8b0cf67a244d59ccf0b4d4520ec9038d71eb446af77fa0987d1` |
| Reader gzip | `9dfab33b1cf1f98f504d2accbfb43f1cc4185c18af214cb450fd548f7341b30b` |

Git history first introduces the reader gzip in LIVE-5 commit `ed6627daf7c644b6c84fd41230f32a93e7d928c7`. Its copy at the pinned LIVE-6a source commit remains covered by the original [26-file provenance](../PROVENANCE.json). Both the namespace and gzip now have a reproducible chain to the recorded, licensed geometry archive. The remaining evidence limits are the absent original HTTP headers/exact fetch clock and the need to retain or supply the recorded large local inputs for a full rebuild; no network retrieval is part of verification.
