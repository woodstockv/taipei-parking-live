# LIVE-6b handoff

**Rules:** local only. Do not commit, push, create remote branches, enable workflows, or touch secrets, D1, TDX, Access, or cron. Never record secret values; only the names `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. No authorization to publish or schedule is implied.

**In progress:** public bootstrap is prepared on `codex/live6b-bootstrap`, uncommitted. Source is private ref `origin/cursor/live6a-r2-client`, commit `8302f9df9f4b8083cef3b42b7ab8d7ec26ad2516`. Original runner and tests are copied verbatim and verified by `npm run verify:provenance`; public wrapper and workflow are local additions. Dry run uses only the fixture and prints a 32-shard plan with zero network operations. See [plan](docs/DRY-RUN-PLAN.md).

**Where left off:** geometry is derived from the checked-in reader artifact. Its exact source input fetch date and original tile manifest are missing from the pinned Git ref; the embedded original pin cannot independently be recomputed here. Review [geometry provenance](docs/GEOMETRY-PROVENANCE.md) before release. The wrapper intentionally omits GC, so sustained publishing remains blocked pending reviewed retention/GC implementation. The 10,000-object pre-write guard and 48-hour GC grace can conflict at high churn.

**Pending decisions:** obtain exact geometry input provenance; confirm reader budget and actual cache/traffic, billing, dedicated bucket, sole-writer, CORS and operating owner; decide safe retention/GC and source courtesy; review public workflow and tests. Forge/Viv go is required for a single real publish; separate authorization is required for schedule activation. See [Viv steps](docs/VIV-STEPS.md).
