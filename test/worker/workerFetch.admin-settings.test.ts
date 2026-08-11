import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import {
  env,
  InMemoryD1
} from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("credential administration", () => {
  it("returns safe credential status to owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-example",
        MH_USER_TEST: "0614",
        MH_PASSWORD_TEST: "test-password",
        MH_CERT_XML_PART_1: "<CertificadoMH>",
        MH_CERT_XML_PART_2: "</CertificadoMH>",
        MH_CERT_PASSWORD: "cert-password",
        WOMPI_API_SECRET: "wompi-secret"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      credentials: {
        target: {
          appEnv: "staging",
          scriptName: "diezmossv-staging-example",
          writerConfigured: false,
          writerMissing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
        },
        groups: {
          mhTest: { ready: true },
          signer: { ready: true },
          wompi: {
            label: "Webhook entrante de Wompi",
            ready: true,
            items: [
              {
                name: "WOMPI_API_SECRET",
                label: "Firma del webhook entrante",
                configured: true
              }
            ]
          }
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("test-password");
    expect(JSON.stringify(data)).not.toContain("cert-password");
    expect(JSON.stringify(data)).not.toContain("wompi-secret");
  });

  it.each([
    ["staging", "production"],
    ["production", "test"]
  ] as const)("rejects %s credential writes for the %s-incompatible environment", async (appEnv, environment) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment, mhUser: "replacement-user" })
      }),
      env(db, {
        APP_ENV: appEnv,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "writer-token",
        CLOUDFLARE_SCRIPT_NAME: `example-worker-${appEnv}`
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits.find((row) => row.action === "CREDENTIALS_UPDATED")).toBeUndefined();
  });

  it("returns a clear error when credential update is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "test", mhUser: "0614", mhPassword: "test-password" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "credential_writer_not_configured"
    });
    expect(db.audits).toHaveLength(0);
  });

  it("lets owners bootstrap the Cloudflare writer token without echoing it", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials/writer-token", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ token: "cf-writer-token" })
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-example",
        CLOUDFLARE_API_BASE_URL: "https://cf.test"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: true,
      updated: ["CLOUDFLARE_API_TOKEN"],
      credentials: {
        target: {
          writerConfigured: true,
          writerMissing: []
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("cf-writer-token");
    expect(JSON.stringify(db.audits)).not.toContain("cf-writer-token");
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "CLOUDFLARE_WRITER_ENABLED",
      entity_id: "diezmossv-staging-example"
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cf.test/accounts/account-id/workers/scripts/diezmossv-staging-example/secrets-bulk");
    expect(init.headers).toMatchObject({ Authorization: "Bearer cf-writer-token" });
  });
});

