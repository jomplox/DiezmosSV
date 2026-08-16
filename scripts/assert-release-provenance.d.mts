import type {
  PrivateDeployConfig,
  PrivateDeployTarget
} from "./private-deploy-config.mjs";

export type ReleaseCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    stdio: ["ignore", "pipe", "pipe"];
  }
) => string | Buffer<ArrayBufferLike>;

export interface ReleaseProvenanceOptions {
  target: PrivateDeployTarget;
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
  selectedConfig?: PrivateDeployConfig;
  otherConfig?: PrivateDeployConfig;
  rawWranglerConfig?: unknown;
  execFileSyncImpl?: ReleaseCommandRunner;
}

export function assertReleaseProvenance(
  options: ReleaseProvenanceOptions
): { sha: string };
