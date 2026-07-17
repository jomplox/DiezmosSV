import { afterEach, describe, expect, it, vi } from "vitest";
import { sendOperationalAlert } from "../../src/worker/services/alerts";
import { Repository } from "../../src/worker/storage/repository";
import type { Env } from "../../src/worker/types";

describe("operational alert dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an alert email to the configured recipient with kind, title, and detail", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: Array<{ to: string; subject: string; text?: string; html?: string }> = [];
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message as { to: string; subject: string; text?: string; html?: string });
          return { messageId: "alert-1" };
        }
      } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "El documento dte_1 falló: MH no disponible",
      entityType: "dte_document",
      entityId: "dte_1",
      incidentId: "attempt_1"
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.org");
    expect(sent[0].subject).toContain("Fallo al emitir DTE");
    expect(sent[0].html).toContain("El documento dte_1 falló: MH no disponible");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:DTE_FAILED", entity_type: "dte_document", entity_id: "dte_1" })
    );
  });

  it("sends operational alerts to every comma-separated recipient", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org, admin@example.org" });
    const sent: Array<{ to: string; subject: string }> = [];
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message as { to: string; subject: string });
          return { messageId: `alert-${sent.length}` };
        }
      } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "El documento dte_multi falló",
      entityType: "dte_document",
      entityId: "dte_multi",
      incidentId: "attempt_multi"
    });

    expect(sent.map((message) => message.to)).toEqual(["owner@example.org", "admin@example.org"]);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:DTE_FAILED")).toHaveLength(1);
  });

  it("uses the configured APP_ORIGIN in the alert email body", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: Array<{ html?: string }> = [];
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      APP_ORIGIN: "https://worker.example.invalid",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message as { html?: string });
          return { messageId: "alert-origin" };
        }
      } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "detalle",
      entityType: "dte_document",
      entityId: "dte_origin",
      incidentId: "attempt_origin"
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("https://worker.example.invalid");
  });

  it("does nothing when alert_email is not configured", async () => {
    const db = new InMemoryAlertD1();
    const sent: unknown[] = [];
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "x" }; } } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "detalle",
      entityType: "dte_document",
      entityId: "dte_2",
      incidentId: "attempt_2"
    });

    expect(sent).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("suppresses a second alert for the same entity and kind", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "x" }; } } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);
    const alert = {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "detalle",
      entityType: "dte_document",
      entityId: "dte_3",
      incidentId: "attempt_3"
    };

    await sendOperationalAlert(env, repo, alert);
    await sendOperationalAlert(env, repo, alert);

    expect(sent).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:DTE_FAILED")).toHaveLength(1);
  });

  it("sends a new alert when the same entity has a different incident", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "x" }; } } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);
    const alert = {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "detalle",
      entityType: "dte_document",
      entityId: "dte_repeated"
    };

    await sendOperationalAlert(env, repo, { ...alert, incidentId: "attempt_first" });
    await sendOperationalAlert(env, repo, { ...alert, incidentId: "attempt_second" });

    expect(sent).toHaveLength(2);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:DTE_FAILED")).toHaveLength(2);
  });

  it("sends the independent Slack webhook even when the alert email fails", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      APP_ORIGIN: "https://admin.example.test",
      ALERT_WEBHOOK_URL: "https://hooks.example.test/alerts",
      ALERT_WEBHOOK_KIND: "slack",
      EMAIL: { send: async () => { throw new Error("email provider unavailable"); } } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "EMAIL_FAILED",
      title: "Fallo al enviar comprobante",
      detail: "detalle seguro",
      entityType: "dte_document",
      entityId: "dte_webhook",
      incidentId: "delivery_claim_1"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await webhookBody(fetchMock)).toEqual({
      text: [
        "Fallo al enviar comprobante",
        "detalle seguro",
        "Tipo de alerta: EMAIL_FAILED",
        "Entidad: dte_document",
        "ID: dte_webhook",
        "Panel: https://admin.example.test/"
      ].join("\n\n")
    });
    expect(auditChannels(db, "ALERT_FAILED:EMAIL_FAILED")).toEqual(["email"]);
    expect(auditChannels(db, "ALERT_SENT:EMAIL_FAILED")).toEqual(["webhook"]);
  });

  it("sends the alert email even when the independent webhook fails", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      APP_ORIGIN: "https://admin.example.test",
      ALERT_WEBHOOK_URL: "https://hooks.example.test/alerts",
      ALERT_WEBHOOK_KIND: "discord",
      EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "email-ok" }; } } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "EMAIL_FAILED",
      title: "Fallo al enviar comprobante",
      detail: "detalle seguro",
      entityType: "dte_document",
      entityId: "dte_email",
      incidentId: "delivery_claim_2"
    });

    expect(sent).toHaveLength(1);
    expect(auditChannels(db, "ALERT_SENT:EMAIL_FAILED")).toEqual(["email"]);
    expect(auditChannels(db, "ALERT_FAILED:EMAIL_FAILED")).toEqual(["webhook"]);
  });

  it("sends a Discord webhook when no alert email recipient is configured", async () => {
    const db = new InMemoryAlertD1();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      APP_ORIGIN: "https://admin.example.test",
      ALERT_WEBHOOK_URL: "https://hooks.example.test/alerts",
      ALERT_WEBHOOK_KIND: "discord"
    } as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "MH_UNAVAILABLE",
      title: "Ministerio de Hacienda no disponible",
      detail: "Hay comprobantes pendientes.",
      entityType: "dte_document",
      entityId: "dte_oldest",
      incidentId: "deferred_2026-07-17"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await webhookBody(fetchMock)).toEqual({
      content: [
        "Ministerio de Hacienda no disponible",
        "Hay comprobantes pendientes.",
        "Tipo de alerta: MH_UNAVAILABLE",
        "Entidad: dte_document",
        "ID: dte_oldest",
        "Panel: https://admin.example.test/"
      ].join("\n\n")
    });
    expect(auditChannels(db, "ALERT_SENT:MH_UNAVAILABLE")).toEqual(["webhook"]);
  });

  it("deduplicates each alert channel by incident", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ALERT_WEBHOOK_URL: "https://hooks.example.test/alerts",
      ALERT_WEBHOOK_KIND: "slack",
      EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "ok" }; } } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);
    const alert = {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "detalle",
      entityType: "dte_document",
      entityId: "dte_channels",
      incidentId: "issuance_attempt_channels"
    };

    await sendOperationalAlert(env, repo, alert);
    await sendOperationalAlert(env, repo, alert);

    expect(sent).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auditChannels(db, "ALERT_SENT:DTE_FAILED")).toEqual(["email", "webhook"]);
  });

  it.each([
    ["non-HTTPS", "http://hooks.example.test/alerts", "slack"],
    ["credential-bearing", "https://user:secret@hooks.example.test/alerts", "discord"],
    ["malformed URL", "not-a-webhook-url", "slack"],
    ["unsupported kind", "https://hooks.example.test/alerts", "teams"]
  ])("records %s webhook configuration as a channel failure", async (_label, webhookUrl, webhookKind) => {
    const db = new InMemoryAlertD1();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      ALERT_WEBHOOK_URL: webhookUrl,
      ALERT_WEBHOOK_KIND: webhookKind
    } as unknown as Env;
    const repo = new Repository(env.DB);

    await sendOperationalAlert(env, repo, {
      kind: "DTE_FAILED",
      title: "Fallo al emitir DTE",
      detail: "detalle",
      entityType: "dte_document",
      entityId: "dte_bad_webhook",
      incidentId: `incident_${_label}`
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditChannels(db, "ALERT_FAILED:DTE_FAILED")).toEqual(["webhook"]);
    expect(String(db.audits[0]?.summary)).not.toContain(webhookUrl);
  });

  it("records ALERT_FAILED and does not throw when the email provider fails", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async () => {
          throw new Error("destination address is not a verified address");
        }
      } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await expect(
      sendOperationalAlert(env, repo, {
        kind: "WOMPI_EVENT_STALLED",
        title: "Evento Wompi estancado",
        detail: "detalle",
        entityType: "wompi_event",
        entityId: "wompi_1",
        incidentId: "wompi_attempt_1"
      })
    ).resolves.toBeUndefined();

    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_1" })
    );
  });

  it("never throws even if recording the ALERT_FAILED audit also fails", async () => {
    const db = new InMemoryAlertD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    let auditAttempts = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes("INSERT INTO audit_logs")) {
        auditAttempts += 1;
        if (auditAttempts === 1) {
          throw new Error("db unavailable");
        }
      }
      return originalPrepare(sql);
    };
    const env = {
      DB: db as unknown as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: {} as Fetcher,
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async () => {
          throw new Error("destination address is not a verified address");
        }
      } as SendEmail
    } as Env;
    const repo = new Repository(env.DB);

    await expect(
      sendOperationalAlert(env, repo, {
        kind: "WOMPI_EVENT_STALLED",
        title: "Evento Wompi estancado",
        detail: "detalle",
        entityType: "wompi_event",
        entityId: "wompi_2",
        incidentId: "wompi_attempt_2"
      })
    ).resolves.toBeUndefined();
  });
});

