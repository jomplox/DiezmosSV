import { describe, expect, it } from "vitest";
import { sendOperationalAlert } from "../../src/worker/services/alerts";
import { Repository } from "../../src/worker/storage/repository";
import type { Env } from "../../src/worker/types";

describe("operational alert dispatch", () => {
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
      entityId: "dte_1"
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.org");
    expect(sent[0].subject).toContain("Fallo al emitir DTE");
    expect(sent[0].html).toContain("El documento dte_1 falló: MH no disponible");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:DTE_FAILED", entity_type: "dte_document", entity_id: "dte_1" })
    );
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
      entityId: "dte_origin"
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
      entityId: "dte_2"
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
      entityId: "dte_3"
    };

    await sendOperationalAlert(env, repo, alert);
    await sendOperationalAlert(env, repo, alert);

    expect(sent).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:DTE_FAILED")).toHaveLength(1);
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
        entityId: "wompi_1"
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
        entityId: "wompi_2"
      })
    ).resolves.toBeUndefined();
  });
});

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
