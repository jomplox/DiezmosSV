export type PrivateBuildTarget = "staging" | "production";

export type ReleaseProvenanceAssertion = typeof import(
  "./assert-release-provenance.mjs"
).assertReleaseProvenance;

export function runPrivateBuild(options: {
  target: PrivateBuildTarget;
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
  spawnImpl?: typeof import("node:child_process").spawn;
  platform?: NodeJS.Platform;
  assertProvenanceImpl?: ReleaseProvenanceAssertion;
}): Promise<number>;