describe("Stripe owner settings", () => {
  it("returns presence-only configuration and safe last-webhook health to owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.stripeWebhookEvents.push({
      id: "evt_private_object_id",
      event_type: "checkout.session.completed",
      livemode: 0,
      status: "PROCESSED",
      received_at: "2026-08-11T10:00:00.000Z",
      processed_at: "2026-08-11T10:00:01.000Z",
      failure_code: "private_failure_internal",
      donor_email: "donor@example.org"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/stripe", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        APP_ENV: "staging",
        STRIPE_RESTRICTED_KEY: "rk_test_private",
        STRIPE_PUBLISHABLE_KEY: "pk_test_private",
        STRIPE_WEBHOOK_SECRET: "whsec_private",
        STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_private",
        STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_private",
        STRIPE_US_LEGAL_NAME: "Private Legal Name",
        STRIPE_US_EIN: "12-3456789",
        STRIPE_US_TIME_ZONE: "America/New_York"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      stripe: {
        credentials: { ready: true },
        operational: { appEnv: "staging", mode: "Pruebas", mockMode: false },
        webhookHealth: {
          lastReceivedAt: "2026-08-11T10:00:00.000Z",
          eventType: "checkout.session.completed",
          processingStatus: "PROCESSED",
          livemodeMatches: true,
          verifiedByProcessedEvent: true
        }
      }
    });
    const serialized = JSON.stringify(data);
    for (const privateValue of [
      "rk_test_private", "pk_test_private", "whsec_private", "pmc_private", "bpc_private",
      "Private Legal Name", "12-3456789", "evt_private_object_id", "donor@example.org", "private_failure_internal"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("reports a clear no-events state and remains owner-only", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const forbidden = await worker.fetch(
      new Request("https://example.org/api/settings/stripe", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(forbidden.status).toBe(403);

    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/stripe", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    await expect(response.json()).resolves.toMatchObject({
      stripe: { webhookHealth: { state: "none", label: "Sin eventos recibidos" } }
    });
  });

  it("rejects invalid replacements before calling Cloudflare", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await worker.fetch(
        new Request("https://example.org/api/settings/stripe", {
          method: "POST",
          headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ restrictedKey: "rk_live_wrong" })
        }),
        env(db, {
          APP_ENV: "staging",
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_API_TOKEN: "writer-token",
          CLOUDFLARE_SCRIPT_NAME: "worker"
        })
      );
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes valid replacements through the bulk writer and audits names only", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await worker.fetch(
        new Request("https://example.org/api/settings/stripe", {
          method: "POST",
          headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
          body: JSON.stringify({
            restrictedKey: "rk_test_new_private",
            publishableKey: "pk_test_new_private",
            timeZone: "America/Chicago"
          })
        }),
        env(db, {
          APP_ENV: "staging",
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_API_TOKEN: "writer-token",
          CLOUDFLARE_SCRIPT_NAME: "worker"
        })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        updated: ["STRIPE_RESTRICTED_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_US_TIME_ZONE"],
        deleted: []
      });
      const audit = db.audits.find((row) => row.action === "STRIPE_CREDENTIALS_UPDATED");
      expect(JSON.parse(String(audit?.metadata_json))).toEqual({
        updated: ["STRIPE_RESTRICTED_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_US_TIME_ZONE"],
        deleted: []
      });
      expect(JSON.stringify(audit)).not.toContain("rk_test_new_private");
      expect(JSON.stringify(audit)).not.toContain("America/Chicago");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stages, promotes, and cancels webhook secrets with value-free audits", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const base = {
      APP_ENV: "staging",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "writer-token",
      CLOUDFLARE_SCRIPT_NAME: "worker",
      CLOUDFLARE_API_BASE_URL: "https://cf.test",
      STRIPE_WEBHOOK_SECRET: "whsec_active_private"
    };
    try {
      const stage = await worker.fetch(new Request("https://example.org/api/settings/stripe/webhook-secret/stage", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ webhookSecretNext: "whsec_next_private" })
      }), env(db, base));
      expect(stage.status).toBe(200);

      const promote = await worker.fetch(new Request("https://example.org/api/settings/stripe/webhook-secret/promote", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }), env(db, { ...base, STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_private" }));
      expect(promote.status).toBe(200);

      const cancel = await worker.fetch(new Request("https://example.org/api/settings/stripe/webhook-secret/cancel", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }), env(db, { ...base, STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_private" }));
      expect(cancel.status).toBe(200);

      const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).secrets);
      expect(bodies[0]).toEqual({
        STRIPE_WEBHOOK_SECRET_NEXT: { type: "secret_text", name: "STRIPE_WEBHOOK_SECRET_NEXT", text: "whsec_next_private" }
      });
      expect(bodies[1]).toEqual({
        STRIPE_WEBHOOK_SECRET: { type: "secret_text", name: "STRIPE_WEBHOOK_SECRET", text: "whsec_next_private" },
        STRIPE_WEBHOOK_SECRET_NEXT: null
      });
      expect(bodies[2]).toEqual({ STRIPE_WEBHOOK_SECRET_NEXT: null });
      expect(JSON.stringify(await stage.json())).not.toContain("whsec_next_private");
      expect(JSON.stringify(db.audits)).not.toContain("whsec_next_private");
      expect(db.audits.map((audit) => audit.action)).toEqual(expect.arrayContaining([
        "STRIPE_WEBHOOK_SECRET_STAGED",
        "STRIPE_WEBHOOK_SECRET_PROMOTED",
        "STRIPE_WEBHOOK_SECRET_CANCELED"
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves the active secret when promotion is missing or the atomic writer fails", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const base = {
      APP_ENV: "staging",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "writer-token",
      CLOUDFLARE_SCRIPT_NAME: "worker",
      STRIPE_WEBHOOK_SECRET: "whsec_active_private"
    };
    try {
      const missing = await worker.fetch(new Request("https://example.org/api/settings/stripe/webhook-secret/promote", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }), env(db, base));
      expect(missing.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();

      const noWriter = await worker.fetch(new Request("https://example.org/api/settings/stripe/webhook-secret/promote", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }), env(db, {
        APP_ENV: "staging",
        STRIPE_WEBHOOK_SECRET: "whsec_active_private",
        STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_private"
      }));
      expect(noWriter.status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();

      const failed = await worker.fetch(new Request("https://example.org/api/settings/stripe/webhook-secret/promote", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }), env(db, { ...base, STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_private" }));
      expect(failed.status).toBe(502);
      expect(JSON.stringify(await failed.json())).not.toContain("whsec_active_private");
      expect(db.audits.find((audit) => audit.action === "STRIPE_WEBHOOK_SECRET_PROMOTED")).toBeUndefined();
      const requestPatch = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).secrets;
      expect(requestPatch).toHaveProperty("STRIPE_WEBHOOK_SECRET", expect.objectContaining({ text: "whsec_next_private" }));
      expect(requestPatch).toHaveProperty("STRIPE_WEBHOOK_SECRET_NEXT", null);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Wompi notification settings", () => {
  it("lets owners configure normalized notification targets for newly generated links", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const putResponse = await worker.fetch(
      new Request("https://example.org/api/settings/wompi-notifications", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          emailsNotificacion: " TESORERIA@EXAMPLE.ORG, avisos@example.org ",
          telefonosNotificacion: " 7000-0000, +503 7123 4567 ",
          notificarTransaccionCliente: true
        })
      }),
      env(db)
    );

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      ok: true,
      wompiNotifications: {
        emailsNotificacion: "tesoreria@example.org,avisos@example.org",
        telefonosNotificacion: "70000000,+50371234567",
        notificarTransaccionCliente: true
      }
    });
    expect(db.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "wompi_notification_emails",
        value: "tesoreria@example.org,avisos@example.org",
        updated_by: "user_owner"
      }),
      expect.objectContaining({
        key: "wompi_notification_phones",
        value: "70000000,+50371234567",
        updated_by: "user_owner"
      }),
      expect.objectContaining({
        key: "wompi_notify_donor_email",
        value: "true",
        updated_by: "user_owner"
      })
    ]));
    const audit = db.audits.find((row) => row.action === "WOMPI_NOTIFICATIONS_UPDATED");
    expect(audit).toMatchObject({
      entity_type: "app_setting",
      entity_id: "wompi_notifications",
      summary: "Notificaciones de Wompi actualizadas"
    });
    expect(JSON.stringify(audit)).not.toContain("tesoreria@example.org");
    expect(JSON.stringify(audit)).not.toContain("70000000");

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/wompi-notifications", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      wompiNotifications: {
        emailsNotificacion: "tesoreria@example.org,avisos@example.org",
        telefonosNotificacion: "70000000,+50371234567",
        notificarTransaccionCliente: true
      }
    });
  });

  it.each([
    [
      "a malformed email list",
      {
        emailsNotificacion: "tesoreria@example.org,correo-invalido",
        telefonosNotificacion: "",
        notificarTransaccionCliente: false
      }
    ],
    [
      "a malformed phone list",
      {
        emailsNotificacion: "",
        telefonosNotificacion: "7000-ABCD",
        notificarTransaccionCliente: false
      }
    ],
    [
      "a non-boolean donor notification flag",
      {
        emailsNotificacion: "",
        telefonosNotificacion: "",
        notificarTransaccionCliente: "true"
      }
    ]
  ])("rejects %s without changing settings", async (_description, body) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/wompi-notifications", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_wompi_notifications"
    });
    expect(db.settings).toHaveLength(0);
  });

  it("keeps Wompi notification settings owner-only", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/wompi-notifications", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("email template settings", () => {
  it("lets owners edit subject and body templates for each email type", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          templates: {
            dteReceipt: {
              subject: "CDE {{numeroControl}} emitido",
              body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
            },
            dteInvalidation: {
              subject: "CDE {{numeroControl}} invalidado",
              body: "El CDE {{numeroControl}} quedó {{estado}}."
            }
          }
        })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      emailTemplates: {
        definitions: [
          expect.objectContaining({ type: "dteReceipt", label: "Envío de comprobante" }),
          expect.objectContaining({ type: "dteInvalidation", label: "Invalidación de comprobante" })
        ],
        placeholders: expect.arrayContaining(["{{numeroControl}}", "{{donante}}", "{{monto}}"]),
        templates: {
          dteReceipt: {
            subject: "CDE {{numeroControl}} emitido",
            body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
          },
          dteInvalidation: {
            subject: "CDE {{numeroControl}} invalidado",
            body: "El CDE {{numeroControl}} quedó {{estado}}."
          }
        }
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_templates_json",
      updated_by: "user_owner"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_TEMPLATES_UPDATED",
      entity_type: "app_setting",
      entity_id: "email_templates_json"
    }));

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      emailTemplates: {
        templates: {
          dteReceipt: { subject: "CDE {{numeroControl}} emitido" },
          dteInvalidation: { subject: "CDE {{numeroControl}} invalidado" }
        }
      }
    });
  });
});

