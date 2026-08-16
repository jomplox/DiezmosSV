export async function assertStagingSmokeTarget({
  baseUrl,
  workerName,
  fetchImpl = fetch
}) {
  const response = await stagingSmokeFetch({
    baseUrl,
    path: "/api/health",
    options: { method: "GET", headers: { Accept: "application/json" } },
    fetchImpl
  });
  let health;
  try {
    health = await response.json();
  } catch {
    throw new Error("Staging deployment identity could not be verified");
  }
  if (
    !response.ok ||
    health?.appEnv !== "staging" ||
    health?.workerName !== workerName
  ) {
    throw new Error("Staging deployment identity does not match the approved target");
  }
  return health;
}

export function stagingSmokeFetch({
  baseUrl,
  path,
  options = {},
  fetchImpl = fetch
}) {
  return fetchImpl(`${baseUrl}${path}`, {
    ...options,
    redirect: "error"
  });
}
