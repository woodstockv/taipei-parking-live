// Supplements the repository's small worker/test/ambient.d.ts Node surface.
// Kept offline-tool-only; shared/liveStatus.ts has no Node dependency.
declare module "node:crypto" {
  interface Hash { update(bytes: Uint8Array | string): Hash; digest(encoding: "hex"): string }
  export function createHash(algorithm: "sha256"): Hash;
}
declare module "node:zlib" {
  export function gzipSync(input: Uint8Array, options: { level: number }): Uint8Array;
  export function gunzipSync(input: Uint8Array): Uint8Array;
}
declare module "node:fs" {
  export function lstatSync(path: string): { isFile(): boolean; size: number };
}
declare module "node:path" { export function resolve(...parts: string[]): string }
declare module "node:process" {
  const process: { argv: string[]; exitCode: number };
  export default process;
}