describe("email sender setting", () => {
  it("lets owners customize and read back the visible sender name and Reply-To address", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const putResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          senderName: "  Fundación Misión ExampleOrganization  ",
          replyToAddress: "  LEGACY-CONTACT-7@EXAMPLE.COM  "
        })
      }),
      env(db, { EMAIL_FROM: "legacy-contact-4@example.com" })
    );

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      ok: true,
      emailSender: {
        senderName: "Fundación Misión ExampleOrganization",
        senderAddress: "legacy-contact-4@example.com",
        replyToAddress: "legacy-contact-7@example.com"
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_sender_name",
      value: "Fundación Misión ExampleOrganization",
      updated_by: "user_owner"
    }));
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_reply_to",
      value: "legacy-contact-7@example.com",
      updated_by: "user_owner"
    }));
    const senderAudit = db.audits.find((row) => row.action === "EMAIL_SENDER_UPDATED");
    expect(senderAudit).toMatchObject({
      action: "EMAIL_SENDER_UPDATED",
      entity_type: "app_setting",
      entity_id: "email_sender_identity"
    });
    expect(JSON.parse(String(senderAudit?.metadata_json))).toEqual({
      senderName: "Fundación Misión ExampleOrganization",
      replyToConfigured: true
    });

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { EMAIL_FROM: "legacy-contact-4@example.com" })
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      emailSender: {
        senderName: "Fundación Misión ExampleOrganization",
        senderAddress: "legacy-contact-4@example.com",
        replyToAddress: "legacy-contact-7@example.com"
      }
    });
  });

  it("allows an owner to clear Reply-To so replies use the active sender address", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.settings.push(
      { key: "email_sender_name", value: "ExamplePerson5" },
      { key: "email_reply_to", value: "legacy-contact-7@example.com" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          senderName: "ExamplePerson5",
          replyToAddress: "   "
        })
      }),
      env(db, { EMAIL_FROM: "legacy-contact-4@example.com" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      emailSender: {
        senderName: "ExamplePerson5",
        senderAddress: "legacy-contact-4@example.com",
        replyToAddress: ""
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_reply_to",
      value: ""
    }));
  });

  it("preserves Reply-To when an older client updates only the visible sender name", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.settings.push({ key: "email_reply_to", value: "legacy-contact-7@example.com" });

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ senderName: "ExamplePerson5" })
      }),
      env(db, { EMAIL_FROM: "legacy-contact-4@example.com" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      emailSender: {
        senderName: "ExamplePerson5",
        replyToAddress: "legacy-contact-7@example.com"
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_reply_to",
      value: "legacy-contact-7@example.com"
    }));
  });

  it.each([
    ["an empty name", "   "],
    ["a C0 control character", "Iglesia\r\nBcc: attacker@example.org"],
    ["a leading C0 control character", "\tIglesia"],
    ["a trailing C0 control character", "Iglesia\r"],
    ["a C1 control character", "Iglesia\u0085Bcc: attacker@example.org"],
    ["a name longer than 80 characters", "A".repeat(81)]
  ])("rejects %s in the visible sender name", async (_description, senderName) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ senderName })
      }),
      env(db, { EMAIL_FROM: "legacy-contact-4@example.com" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_email_sender"
    });
    expect(db.settings).toHaveLength(0);
  });

  it.each([
    ["an invalid address", "not-an-email"],
    ["multiple addresses", "one@example.org, two@example.org"],
    ["a header injection attempt", "replies@example.org\r\nBcc: attacker@example.org"],
    ["an address longer than 254 characters", `${"a".repeat(243)}@example.org`],
    ["a non-string value", ["replies@example.org"]]
  ])("rejects %s in Reply-To", async (_description, replyToAddress) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          senderName: "ExamplePerson5",
          replyToAddress
        })
      }),
      env(db, { EMAIL_FROM: "legacy-contact-4@example.com" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_email_sender"
    });
    expect(db.settings).toHaveLength(0);
  });

  it("uses the branding fallback and keeps the endpoint owner-only", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "branding_display_name", value: "Iglesia Central" });
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const ownerResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { EMAIL_FROM: "  legacy-contact-4@example.com  " })
    );

    await expect(ownerResponse.json()).resolves.toMatchObject({
      emailSender: {
        senderName: "Iglesia Central",
        senderAddress: "legacy-contact-4@example.com",
        replyToAddress: ""
      }
    });

    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const adminResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-sender", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(adminResponse.status).toBe(403);
  });
});

