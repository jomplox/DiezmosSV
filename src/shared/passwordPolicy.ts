export type PasswordPolicyId = "length" | "uppercase" | "lowercase" | "number" | "symbol";

export interface PasswordPolicyRequirement {
  id: PasswordPolicyId;
  label: string;
  workerMessage: string;
  test: (password: string) => boolean;
}

export const PASSWORD_POLICY_MIN_LENGTH = 10;

export const PASSWORD_POLICY_REQUIREMENTS: PasswordPolicyRequirement[] = [
  {
    id: "length",
    label: "10+ caracteres",
    workerMessage: "La contraseña debe tener al menos 10 caracteres",
    test: (password) => password.length >= PASSWORD_POLICY_MIN_LENGTH
  },
  {
    id: "uppercase",
    label: "mayúscula",
    workerMessage: "La contraseña debe incluir una letra mayúscula",
    test: (password) => /[A-Z]/.test(password)
  },
  {
    id: "lowercase",
    label: "minúscula",
    workerMessage: "La contraseña debe incluir una letra minúscula",
    test: (password) => /[a-z]/.test(password)
  },
  {
    id: "number",
    label: "número",
    workerMessage: "La contraseña debe incluir un número",
    test: (password) => /\d/.test(password)
  },
  {
    id: "symbol",
    label: "símbolo",
    workerMessage: "La contraseña debe incluir un símbolo",
    test: (password) => /[^A-Za-z0-9]/.test(password)
  }
];

export function passwordPolicyFailures(password: string): PasswordPolicyRequirement[] {
  return PASSWORD_POLICY_REQUIREMENTS.filter((requirement) => !requirement.test(password));
}

export function passwordPolicySatisfied(password: string): boolean {
  return passwordPolicyFailures(password).length === 0;
}

export function passwordPolicyError(password: string): string {
  return passwordPolicyFailures(password).map((requirement) => requirement.workerMessage).join("; ");
}
