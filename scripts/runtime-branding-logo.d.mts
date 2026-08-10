import type { PrivateDeployConfig } from "./private-deploy-config.mjs";

export interface RuntimeBrandingLogoOptions {
  fetchImpl?: typeof fetch;
}

export function assertPrivateBrandingLogoEmbeddable(
  config: PrivateDeployConfig
): Promise<void>;

export function verifyRuntimeBrandingLogo(
  config: PrivateDeployConfig,
  options?: RuntimeBrandingLogoOptions
): Promise<{ matched: true }>;

export function migrateRuntimeBrandingLogo(
  config: PrivateDeployConfig,
  credentials: { email: string; password: string },
  options?: RuntimeBrandingLogoOptions
): Promise<{ changed: boolean }>;
