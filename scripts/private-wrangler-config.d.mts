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

export function preparePrivateWranglerConfig(
  configPath: string,
  options?: Pick<PrivateWranglerConfigOptions, "repositoryRoot"> & {
    migrationsDirOverride?: string;
  }
): {
  configPath: string;
  cleanup(): void;
};
