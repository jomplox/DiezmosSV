import { passwordPolicyError } from "../shared/passwordPolicy";

export function resetTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get("reset")?.trim();
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
