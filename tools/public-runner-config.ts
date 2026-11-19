import { readR2Config } from './live-status/r2-adapter.ts';

/** Publish preflight: errors contain only setting names, never their values. */
export function validateRunnerConfig({ dryRun, env }: {
  dryRun: boolean;
  env: Record<string, string | undefined>;
}): void {
  if (!dryRun) readR2Config(env);
}
