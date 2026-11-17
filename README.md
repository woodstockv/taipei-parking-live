# taipei-parking-live

A small live-status extractor for Taipei on-street parking.

It reads the Taipei City TCMSV road-parking status feed (public open data),
joins each cell to a pinned, reviewed geometry release, and publishes compact
per-cell status shards plus a manifest to a public Cloudflare R2 bucket. The
taipei-parking-alert web app (https://taipei-parking-alert.pages.dev) reads only
the shards that cover the visible map area.

Status: provisioning only. This repository does not contain app code, and no
scheduled job is enabled yet.

- Code license: MIT (see `LICENSE`).
- Data source and license: see `DATA-ATTRIBUTION.md`.
