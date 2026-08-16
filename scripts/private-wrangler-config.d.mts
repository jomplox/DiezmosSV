import type { PrivateDeployTarget } from "./private-deploy-config.mjs";

export interface PrivateWranglerTargetManifest {
  workerName: string;
  origin: string;
  resourceManifest: {
    accountId: string;
    appEnv: PrivateDeployTarget;
    d1DatabaseName: string;
    d1DatabaseId: string;
    r2BucketName: string;
    queueName: string;
    queueDlqName: string;
    workersDev: boolean;
  };
}

export interface PrivateWranglerConfigOptions {
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
}

export function resolvePrivateWranglerConfig(
  options?: PrivateWranglerConfigOptions
): string;

export function assertPrivateWranglerConfig(
  configPath: string,
  options?: Pick<PrivateWranglerConfigOptions, "repositoryRoot">
): string;

export function assertPrivateWranglerEmailBindings(rawConfig: unknown): void;

export function assertPrivateWranglerTargetManifest(
  rawConfig: unknown,
  target: PrivateDeployTarget,
  manifest: PrivateWranglerTargetManifest
): void;

export function preparePrivateWranglerConfig(
  configPath: string,
  options?: Pick<PrivateWranglerConfigOptions, "repositoryRoot"> & {
    migrationsDirOverride?: string;
  }
): {
  configPath: string;
  cleanup(): void;
};