describe("alert email setting", () => {
  it("lets owners configure and read back the operational alert recipient", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const putResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org" })
      }),
      env(db)
    );

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" }));
    // The audit records THAT the recipient changed, but never the address itself — the
    // audit trail is readable by lower roles, so the OWNER-only value must not ride in.
    const audit = db.audits.find((row) => row.action === "ALERT_EMAIL_UPDATED");
    expect(audit).toMatchObject({
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado",
      metadata_json: JSON.stringify({ enabled: true })
    });

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({ alertEmail: "owner@example.org" });
  });

  it("lets owners configure multiple operational alert recipients separated by commas", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, admin@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org, admin@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org, admin@example.org", updated_by: "user_owner" }));
  });

  it("rejects malformed operational alert recipient lists", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("redacts a legacy alert-email address from the audit trail for lower roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // A row written before the redaction shipped still carries the address in both the
    // summary and metadata; the read path must scrub it for everyone.
    db.audits.push({
      id: "audit_alert_legacy",
      actor_type: "USER",
      actor_id: "user_owner",
      action: "ALERT_EMAIL_UPDATED",
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado a owner@example.org",
      metadata_json: JSON.stringify({ alertEmail: "owner@example.org" }),
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const scopedResponse = await worker.fetch(
      new Request("https://example.org/api/audit?entityType=app_setting&entityId=alert_email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(scopedResponse.status).toBe(200);
    const scopedBody = (await scopedResponse.json()) as { audit: Array<{ summary?: string; metadata_json?: string }> };
    expect(JSON.stringify(scopedBody.audit)).not.toContain("owner@example.org");
    expect(scopedBody.audit[0]).toMatchObject({
      summary: "Correo de alertas actualizado",
      metadata_json: "{}"
    });

    // The general (keyset-paginated) audit trail is the primary VIEWER surface and must
    // scrub the legacy address too.
    const generalResponse = await worker.fetch(
      new Request("https://example.org/api/audit", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(generalResponse.status).toBe(200);
    const generalBody = (await generalResponse.json()) as { audit: Array<Record<string, unknown>> };
    expect(JSON.stringify(generalBody.audit)).not.toContain("owner@example.org");
  });

  it("allows clearing the alert email to disable alerting", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.settings.push({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" });

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "" });
  });

  it("rejects a malformed alert email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});
