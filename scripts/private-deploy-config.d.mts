export type PrivateDeployTarget = "staging" | "production";

export interface PrivateDeployConfig {
  target: PrivateDeployTarget;
  workerName: string;
  githubRepository: string;
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
  campaign: string;
  givebutterFunds: { tithe: string; offering: string } | null;
  origin: string;
  donorLogo: {
    path: string;
    bytes: Buffer<ArrayBufferLike>;
    contentType: "image/png" | "image/jpeg";
    sha256: string;
  };
}

export function loadPrivateDeployConfig(options: {
  target: PrivateDeployTarget;
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
}): PrivateDeployConfig;

export function assertDistinctDeploymentResources(
  staging: PrivateDeployConfig,
  production: PrivateDeployConfig
): void;

export function loadOperatorCredentials(options: {
  target: PrivateDeployTarget;
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
}): { email: string; password: string };
