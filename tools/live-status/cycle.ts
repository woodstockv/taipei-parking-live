/** Injected one-shot orchestration; no CLI, scheduler, or side effects on import. */
import { assemble, type Geometry } from "./assemble.ts";
import { acquireSource, AcquisitionError, type CycleClock, type SourceFetch, type FetchOptions } from "./fetch.ts";
import { loadCheckpoint, publish, type ObjectStore, type PublicationResult } from "./publish.ts";
import { isHash, type LiveManifest } from "../../shared/liveStatus.ts";
export interface CycleOptions {
  store: ObjectStore; fetch: SourceFetch; clock: CycleClock; sourceUrl: string;
  /** Validated geometry from readGeometry and an independently reviewed release pin. */
  geometry: Geometry; geometrySha256: string; partitionRows?: number;
  acquisition?: Pick<FetchOptions, "timeoutMs" | "maxAttempts" | "backoffMs" | "maxBackoffMs">;
}
export type CycleResult = PublicationResult & { sourceAttempts: number; sourceStatus: 200 | 304 | null };
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  let previous: LiveManifest | null = null; let sourceAttempts = 0; let sourceStatus: 200 | 304 | null = null;
  try {
    if (!isHash(options.geometrySha256) || options.geometry.sha256 !== options.geometrySha256) throw new Error("cycle-geometry-pin-mismatch");
    previous = await loadCheckpoint(options.store, options.geometrySha256);
    const capture = await acquireSource({ ...options.acquisition, url: options.sourceUrl, fetch: options.fetch, clock: options.clock, previous: previous?.source ?? null });
    sourceAttempts = capture.attempts; sourceStatus = capture.status;
    const candidate = capture.status === 304 ? { checkedAt: capture.checkedAt } : assemble({
      xml: capture.xml, geometry: options.geometry, capturedAt: capture.capturedAt, checkedAt: capture.checkedAt,
      publishedAt: capture.checkedAt, etag: capture.validators.etag, lastModified: capture.validators.lastModified,
      partitionRows: options.partitionRows,
    });
    const result = await publish({ store: options.store, geometrySha256: options.geometrySha256, previous, candidate, now: () => options.clock.now() });
    return { ...result, sourceAttempts, sourceStatus };
  } catch (error) {
    return { ok: false, checkpoint: previous, error: error instanceof Error ? error.message : "cycle-error", classAOperations: 0, shardPuts: 0, manifestPuts: 0,
      sourceAttempts: error instanceof AcquisitionError ? error.attempts : sourceAttempts, sourceStatus };
  }
}
