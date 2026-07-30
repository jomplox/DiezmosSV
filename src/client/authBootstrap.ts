export interface AuthBootstrapStatus {
  bootstrapAvailable: boolean;
}

export async function resolveAuthBootstrapStatus(
  request: () => Promise<AuthBootstrapStatus>
): Promise<AuthBootstrapStatus> {
  try {
    return await request();
  } catch {
    try {
      return await request();
    } catch {
      return { bootstrapAvailable: false };
    }
  }
}

export function shouldShowBootstrapMode(status: AuthBootstrapStatus | null): boolean {
  return status?.bootstrapAvailable === true;
}
