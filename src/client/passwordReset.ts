import { passwordPolicyError } from "../shared/passwordPolicy";

export function resetTokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("reset")?.trim();
  return token ? token : null;
}

export function passwordResetConfirmValidationMessage(password: string, confirm: string): string {
  const policyError = passwordPolicyError(password);
  if (policyError) {
    return policyError;
  }
  if (password !== confirm) {
    return "Las contraseñas no coinciden";
  }
  return "";
}
