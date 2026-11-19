# Sanitized Taipei fixture

`taipei.xml` (6,477 bytes) is a whitelisted extract from saved request #8,
`/tmp/f027f5r/taipei-etag.body`, SHA-256
`8a13c95ab4aa42146193de9a5c839129595d89a39700ab481d19d88943a9a309`.
It contains only roadSegID, roadSegName, roadSegUpdatetime, psId, cellStatus and
data_Dt. Selected public parking rows exercise road-letter joins, leading zeros,
trailing psId spaces, equipment code 3 and unverified code 4. Other cells are
omitted; this small fixture does not establish full-road population/absence.
Geometry in unit tests is synthetic membership data, never a production release.
No source HTTP headers, credentials, raw full capture or internal map response
is included. `../measurement.json` contains derived full-capture counts/sizes.
