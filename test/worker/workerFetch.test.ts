import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import type { DteDocumentRecord, Env } from "../../src/worker/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Worker fetch error handling", () => {
  it("converts async API auth errors into JSON responses", async () => {
    const response = await worker.fetch(new Request("https://example.org/api/documents"), {
      DB: {} as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher
    } as Env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "auth_error" });
  });
});

describe("owner bootstrap", () => {
  it("rejects first-owner bootstrap when the setup token is missing", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest(),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("rejects first-owner bootstrap when the setup token is wrong", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: "wrong-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("creates the first owner when the setup token matches", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: "setup-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        email: "legacy-contact-3@example.com",
        name: "Example Person",
        role: "OWNER"
      }
    });
    expect(db.users).toHaveLength(1);
    expect(db.users[0].role).toBe("OWNER");
  });
});

describe("document email resend", () => {
  it("sends receipts through the Cloudflare Email Service binding", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-1" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      from: "legacy-contact-6@example.com",
      to: "legacy-contact-2@example.com",
      subject: "Comprobante DTE por donacion",
      text: expect.stringContaining("DTE-15-M001P004-000000000000009"),
      attachments: [
        expect.objectContaining({
          filename: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }),
        expect.objectContaining({
          filename: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4.json",
          type: "application/json",
          disposition: "attachment"
        })
      ]
    });
    const sentMessage = sentMessages[0] as { attachments: Array<{ content: unknown }> };
    expect(sentMessage.attachments[0].content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode((sentMessage.attachments[0].content as Uint8Array).slice(0, 4))).toBe("%PDF");
    expect(sentMessage.attachments[1].content).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(sentMessage.attachments[1].content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: JSON.stringify({ provider: "cloudflare-email", messageId: "cf-email-1" })
    }));
  });

  it("attaches valid DTE JSON even when the document has a signed JWS", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push({
      ...testDocument(),
      signed_jws: "eyJhbGciOiJSUzUxMiJ9.eyJyZWNlcHRvciI6e319fQ.signature"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-1" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    const sentMessage = sentMessages[0] as { attachments: Array<{ filename: string; content: unknown }> };
    const jsonAttachment = sentMessage.attachments.find((attachment) => attachment.filename.endsWith(".json"));
    expect(jsonAttachment?.content).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(jsonAttachment?.content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
  });

  it("falls back to an HTTP email provider when Cloudflare requires verified destinations", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_http_1" }), { status: 202 })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL_API_URL: "https://mail.example/send",
        EMAIL_API_KEY: "email-api-key",
        EMAIL: {
          send: async () => {
            throw new Error("destination address is not a verified address");
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(providerFetch).toHaveBeenCalledWith("https://mail.example/send", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer email-api-key",
        "Content-Type": "application/json"
      })
    }));
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: JSON.stringify({
        provider: "http-email",
        fallbackFrom: "cloudflare-email",
        cloudflareError: "destination address is not a verified address",
        response: { id: "email_http_1" }
      })
    }));
  });

  it("records and returns email failures when the provider is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "email_send_failed",
      message: expect.stringContaining("Cloudflare EMAIL binding")
    });
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED"
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_RESEND_FAILED", entity_id: "doc_1" }));
  });
});

describe("F960 CSV export", () => {
  it("returns accepted CDEs for a date range in the real F960 semicolon format", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument(),
      {
        ...testDocument(),
        id: "doc_may",
        codigo_generacion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000008",
        issued_at: "2026-05-31T23:30:00.000Z",
        accepted_at: "2026-05-31T23:31:00.000Z",
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: { nombre: "Outside Range", correo: "outside@example.org", tipoDocumento: "13", numDocumento: "100000043" },
          resumen: { valorTotal: 50 },
          identificacion: { fecEmi: "2026-05-31", horEmi: "17:30:00", codigoGeneracion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B" }
        })
      },
      {
        ...testDocument(),
        id: "doc_failed",
        codigo_generacion: "0E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000010",
        status: "FAILED",
        sello_recibido: null
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-20260601-20260630.csv"');
    await expect(response.text()).resolves.toBe(
      "1;;Example Person;9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;100000001;062026\r\n"
    );
  });

  it("returns preview rows for the selected date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rowCount: 1,
      amountTotal: "100.00",
      rows: [
        {
          nit: "",
          nombre: "Example Person",
          codigoActividad: "9300",
          tipoDonacion: "4",
          sello: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
          codigoGeneracion: "6CAE5F7EA59045738EF2FE48B14796C4",
          monto: "100.00",
          dui: "100000001",
          periodo: "062026"
        }
      ]
    });
  });

  it("returns an Excel inspection workbook with headers for the selected rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.xlsx?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-inspeccion-20260601-20260630.xlsx"');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK");
    const workbookText = new TextDecoder().decode(bytes);
    expect(workbookText).toContain("Nombre donante");
    expect(workbookText).toContain("Example Person");
    expect(workbookText).toContain("Codigo generacion");
  });

  it("requires an admin role", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("advanced CDE generation", () => {
  it("stores a schema-valid advanced CDE draft and queues it for transmission", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: advancedCdeDraft() })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000001",
      tipoOperacion: 1,
      tipoMoneda: "USD"
    });
    expect(generated.identificacion.codigoGeneracion).toMatch(/^[A-F0-9-]{36}$/);
    expect(generated.receptor.nombre).toBe("Example Person Advanced");
    expect(generated.cuerpoDocumento[0].descripcion).toBe("Diezmo avanzado");
    expect(db.documents[0]).toMatchObject({
      donor_email: "advanced@example.org",
      donor_name: "Example Person Advanced",
      amount_cents: 12345,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_CREATED", entity_type: "dte_document" }));
  });

  it("rejects an advanced CDE draft that does not match the CDE schema", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: { receptor: { nombre: "Sin estructura" } } })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

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
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        MH_USER_TEST: "0614",
        MH_PASSWORD_TEST: "test-password",
        MH_CERT_XML_PART_1: "<CertificadoMH>",
        MH_CERT_XML_PART_2: "</CertificadoMH>",
        MH_CERT_PASSWORD: "cert-password"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      credentials: {
        target: {
          appEnv: "staging",
          scriptName: "diezmossv-staging-resource-example",
          writerConfigured: false
        },
        groups: {
          mhTest: { ready: true },
          signer: { ready: true }
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("test-password");
    expect(JSON.stringify(data)).not.toContain("cert-password");
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
});

