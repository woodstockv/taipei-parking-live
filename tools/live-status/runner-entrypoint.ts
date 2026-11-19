/** Small one-shot LIVE-2 runner. CLI fails closed on missing R2 config before
 * reading geometry or making any source request. */
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Geometry } from "./assemble.ts";
import { localGeometry } from "./coverage.ts";
import { runCycle } from "./cycle.ts";
import type { CycleClock, SourceFetch } from "./fetch.ts";
import { collectGarbage } from "./gc.ts";
import { createR2Adapter, type R2Adapter } from "./r2-adapter.ts";

export interface RunnerOptions {
  adapter: R2Adapter; geometry: Geometry; geometrySha256: string;
  clock: CycleClock; fetch: SourceFetch; sourceUrl: string;
  gc?: { dryRun?: boolean };
}
/** Check the hard stop early; publication reserves its computed batch before writes. */
export async function runEntrypoint(options: RunnerOptions) {
  const { adapter } = options;
  return adapter.withExclusivePublisher(async () => {
    const used = await adapter.usage();
    if (used.classA >= 750_000) throw new Error("pipeline-budget-exceeded");
    // Publication learns the exact shard count only after assembling the source.
    // Include GC's conservative operation bound in that same reservation.
    const store = {
      get: adapter.get.bind(adapter), put: adapter.put.bind(adapter), inventory: adapter.inventory.bind(adapter),
      reserve: async (batch: Parameters<R2Adapter["reserve"]>[0]) => {
        const combined = options.gc
          ? { ...batch, classA: batch.classA + 96, classB: batch.classB + 1028,
              total: batch.total + 8000 }
          : batch;
        // reserve() includes already-owed reads and LISTs exactly once, plus
        // the ledger PUT, and checks the hard limits before writing.
        await adapter.reserve(combined);
      },
    };
    const cycle = await runCycle({ ...options, store });
    if (!cycle.ok) throw new Error(`cycle-failed: ${cycle.error}`);
    const gc = options.gc ? await collectGarbage({ store: { get: adapter.get.bind(adapter), list: adapter.list.bind(adapter), delete: adapter.delete.bind(adapter) }, geometrySha256: options.geometrySha256, now: options.clock.now(),
      exclusivePublisher: true, dryRun: options.gc.dryRun, maxDeletes: 5000, maxOperations: 8000, maxObjects: 75_000, maxListPages: 96 }) : null;
    if (gc && !gc.ok) throw new Error(`gc-failed: ${gc.error}`);
    return { cycle, gc };
  });
}
async function main(): Promise<void> {
  const adapter = createR2Adapter(); // Reads only R2_* and throws before geometry or source I/O when any are missing.
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const required = (k: string): string => { const v = env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
  if (required("GITHUB_REPOSITORY") !== required("LIVE_STATUS_PUBLIC_REPOSITORY") || env.GITHUB_REPOSITORY === "woodstockv/taipei-parking-alert") throw new Error("public-repository-allowlist");
  const pin = required("LIVE_STATUS_GEOMETRY_SHA256");
  const clock: CycleClock = { now: () => new Date().toISOString(), sleep: ms => new Promise(r => setTimeout(r, ms)),
    setTimer: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } };
  const scheduledGc = env.GITHUB_EVENT_NAME === "schedule" && new Date(clock.now()).getUTCHours() === 0;
  const result = await runEntrypoint({ adapter, geometry: localGeometry(required("LIVE_STATUS_GEOMETRY_DIRECTORY"), pin), geometrySha256: pin,
    clock, fetch: (url, init) => fetch(url, init), sourceUrl: "https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_roadquery.xml",
    // Daily UTC 00h maintenance window uses the SAME scheduled publisher job.
    // It defaults to dry-run. Explicit reviewed variable opts into deletion.
    // Delayed/dropped jobs can miss it: operator monitors inventory and runs
    // manual GC under this same concurrency group.
    gc: scheduledGc || env.LIVE_STATUS_GC === "true" ? { dryRun: env.LIVE_STATUS_GC_DELETE !== "true" } : undefined });
  console.log(JSON.stringify({ sourceStatus: result.cycle.sourceStatus, sourceAttempts: result.cycle.sourceAttempts,
    publicationClassA: result.cycle.classAOperations, gc: result.gc ? { ok: result.gc.ok, dryRun: result.gc.dryRun,
      eligible: result.gc.eligible.length, deleted: result.gc.deleted.length, operations: result.gc.operations,
      objects: result.gc.objects, storageBytes: result.gc.storageBytes } : null }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(new URL(import.meta.url))) {
  main().catch(e => { console.error(e instanceof Error ? e.message : "runner-failed"); process.exitCode = 1; });
}