async function webhookBody(fetchMock: ReturnType<typeof vi.fn>): Promise<unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? ""));
}

function auditChannels(db: InMemoryAlertD1, action: string): string[] {
  return db.audits
    .filter((audit) => audit.action === action)
    .map((audit) => JSON.parse(String(audit.metadata_json ?? "{}")).channel)
    .sort();
}

class InMemoryAlertD1 {
  readonly settings: Array<Record<string, unknown>> = [];
  readonly audits: Array<Record<string, unknown>> = [];

  prepare(sql: string): AlertStatement {
    return new AlertStatement(this, sql);
  }
}

class AlertStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: InMemoryAlertD1,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT value FROM app_settings WHERE key = ?")) {
      return (this.db.settings.find((setting) => setting.key === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT 1 AS found") && this.sql.includes("json_extract(metadata_json")) {
      const [action, entityType, entityId, incidentId, channel] = this.args.map(String);
      const found = this.db.audits.some((audit) => {
        const metadata = JSON.parse(String(audit.metadata_json ?? "{}")) as Record<string, unknown>;
        return audit.action === action
          && audit.entity_type === entityType
          && audit.entity_id === entityId
          && metadata.incidentId === incidentId
          && metadata.channel === channel;
      });
      return (found ? { found: 1 } : null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs")) {
      const [action, entityId] = this.args.map(String);
      return { count: this.db.audits.filter((audit) => audit.action === action && audit.entity_id === entityId).length } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    if (this.sql.includes("INSERT INTO app_settings")) {
      const [key, value] = this.args;
      const setting = this.db.settings.find((row) => row.key === key);
      if (setting) {
        setting.value = value;
      } else {
        this.db.settings.push({ key, value });
      }
    }
    if (this.sql.includes("INSERT INTO audit_logs")) {
      const [id, actorType, actorId, action, entityType, entityId, summary, metadataJson] = this.args;
      this.db.audits.push({
        id,
        actor_type: actorType,
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        summary,
        metadata_json: metadataJson,
        created_at: "2026-07-04T00:00:00.000Z"
      });
    }
    return {};
  }
}
