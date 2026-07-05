export interface AuthBootstrapStatus {
  bootstrapAvailable: boolean;
}

export function shouldShowBootstrapMode(status: AuthBootstrapStatus | null): boolean {
  return status?.bootstrapAvailable === true;
}
