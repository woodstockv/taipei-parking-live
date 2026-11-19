# Public reader Class B budget

The LIVE-4/5 client polls the manifest every **5 minutes** while enabled and also reloads on viewport changes. Each load requests the manifest with `cache: no-cache`, allowing browser HTTP revalidation (including ETag where supported); count every origin revalidation, including a 304, as one Class B GET. It fetches at most **four** intersecting shards per load, at most two concurrently. Verified in-memory cache retains one hash per logical shard; unchanged hashes need no shard fetch. Shards use browser default HTTP caching. New hashes and viewport changes can cause additional reads, so five requests per five minutes is an illustrative stationary-view bound, not a limit on pan/zoom, tabs, bots, retries, or abuse. The separate one-minute freshness timer does not fetch.

With continuous use, 30 days = 8,640 polls per user. Assuming one origin manifest read each poll, plus zero to four new shard reads, gives:

| Continuously active users | Manifest only B/month | Manifest + four changed shards/poll B/month |
| ---: | ---: | ---: |
| 1 | 8,640 | 43,200 |
| 10 | 86,400 | 432,000 |
| 100 | 864,000 | 4,320,000 |
| N | 8,640 N | 43,200 N |

31 days: 8,928 to 44,640 B/user. Initial loads, movement and other traffic add to these estimates; actual sessions may be shorter and CDN hits may reduce origin reads. Public reads and unrelated account activity are **not in the publisher ledger**. On 30-day figures, an 8M reader allocation supports at most 925 users manifest-only or 185 at five origin reads/poll, before other unmodelled reader activity. For 31 days the latter is 179. These are mathematical ceilings, not launch targets.

Cloudflare [R2 pricing](https://developers.cloudflare.com/r2/pricing/) includes 10M Class B and 1M Class A requests per month account-wide for Standard storage, with paid overage and rounding; direct internet egress is free. Standard is assumed; Infrequent Access has different terms. A representative upper-byte estimate at five fetches/poll uses the measured 14,412-byte manifest and four 10,872-byte gzip shards: 57,900 bytes/poll, about 500 MB per continuously active user per 30 days before HTTP overhead; the manifest is uncompressed and shard sizes and change frequency vary. CDN/other services can have separate charges or limits.

The [r2.dev endpoint](https://developers.cloudflare.com/r2/platform/limits/) is for development, has a variable rate limit (hundreds of requests/second), and may throttle bandwidth. It is not a production SLA or a fixed safe audience limit. Use an authorized [custom domain and cache](https://developers.cloudflare.com/r2/buckets/public-buckets/) for production and verify CORS, caching and revalidation on the actual path.

Recommend minimum five-minute polling, manifest `public, max-age=60`, content-addressed gzip shards `public, max-age=31536000, immutable`, CORS exposing ETag, and measured origin metrics, rate limits and billing alerts. `no-cache` still revalidates despite max-age; do not assume 60-second cache eliminates origin reads. Alert by 7M total B/month and keep publishing disabled if projected account-wide monthly B including reader, publisher, GC and unrelated traffic reaches **9M**, if reader traffic cannot be measured/bounded, or if a reviewed reader allocation exceeds **8M**. Also stop for Class A or storage guards; the provider free tier is not a hard spending cap.