function bootstrapRequest(options: { token?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token) {
    headers.set("X-Bootstrap-Owner-Token", options.token);
  }
  return new Request("https://example.org/api/auth/bootstrap-owner", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "legacy-contact-3@example.com",
      name: "Example Person",
      password: "long-enough-password"
    })
  });
}

function env(db: InMemoryD1, values: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ISSUANCE_QUEUE: { send: async () => undefined } as unknown as Queue,
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    ...values
  };
}

class InMemoryD1 {
  readonly users: Array<Record<string, string>> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly documents: DteDocumentRecord[] = [];
  readonly emailDeliveries: Array<Record<string, unknown>> = [];
  readonly wompiEvents: Array<Record<string, unknown>> = [];
  nextSequence = 1;
  sessionUser: Record<string, string> | null = null;

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }
}

class Statement {
  private args: unknown[] = [];

  constructor(
    private readonly db: InMemoryD1,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM sessions") && this.sql.includes("JOIN users")) {
      return this.db.sessionUser as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM users")) {
      return { count: this.db.users.length } as T;
    }
    if (this.sql.includes("FROM users WHERE id = ?")) {
      return (this.db.users.find((user) => user.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM dte_documents WHERE id = ?")) {
      return (this.db.documents.find((document) => document.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE id = ?")) {
      return (this.db.wompiEvents.find((event) => event.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE transaction_id = ?")) {
      return (this.db.wompiEvents.find((event) => event.transaction_id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("UPDATE document_sequences")) {
      return { value: this.db.nextSequence++ } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM dte_documents")) {
      let documents = [...this.db.documents];
      if (this.sql.includes("status = ?")) {
        const status = String(this.args[0]);
        documents = documents.filter((document) => document.status === status);
      }
      if (this.sql.includes("status = 'ACCEPTED'")) {
        documents = documents.filter((document) => document.status === "ACCEPTED");
      }
      if (this.sql.includes("sello_recibido IS NOT NULL")) {
        documents = documents.filter((document) => document.sello_recibido !== null);
      }
      if (this.sql.includes("issued_at >= ?") && this.sql.includes("issued_at < ?")) {
        const start = String(this.args[1]);
        const end = String(this.args[2]);
        documents = documents.filter((document) => document.issued_at >= start && document.issued_at < end);
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at));
      return { results: documents as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    if (this.sql.includes("INSERT INTO users")) {
      const [id, email, name, role, passwordHash, passwordSalt] = this.args.map(String);
      this.db.users.push({
        id,
        email,
        name,
        role,
        password_hash: passwordHash,
        password_salt: passwordSalt,
        disabled_at: ""
      });
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
        metadata_json: metadataJson
      });
    }
    if (this.sql.includes("INSERT INTO email_deliveries")) {
      const [id, documentId, toEmail, status, providerResponseJson, sentAt] = this.args;
      this.db.emailDeliveries.push({
        id,
        document_id: documentId,
        to_email: toEmail,
        status,
        provider_response_json: providerResponseJson,
        sent_at: sentAt
      });
    }
    if (this.sql.includes("INSERT INTO wompi_events")) {
      const [id, transactionId, environment, result, amountCents, donorEmail, donorName, rawBody, headersJson] = this.args;
      this.db.wompiEvents.push({
        id,
        transaction_id: transactionId,
        environment,
        result,
        amount_cents: amountCents,
        donor_email: donorEmail,
        donor_name: donorName,
        raw_body: rawBody,
        headers_json: headersJson,
        received_at: "2026-06-26T01:46:47.015Z",
        processed_at: null,
        created_document_id: null
      });
    }
    if (this.sql.includes("INSERT INTO dte_documents")) {
      const [id, wompiEventId, environment, codigoGeneracion, numeroControl, status, plainJson, donorEmail, donorName, amountCents, issuedAt, contingencyPeriodId] = this.args;
      this.db.documents.push({
        id: String(id),
        wompi_event_id: String(wompiEventId),
        tipo_dte: "15",
        environment: environment === "01" ? "01" : "00",
        codigo_generacion: String(codigoGeneracion),
        numero_control: String(numeroControl),
        status: String(status),
        plain_json: String(plainJson),
        signed_jws: null,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        donor_email: donorEmail === null ? null : String(donorEmail),
        donor_name: donorName === null ? null : String(donorName),
        amount_cents: Number(amountCents),
        issued_at: String(issuedAt),
        accepted_at: null,
        contingency_period_id: contingencyPeriodId === null ? null : String(contingencyPeriodId),
        created_at: String(issuedAt),
        updated_at: String(issuedAt)
      });
    }
    if (this.sql.includes("UPDATE wompi_events SET created_document_id")) {
      const [documentId, processedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      if (event) {
        event.created_document_id = documentId;
        event.processed_at = processedAt;
      }
    }
    return {};
  }
}

function testDocument(): DteDocumentRecord {
  return {
    id: "doc_1",
    wompi_event_id: "wompi_1",
    tipo_dte: "15",
    environment: "00",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: JSON.stringify({
      emisor: { nombre: "ExamplePerson1" },
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
    }),
    signed_jws: null,
    sello_recibido: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "legacy-contact-2@example.com",
    donor_name: "Example Person",
    amount_cents: 10000,
    issued_at: "2026-06-26T01:46:47.015Z",
    accepted_at: "2026-06-26T01:46:48.000Z",
    contingency_period_id: null,
    created_at: "2026-06-26T01:46:47.015Z",
    updated_at: "2026-06-26T01:46:48.000Z"
  };
}

function advancedCdeDraft(): Record<string, unknown> {
  return {
    identificacion: {
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000999",
      codigoGeneracion: "11111111-1111-4111-8111-111111111111",
      tipoModelo: 1,
      tipoOperacion: 1,
      fecEmi: "2026-06-26",
      horEmi: "09:00:00",
      tipoMoneda: "USD"
    },
    emisor: {
      tipoDocumento: "36",
      numDocumento: "10000003520015",
      nrc: "2400001",
      nombre: "MISION EXAMPLEORGANIZATION",
      codActividad: "94910",
      descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
      nombreComercial: "MISION EXAMPLEORGANIZATION",
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
      },
      telefono: "70000002",
      correo: "legacy-contact-4@example.com",
      codEstable: "0002",
      codPuntoVenta: "0002"
    },
    receptor: {
      tipoDocumento: "13",
      numDocumento: "100000001",
      nrc: null,
      nombre: "Example Person Advanced",
      codActividad: null,
      descActividad: null,
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "SAN SALVADOR"
      },
      telefono: "70000001",
      correo: "advanced@example.org",
      codDomiciliado: 1,
      codPais: "SV"
    },
    otrosDocumentos: [
      {
        codDocAsociado: 1,
        descDocumento: "Referencia avanzada",
        detalleDocumento: "ADVANCED-TEST"
      }
    ],
    cuerpoDocumento: [
      {
        numItem: 1,
        tipoDonacion: 4,
        cantidad: 1,
        codigo: "DIEZMO",
        uniMedida: 99,
        descripcion: "Diezmo avanzado",
        tipoDepreciacion: 0,
        valorUni: 123.45,
        valor: 123.45
      }
    ],
    resumen: {
      valorTotal: 123.45,
      totalLetras: null,
      pagos: [
        {
          codigo: "01",
          montoPago: 123.45,
          referencia: "ADVANCED"
        }
      ]
    },
    apendice: [
      { campo: "Origen", etiqueta: "Origen", valor: "DTE avanzado" }
    ]
  };
}

function emisorConfig() {
  return {
    tipoDocumento: "36",
    numDocumento: "10000003520015",
    nrc: "2400001",
    nombre: "MISION EXAMPLEORGANIZATION",
    codActividad: "94910",
    descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
    nombreComercial: "MISION EXAMPLEORGANIZATION",
    direccion: {
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
    },
    telefono: "70000002",
    correo: "legacy-contact-4@example.com",
    codEstable: "0002",
    codEstableMH: "M001",
    codPuntoVenta: "0002",
    codPuntoVentaMH: "P004",
    controlPrefix: "M001P004",
    defaultReceptorTipoDocumento: "13",
    defaultCodPais: "SV",
    defaultDonationType: 4,
    defaultUnidadMedida: 99,
    paymentMethodCode: "01",
    responsable: {
      nombre: "Example Person",
      tipoDocumento: "13",
      numeroDocumento: "100000001",
      tipoEstablecimiento: "02"
    }
  };
}
