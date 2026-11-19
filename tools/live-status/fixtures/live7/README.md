# LIVE-7Q1 offline replay

These saved public inputs reproduce the full 2026-11-19 LIVE-7 investigation,
without contacting any source or publishing anything. The replay runs with the
worker unit tests (`cd worker && npm test -- test/live-status-normalization-replay.test.ts`).

| File | Contents | SHA-256 of decoded bytes |
| --- | --- | --- |
| `source.xml.gz` | Complete 8,533,693-byte TCMSV XML capture, 29,422 cells | `95570650b1ac419e8e8b972bf91d407bbb8b9066153c0669b9fde0ffe404129f` |
| `geometry.json.gz` | Exact saved geometry partitions, 51,536 original IDs and coordinates | `55c9fc8d4487d8b0cf67a244d59ccf0b4d4520ec9038d71eb446af77fa0987d1` |
| `published-manifest.json` | Original publication manifest, including clocks and pre-normalization counts | `05861f80cb1a3364a9ed1f6ad83071bdcc09b0109459cfb6cc8476fb28ff4645` |
| `published-ambiguous-ids.json` | Sorted 64 original ambiguous geometry IDs from the investigation | `e9166105787b1b61c662e49bf434b1ec624388f8484aa29ce94cc77e01861d0b` |

The geometry **provenance pin** remains
`e7a882774f11a7d78c0ff1606290a76fd1dea45403c8949f2c593373f1cc0608`.
It identifies the geometry release; the separate decoded-file hash above checks
the saved partitions used in the investigation. No geometry was rebuilt.

Inputs were copied locally from `/workspace/live7/public/source-current.xml`,
`/workspace/live7/runner/web/public/live-geometry/<pin>.json.gz`, and
`/workspace/live7/public/manifest.json`. The XML was compressed with Python
`gzip.compress(source_bytes, compresslevel=9, mtime=0)`; decompression restores
the exact original bytes. The geometry gzip and manifest are unmodified copies.
The ID list was derived with
`json.dumps(sorted(row["id"] for row in ambiguities), ensure_ascii=False, indent=2) + "\n"`
from `/workspace/live7/ambiguities.json`. These fixtures total about 798 KiB.

The replay pins all four decoded hashes before exercising the actual parser,
join, assembler and coverage analyzer. It checks original IDs, coordinates,
provider aliases, raw statuses, event clocks, 32 partition memberships and bounds.
Expected geometry: **21,332 matched / 30,136 unmatched / 68 ambiguous**.
Expected source: **21,332 matched / 7,812 unmatched / 278 ambiguous**.

The 4,499 recovered matches are offset by four formerly matched keys that now
reveal duplicate source candidates: `信義路5段150巷` 03/04/05 and `內湖路2段` 21.
All four, plus the original 64 ambiguous rows, withhold provider aliases and
occupancy. Net matched gain: **4,495**. Unmatched does not establish sensor absence.
