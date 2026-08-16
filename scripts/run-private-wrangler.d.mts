export interface PrivateWranglerRunOptions {
  capture?: boolean;
}

export interface PrivateWranglerRunner {
  configPath: string;
  run(args: string[], options?: PrivateWranglerRunOptions): Promise<string>;
  terminate(signal: NodeJS.Signals): void;
  cleanup(): void;
}

export function createSignalCleanupHandler(options: {
  cleanup(): void;
  terminate(signal: NodeJS.Signals): void;
  exit(code: number): void;
}): (signal: NodeJS.Signals) => void;

export function createPrivateWranglerRunner(options?: {
  repositoryRoot?: string;
  env?: Record<string, string | undefined>;
  configPath?: string;
  migrationsDirOverride?: string;
  spawnImpl?: typeof import("node:child_process").spawn;
  assertProvenanceImpl?: typeof import(
    "./assert-release-provenance.mjs"
  ).assertReleaseProvenance;
}): PrivateWranglerRunner;

export function releaseTargetForWranglerArgs(
  args: string[]
): "staging" | "production" | null;
