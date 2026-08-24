import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("login step-up verification", () => {
  it("renders actionable Spanish copy and submits the one-time code without the password", async () => {
    const loginMfa = await import("../../src/client/loginMfa").catch(() => null);
    expect(loginMfa, "the login MFA UI module must exist").not.toBeNull();
    if (!loginMfa) return;

    const html = renderToStaticMarkup(createElement(loginMfa.LoginMfaStep, {
      code: "123456",
      busy: false,
      onCodeChange: vi.fn()
    }));
    expect(html).toContain("Código de verificación");
    expect(html).toContain("Ingrese el código de 6 dígitos que enviamos a su correo");
    expect(html).toContain("Vence en 10 minutos");
    expect(html).toContain("Verificar código");
    expect(html).toContain('inputMode="numeric"');

    const request = vi.fn(async () => ({
      user: { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" as const },
      token: "session-token",
      expiresAt: "2026-07-05T12:00:00.000Z"
    }));
    const result = await loginMfa.submitLoginMfa(
      {
        mfaRequired: true,
        challengeId: "challenge-id",
        continuationToken: "continuation-token",
        expiresAt: "2026-07-04T12:10:00.000Z"
      },
      " 123456 ",
      request
    );

    expect(request).toHaveBeenCalledWith("/api/auth/login/mfa", {
      method: "POST",
      body: {
        challengeId: "challenge-id",
        continuationToken: "continuation-token",
        code: "123456"
      }
    });
    expect(result).toMatchObject({ token: "session-token", user: { id: "user_operator" } });
  });
});
