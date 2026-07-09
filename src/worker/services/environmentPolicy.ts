import type { Ambiente, Env } from "../types";

export type DeploymentAppEnvironment = "local" | "staging" | "production" | "unknown";

export interface DeploymentEnvironmentPolicy {
  appEnv: DeploymentAppEnvironment;
  allowedAmbiente: Ambiente | null;
  directGenerationAllowed: boolean;
}

export class EnvironmentNotAllowedError extends Error {
  readonly code = "environment_not_allowed";

  constructor(
    readonly requestedAmbiente: Ambiente,
    readonly policy: DeploymentEnvironmentPolicy
  ) {
    super(
      policy.allowedAmbiente
        ? `El despliegue ${policy.appEnv} solo permite el ambiente ${policy.allowedAmbiente}.`
        : "Este despliegue no tiene habilitada la emisión fiscal."
    );
    this.name = "EnvironmentNotAllowedError";
  }
}

export function deploymentEnvironmentPolicy(env: Pick<Env, "APP_ENV">): DeploymentEnvironmentPolicy {
  const normalized = env.APP_ENV?.trim().toLowerCase();
  if (normalized === "local") {
    return { appEnv: "local", allowedAmbiente: "00", directGenerationAllowed: true };
  }
  if (normalized === "staging") {
    return { appEnv: "staging", allowedAmbiente: "00", directGenerationAllowed: true };
  }
  if (normalized === "production") {
    return { appEnv: "production", allowedAmbiente: "01", directGenerationAllowed: false };
  }
  return { appEnv: "unknown", allowedAmbiente: null, directGenerationAllowed: false };
}

export function assertDeploymentAllowsAmbiente(env: Pick<Env, "APP_ENV">, ambiente: Ambiente): void {
  const policy = deploymentEnvironmentPolicy(env);
  if (policy.allowedAmbiente !== ambiente) {
    throw new EnvironmentNotAllowedError(ambiente, policy);
  }
}
