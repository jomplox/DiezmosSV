export interface StagingSmokeFetchOptions {
  baseUrl: string;
  path: string;
  options?: RequestInit;
  fetchImpl?: typeof fetch;
}

export function stagingSmokeFetch(
  options: StagingSmokeFetchOptions
): Promise<Response>;

export function assertStagingSmokeTarget(options: {
  baseUrl: string;
  workerName: string;
  fetchImpl?: typeof fetch;
}): Promise<{ appEnv: "staging"; workerName: string }>;
