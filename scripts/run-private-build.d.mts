export type PrivateBuildTarget = "staging" | "production";

export function runPrivateBuild(options: {
  target: PrivateBuildTarget;
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
  spawnImpl?: typeof import("node:child_process").spawn;
}): Promise<number>;
