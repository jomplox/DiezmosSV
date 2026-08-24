import { KeyRound } from "lucide-react";
import type { User } from "./types";

export interface LoginMfaChallenge {
  mfaRequired: true;
  challengeId: string;
  continuationToken: string;
  expiresAt: string;
}

export interface LoginSessionResult {
  user: User;
  token: string;
  expiresAt: string;
}

interface LoginMfaRequestOptions {
  method: "POST";
  body: {
    challengeId: string;
    continuationToken: string;
    code: string;
  };
}

export async function submitLoginMfa(
  challenge: LoginMfaChallenge,
  code: string,
  request: (path: string, options: LoginMfaRequestOptions) => Promise<LoginSessionResult>
): Promise<LoginSessionResult> {
  return request("/api/auth/login/mfa", {
    method: "POST",
    body: {
      challengeId: challenge.challengeId,
      continuationToken: challenge.continuationToken,
      code: code.trim()
    }
  });
}

export function LoginMfaStep({
  code,
  busy,
  onCodeChange
}: {
  code: string;
  busy: boolean;
  onCodeChange: (code: string) => void;
}) {
  return (
    <>
      <p className="auth-hint">
        Ingrese el código de 6 dígitos que enviamos a su correo. Vence en 10 minutos.
      </p>
      <input
        value={code}
        onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="Código de verificación"
        aria-label="Código de verificación"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
      />
      <button className="primary" type="submit" disabled={busy || !/^\d{6}$/.test(code)}>
        <KeyRound size={16} />
        {busy ? "Verificando" : "Verificar código"}
      </button>
    </>
  );
}
