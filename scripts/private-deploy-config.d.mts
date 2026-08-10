export type PrivateDeployTarget = "staging" | "production";

export interface PrivateDeployConfig {
  target: PrivateDeployTarget;
  campaign: string;
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

export function loadOperatorCredentials(options: {
  target: PrivateDeployTarget;
  env?: Record<string, string | undefined>;
  repositoryRoot?: string;
}): { email: string; password: string };
