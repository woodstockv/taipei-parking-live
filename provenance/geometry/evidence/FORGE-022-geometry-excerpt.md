# FORGE-022 — Per-space curb parking data sources (research only)

**Date:** 2026-11-06 (Asia/Taipei)  
**Scope:** Find free, legal sources that can place **every curb space** (esp. 伊通街 ≈ 25.05, 121.533) for Taipei and New Taipei. No code / merge / deploy in this ticket.  
**Probe ID:** 伊通街 TDX segments `20260A0` / `20260B0` / `20260C0`.

### 1. data.taipei / data.gov.tw — 臺北市路邊停車格位 (SHP) ★ BEST GEOMETRY

| | |
|---|---|
| URL | Dataset: https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611 |
| Download | https://data.taipei/api/dataset/5a911ea5-1694-4301-808e-e1780d971611/resource/7e2f32a0-9201-4666-a0ed-11034e6c2b66/download (~54 MB zip) |
| Also listed | https://data.gov.tw/dataset/128288 |
| Auth | None |
| License | 政府資料開放授權條款第1版 (OGDL-Taiwan) — free |
| Update | Monthly (file probed: `park01_202610021742.*`, meta 2026-10-06) |
| CRS | **TWD97 TM2 zone 121 (EPSG:3826)** — convert to WGS84 for the map |
| Geometry | Per-space **polygons** (`pknum` usually 1) |
| Status | **None** (static inventory) |
| Key fields | `pktype`, `pkid`, `pkroad`, `pknum`, `zone`, `pkkind`, … |
| `pktype` (official) | 01 小型車, 02 機車, 03/04 身障, 06 大型車, **07 貨車裝卸**, 09 限時, … |

**伊通街 verification (this run):**

- `pkroad` contains 伊通: **487** features (mostly scooters).
- Cars `pktype=01`: **22** — examples after transform:
  - 伊通街A / 19 → 25.052396, 121.534851
  - 伊通街B / 35 → 25.048826, 121.534665 (matches TDX spot `20260B035` Position 25.04881, 121.53466)
- Counts in SHP: total **334,283**; cars **54,938**; scooters **241,591**; truck `07` **2,073**.

**Vs ArcGIS FeatureServer we already use:** same thematic layer name, but FeatureServer count **36,482** and only **2–4** car polygons on 伊通 — incomplete mirror. Prefer the SHP download.

---

