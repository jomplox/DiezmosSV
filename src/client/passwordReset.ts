import { passwordPolicyError } from "../shared/passwordPolicy";

export interface PasswordResetLocation {
  token: string | null;
  cleanSearch: string;
  cleanHash: string;
  shouldReplace: boolean;
}

export function readPasswordResetLocation(search: string, hash: string): PasswordResetLocation {
  const searchParams = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const hashParams = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const hasQueryToken = searchParams.has("reset");
  const hasFragmentToken = hashParams.has("reset");
  const fragmentToken = hashParams.get("reset")?.trim();
  const queryToken = searchParams.get("reset")?.trim();

  if (!hasQueryToken && !hasFragmentToken) {
    return { token: null, cleanSearch: search, cleanHash: hash, shouldReplace: false };
  }

  searchParams.delete("reset");
  hashParams.delete("reset");
  const cleanSearchParams = searchParams.toString();
  const cleanHashParams = hashParams.toString();
  return {
    token: fragmentToken || queryToken || null,
    cleanSearch: hasQueryToken ? (cleanSearchParams ? `?${cleanSearchParams}` : "") : search,
    cleanHash: hasFragmentToken ? (cleanHashParams ? `#${cleanHashParams}` : "") : hash,
    shouldReplace: true
  };
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
