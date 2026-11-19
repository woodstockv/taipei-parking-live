# Viv-only steps

Nothing below has been done, and this document grants no approval to publish, provision or enable a schedule.

1. When a separately authorized push of this reviewed workflow is ready, the current `gh` token has `gist`, `read:org`, and `repo`, but lacks `workflow`. Viv runs `gh auth refresh -h github.com -s workflow` and approves the authorization in the browser. The operator can then push the reviewed branch when separately authorized. This bootstrap does not commit or push.
2. After the reviewed workflow is on the public repository's default branch and all release gates, owner and cost/retention plans are resolved, Viv may later set the repository Actions variable `LIVE_SCHEDULE_ENABLED` to `true` **only on explicit authorization for sustained scheduling**. Until then leave it unset. Set it back to a non-`true` value to stop future scheduled jobs; allow any running publisher to finish.

The allowlist variable, R2 provisioning and four Actions secrets (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), source verification, first real publish and any other release actions require their own existing authorization and are not implied by these two steps. All four R2 settings are read from secrets; no `R2_*` Actions variables are used. Publish preflight fails on missing or blank settings before network access, with setting names only. Dry-run needs none of these secrets. See the [dry-run plan](DRY-RUN-PLAN.md) and [reader budget](READER-BUDGET.md).
