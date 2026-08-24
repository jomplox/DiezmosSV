import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { EnvironmentNotAllowedError } from "../../src/worker/services/environmentPolicy";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import type { WompiWebhook } from "../../src/worker/types";
import { TEST_RESEND_REQUEST_ID } from "./support/documentDeliveryFixtures";
import {
  advancedCdeDraft,
  emisorConfig,
  generatedCertificateXml
} from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { signWompiBody } from "./support/workerFetchHelpers";

installWorkerFetchGlobals();

const WOMPI_WEBHOOK_SECRET = "wompi-secret";

function collisionWebhook(overrides: Partial<WompiWebhook> = {}): WompiWebhook {
  const base: WompiWebhook = {
    IdCuenta: "acct_1",
    FechaTransaccion: "2026-06-27T10:00:00-06:00",
    Monto: "25.00",
    IdTransaccion: "collision-transaction",
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: "000001",
    IdIntentoPago: null,
    Cantidad: 1,
    EsProductiva: false,
    EnlacePago: {
      Id: 555,
      IdentificadorEnlaceComercio: "di_collision"
    },
    Cliente: {
      Nombre: "Example",
      Apellidos: "Person",
      Direccion: "canonical-address",
      EMail: "donor@example.org",
      Celular: "70000005"
    }
  };
  return {
    ...base,
    ...overrides,
    EnlacePago: { ...base.EnlacePago, ...overrides.EnlacePago },
    Cliente: { ...base.Cliente, ...overrides.Cliente }
  };
}

function seedCanonicalWompiEvent(
  db: InMemoryD1,
  payload: WompiWebhook,
  id = "wompi_collision_canonical",
  rawBody = JSON.stringify(payload)
): Record<string, unknown> {
  const firstName = payload.Cliente?.Nombre?.trim() ?? "";
  const lastName = payload.Cliente?.Apellidos?.trim() ?? "";
  const row: Record<string, unknown> = {
    id,
    transaction_id: payload.IdTransaccion,
    payment_link_id:
      payload.ResultadoTransaccion === "ExitosaAprobada"
      && (payload.EnlacePago?.IdentificadorEnlaceComercio?.trim() ?? "").startsWith("di_")
        ? payload.EnlacePago?.Id ?? null
        : null,
    environment: payload.EsProductiva ? "01" : "00",
    result: payload.ResultadoTransaccion,
    amount_cents: Math.round(Number(payload.Monto) * 100),
    donor_email: payload.Cliente?.EMail ?? null,
    donor_name: `${firstName} ${lastName}`.trim() || "Donante",
    raw_body: rawBody,
    headers_json: "{}",
    received_at: "2026-06-26T01:46:47.015Z",
    processed_at: null,
    created_document_id: null,
    issuance_claim_id: null,
    issuance_claimed_at: null,
    issuance_status: null,
    control_prefix: null,
    control_sequence: null,
    reserved_numero_control: null,
    reserved_codigo_generacion: null,
    issuance_attempt_count: 0,
    issuance_attempt_id: null,
    issuance_error_code: null,
    issuance_error_message: null,
    issuance_last_attempt_at: null,
    stalled_requeue_epoch_at: null,
    issuance_failed_at: null,
    issuance_dead_lettered_at: null
  };
  db.wompiEvents.push(row);
  return row;
}

function seedCollisionIntent(db: InMemoryD1): void {
  db.donationIntents.push({
    id: "di_collision",
    status: "LINK_CREATED",
    amount_cents: 2500,
    donor_document: "10000001-9",
    wompi_id_enlace: 555,
    donor_phone: null,
    direccion_complemento: null,
    paid_at: null
  });
}

async function postSignedWompi(
  db: InMemoryD1,
  payload: WompiWebhook,
  send: ReturnType<typeof vi.fn>
): Promise<Response> {
  return postRawSignedWompi(db, JSON.stringify(payload), send);
}

async function postRawSignedWompi(
  db: InMemoryD1,
  rawBody: string,
  send: ReturnType<typeof vi.fn>
): Promise<Response> {
  return worker.fetch(
    new Request("https://example.org/webhooks/wompi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        wompi_hash: await signWompiBody(rawBody, WOMPI_WEBHOOK_SECRET)
      },
      body: rawBody
    }),
    env(db, {
      APP_ENV: "staging",
      WOMPI_API_SECRET: WOMPI_WEBHOOK_SECRET,
      ISSUANCE_QUEUE: { send } as unknown as Queue
    })
  );
}

describe("advanced CDE generation", () => {
  it.each(["/api/test/dte/advanced-template", "/api/test/dte/advanced"])(
    "restricts caller-controlled CDE generation to owners at %s",
    async (path) => {
      const db = new InMemoryD1();
      const send = vi.fn();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

      const response = await worker.fetch(
        new Request(`https://example.org${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ draft: advancedCdeDraft() })
        }),
        env(db, {
          APP_ENV: "staging",
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
          ISSUANCE_QUEUE: { send } as unknown as Queue
        })
      );

      expect(response.status).toBe(403);
      expect(db.documents).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
      expect(db.audits).toHaveLength(0);
    }
  );

  it.each([
    ["production", "/api/test/dte"],
    ["production", "/api/test/dte/advanced-template"],
    ["production", "/api/test/dte/advanced"],
    ["preview", "/api/test/dte"],
    ["preview", "/api/test/dte/advanced-template"],
    ["preview", "/api/test/dte/advanced"]
  ])("blocks direct generation in %s at %s before creating or queueing a DTE", async (appEnv, path) => {
    const db = new InMemoryD1();
    const send = vi.fn();
    db.sessionUser = path.includes("advanced")
      ? { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" }
      : { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request(`https://example.org${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, { APP_ENV: appEnv, ISSUANCE_QUEUE: { send } as unknown as Queue })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "test_generation_disabled_in_production" });
    expect(db.documents).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("locks emission settings to the deployment's allowed ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const request = (method: "GET" | "PUT", environment?: "00" | "01") =>
      new Request("https://example.org/api/settings/emission-environment", {
        method,
        headers: { Authorization: "Bearer test-token", ...(environment ? { "Content-Type": "application/json" } : {}) },
        body: environment ? JSON.stringify({ environment }) : undefined
      });

    const state = await worker.fetch(request("GET"), env(db, { APP_ENV: "staging" }));
    const stagingRejected = await worker.fetch(request("PUT", "01"), env(db, { APP_ENV: "staging" }));
    const productionRejected = await worker.fetch(request("PUT", "00"), env(db, { APP_ENV: "production" }));

    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toEqual({
      emissionEnvironment: {
        environment: "00",
        source: "deployment_default",
        appEnv: "staging",
        locked: true,
        allowedEnvironments: ["00"]
      }
    });
    expect(stagingRejected.status).toBe(409);
    expect(productionRejected.status).toBe(409);
    expect(db.settings.find((row) => row.key === "emission_environment")).toBeUndefined();
    expect(db.audits.find((row) => row.action === "EMISSION_ENVIRONMENT_UPDATED")).toBeUndefined();
  });

  it("creates a staging quick DTE in 00 despite a stale incompatible setting", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const settingsResponse = await worker.fetch(
      new Request("https://example.org/api/settings/emission-environment", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "01" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(settingsResponse.status).toBe(409);
    db.settings.push({ key: "emission_environment", value: "01", updated_by: "legacy", updated_at: "2026-07-01T00:00:00.000Z" });

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "1.00",
          donorName: "Example Person",
          donorDocument: "100000001",
          donorEmail: "donor@example.org",
          donorPhone: "70000005"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({ ambiente: "00", tipoDte: "15" });
    expect(generated.receptor.nombre).toBe("Example Person");
    expect(generated.otrosDocumentos[0]).toMatchObject({
      descDocumento: "Generación directa",
      detalleDocumento: "Donación offline"
    });
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 100,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("records smoke provenance only for a valid staging admin run ID", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const create = async (appEnv: string, smokeRunId: string) => {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
      const response = await worker.fetch(
        new Request("https://example.org/api/test/dte", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: "1.00",
            donorName: "Staging Smoke",
            donorDocument: "100000001",
            donorEmail: "smoke@example.org",
            donorPhone: "70000005",
            smokeRunId
          })
        }),
        env(db, {
          APP_ENV: appEnv,
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
        })
      );
      return { db, response };
    };

    const staging = await create("staging", runId);
    expect(staging.response.status).toBe(202);
    expect(staging.db.audits).toContainEqual(expect.objectContaining({
      action: "STAGING_SMOKE_RUN",
      entity_type: "dte_document",
      entity_id: staging.db.documents[0].id,
      metadata_json: JSON.stringify({
        runId,
        path: "admin",
        source: "staging-smoke"
      })
    }));

    const invalid = await create("staging", "not-a-uuid");
    expect(invalid.response.status).toBe(202);
    expect(invalid.db.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);

    const local = await create("local", runId);
    expect(local.response.status).toBe(202);
    expect(local.db.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);
  });

  it("accepts a quick DTE donor document type outside DUI and NIT", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "offline@example.org"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.receptor).toMatchObject({
      tipoDocumento: "37",
      numDocumento: "RECIBO-123",
      nombre: "Donante Offline"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("rejects malformed donor email on quick DTE creation", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "correo-invalido"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_donor_email", message: "Ingrese un correo válido" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toEqual([]);
  });

  it("opens the advanced template with a default amount when quick amount is blank", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "Example Person", donorDocumentType: "03", donorDocument: "A1234567" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string }; resumen: { valorTotal: number } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "03", numDocumento: "A1234567" });
    expect(body.draft.resumen.valorTotal).toBe(1);
  });

  it("opens the advanced template with empty donor fields so the wizard can collect them", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string; nombre: string } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "13", numDocumento: "", nombre: "" });
  });

  it("stores a schema-valid advanced CDE draft and queues it for transmission", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

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
    expect(db.wompiEvents).toHaveLength(0);
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
      wompi_event_id: null,
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
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

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

  it("rejects final generation of a template draft whose receptor was left empty", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const baseEnv = {
      APP_ENV: "staging",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
    };

    const templateResponse = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, baseEnv)
    );
    expect(templateResponse.status).toBe(200);
    const { draft: emptyReceptorDraft } = (await templateResponse.json()) as { draft: Record<string, unknown> };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: emptyReceptorDraft })
      }),
      env(db, baseEnv)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects an advanced CDE draft with an invalid DUI check digit", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const draft = advancedCdeDraft();
    (draft.receptor as Record<string, unknown>).tipoDocumento = "13";
    (draft.receptor as Record<string, unknown>).numDocumento = "00000000-9";

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_advanced_cde",
      message: expect.stringContaining("DUI")
    });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

describe("Wompi webhook integration", () => {
  const strictBodyEdges: Array<{
    name: string;
    marker: string;
    mutateIncoming: (raw: Record<string, unknown>) => void;
  }> = [
    {
      name: "explicit null instead of a missing member",
      marker: "IdExterno",
      mutateIncoming: (raw) => {
        raw.IdExterno = null;
      }
    },
    {
      name: "a duplicate documented alias",
      marker: "999.00",
      mutateIncoming: (raw) => {
        raw.monto = "999.00";
      }
    },
    {
      name: "a numeric string instead of a number",
      marker: "Cantidad",
      mutateIncoming: (raw) => {
        raw.Cantidad = "1";
      }
    }
  ];

  it.each(
    (["same-ID", "alternate-ID"] as const).flatMap((replayKind) =>
      strictBodyEdges.map((edge) => ({ replayKind, ...edge }))
    )
  )("rejects a $replayKind replay with $name", async ({ replayKind, marker, mutateIncoming }) => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    const alternate = replayKind === "alternate-ID";
    const storedPayload = collisionWebhook({
      IdTransaccion: alternate ? "lossless-stored-transaction" : "collision-transaction"
    });
    const storedRaw = structuredClone(storedPayload) as unknown as Record<string, unknown>;
    const incomingRaw = structuredClone(storedPayload) as unknown as Record<string, unknown>;
    mutateIncoming(incomingRaw);
    if (alternate) {
      incomingRaw.IdTransaccion = "lossless-alternate-transaction";
    }
    seedCanonicalWompiEvent(
      db,
      storedPayload,
      "wompi_lossless_canonical",
      JSON.stringify(storedRaw)
    );
    const canonicalBefore = structuredClone(db.wompiEvents);
    const send = vi.fn();

    const response = await postRawSignedWompi(db, JSON.stringify(incomingRaw), send);
    const responseBody = await response.json();

    expect(response.status).toBe(409);
    expect(responseBody).toEqual({ error: "wompi_event_conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(db.donationIntents[0].paid_at).toBeNull();
    expect(db.wompiEvents).toEqual(canonicalBefore);
    const audit = db.audits.find((row) => row.action === "WOMPI_EVENT_CONFLICT");
    expect(audit).toMatchObject({
      entity_type: "wompi_event",
      entity_id: "wompi_lossless_canonical",
      summary: "Evento Wompi rechazado por conflicto con el registro canónico"
    });
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({
      reason: "canonical_mismatch",
      fields: ["normalized_body"]
    });
    const boundedOutput = JSON.stringify({ responseBody, audit });
    expect(boundedOutput).not.toContain(marker);
    expect(boundedOutput).not.toContain(String(incomingRaw.IdTransaccion));
  });

  it.each(
    (["same-ID", "alternate-ID"] as const).flatMap((replayKind) => [
      {
        replayKind,
        name: "an added unknown provider field",
        mutateStored: (_raw: Record<string, unknown>): void => {},
        mutateIncoming: (raw: Record<string, unknown>) => {
          raw.ProviderEvidence = {
            nested: { decision: "provider-added-after-first-delivery" },
            steps: [1, { approved: true }]
          };
        }
      },
      {
        replayKind,
        name: "changed unknown provider metadata",
        mutateStored: (raw: Record<string, unknown>) => {
          raw.ProviderEvidence = { history: [1, 2] };
        },
        mutateIncoming: (raw: Record<string, unknown>) => {
          raw.ProviderEvidence = { history: [2, 1] };
        }
      },
      {
        replayKind,
        name: "a later authorization code",
        mutateStored: (raw: Record<string, unknown>) => {
          raw.CodigoAutorizacion = null;
        },
        mutateIncoming: (raw: Record<string, unknown>) => {
          raw.CodigoAutorizacion = "provider-filled-later";
        }
      }
    ])
  )("accepts a $replayKind replay with $name and repairs downstream processing", async ({
    replayKind,
    mutateStored,
    mutateIncoming
  }) => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    const alternate = replayKind === "alternate-ID";
    const storedPayload = collisionWebhook({
      IdTransaccion: alternate ? "benign-stored-transaction" : "collision-transaction"
    });
    const storedRaw = structuredClone(storedPayload) as unknown as Record<string, unknown>;
    const incomingRaw = structuredClone(storedPayload) as unknown as Record<string, unknown>;
    mutateStored(storedRaw);
    mutateIncoming(incomingRaw);
    if (alternate) {
      incomingRaw.IdTransaccion = "benign-alternate-transaction";
    }
    const canonicalRawBody = JSON.stringify(storedRaw);
    seedCanonicalWompiEvent(
      db,
      storedPayload,
      "wompi_benign_canonical",
      canonicalRawBody
    );
    const send = vi.fn();

    const response = await postRawSignedWompi(db, JSON.stringify(incomingRaw), send);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      wompiEventId: "wompi_benign_canonical",
      inserted: false,
      queued: true
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.donationIntents[0].paid_at).not.toBeNull();
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0].raw_body).toBe(canonicalRawBody);
    expect(db.audits.find((row) => row.action === "WOMPI_EVENT_CONFLICT")).toBeUndefined();
    expect(db.audits.find((row) => row.action === "WOMPI_DUPLICATE")?.entity_id)
      .toBe("wompi_benign_canonical");
  });

  it.each([
    {
      name: "environment",
      stored: collisionWebhook({ EsProductiva: true }),
      incoming: collisionWebhook(),
      fields: ["environment", "normalized_body"]
    },
    {
      name: "result",
      stored: collisionWebhook({ ResultadoTransaccion: "Denegada" }),
      incoming: collisionWebhook(),
      fields: ["result", "normalized_body"]
    },
    {
      name: "amount",
      stored: collisionWebhook({ Monto: "20.00" }),
      incoming: collisionWebhook(),
      fields: ["amount", "normalized_body"]
    },
    {
      name: "payment link",
      stored: collisionWebhook({ EnlacePago: { Id: 556 } }),
      incoming: collisionWebhook(),
      fields: ["payment_link", "normalized_body"]
    },
    {
      name: "commerce intent",
      stored: collisionWebhook({
        EnlacePago: { IdentificadorEnlaceComercio: "di_other_intent" }
      }),
      incoming: collisionWebhook(),
      fields: ["commerce_intent", "normalized_body"]
    },
    {
      name: "normalized body",
      stored: collisionWebhook(),
      incoming: collisionWebhook({
        Cliente: { Direccion: "incoming-private-collision-value" }
      }),
      fields: ["normalized_body"]
    }
  ])("rejects a same-transaction $name collision without trusting incoming values", async ({
    stored,
    incoming,
    fields
  }) => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    seedCanonicalWompiEvent(db, stored);
    const canonicalBefore = structuredClone(db.wompiEvents);
    const send = vi.fn();

    const response = await postSignedWompi(db, incoming, send);
    const responseBody = await response.json();

    expect(response.status).toBe(409);
    expect(responseBody).toEqual({ error: "wompi_event_conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(db.donationIntents[0].paid_at).toBeNull();
    expect(db.wompiEvents).toEqual(canonicalBefore);
    const audit = db.audits.find((row) => row.action === "WOMPI_EVENT_CONFLICT");
    expect(audit).toMatchObject({
      entity_type: "wompi_event",
      entity_id: "wompi_collision_canonical",
      summary: "Evento Wompi rechazado por conflicto con el registro canónico"
    });
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({
      reason: "canonical_mismatch",
      fields
    });
    const boundedOutput = JSON.stringify({ responseBody, audit });
    expect(boundedOutput).not.toContain(incoming.IdTransaccion);
    expect(boundedOutput).not.toContain("incoming-private-collision-value");
  });

  it("rejects when transaction and payment-link lookups identify different canonical rows", async () => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    seedCanonicalWompiEvent(
      db,
      collisionWebhook({ EnlacePago: { Id: 556 } }),
      "wompi_by_transaction"
    );
    seedCanonicalWompiEvent(
      db,
      collisionWebhook({ IdTransaccion: "other-transaction" }),
      "wompi_by_payment_link"
    );
    const canonicalBefore = structuredClone(db.wompiEvents);
    const send = vi.fn();

    const response = await postSignedWompi(db, collisionWebhook(), send);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "wompi_event_conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(db.donationIntents[0].paid_at).toBeNull();
    expect(db.wompiEvents).toEqual(canonicalBefore);
    const audit = db.audits.find((row) => row.action === "WOMPI_EVENT_CONFLICT");
    expect(audit).toMatchObject({
      entity_type: "wompi_event",
      entity_id: "wompi_by_transaction",
      summary: "Evento Wompi rechazado por conflicto con el registro canónico"
    });
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({
      reason: "identity_lookup_conflict",
      fields: ["identity"]
    });
  });

  it("re-reads and compares a conflicting event inserted during the uniqueness race", async () => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    const stored = collisionWebhook({
      Cliente: { Direccion: "canonical-race-address" }
    });
    db.beforeWompiEventInsert = () => {
      seedCanonicalWompiEvent(db, stored, "wompi_concurrent_winner");
    };
    const send = vi.fn();

    const response = await postSignedWompi(db, collisionWebhook(), send);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "wompi_event_conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(db.donationIntents[0].paid_at).toBeNull();
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0].raw_body).toBe(JSON.stringify(stored));
    expect(db.audits.find((row) => row.action === "WOMPI_EVENT_CONFLICT")).toBeDefined();
  });

  it("rejects an alternate transaction identifier when any other normalized body value changes", async () => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    const stored = collisionWebhook({ IdTransaccion: "payment-link-display-id" });
    seedCanonicalWompiEvent(db, stored);
    const canonicalBefore = structuredClone(db.wompiEvents);
    const send = vi.fn();

    const response = await postSignedWompi(
      db,
      collisionWebhook({
        IdTransaccion: "delayed-webhook-uuid",
        Cliente: { Direccion: "alternate-transaction-private-collision" }
      }),
      send
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "wompi_event_conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(db.donationIntents[0].paid_at).toBeNull();
    expect(db.wompiEvents).toEqual(canonicalBefore);
    const audit = db.audits.find((row) => row.action === "WOMPI_EVENT_CONFLICT");
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({
      reason: "canonical_mismatch",
      fields: ["normalized_body"]
    });
    expect(JSON.stringify(audit)).not.toContain("alternate-transaction-private-collision");
  });

  it("accepts a signed official Wompi webhook and queues approved payments", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_doc_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      },
      enlacePago: {
        IdentificadorEnlaceComercio: "DONACION-123"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, inserted: true, queued: true });
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0]).toMatchObject({
      transaction_id: "wompi_doc_tx_1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donor@example.org",
      donor_name: "Example Person"
    });
    expect(queued).toEqual([{
      wompiEventId: db.wompiEvents[0].id,
      issuanceAttemptId: expect.any(String)
    }]);
  });

  it("accepts an exact replay whose JSON aliases and member order normalize identically", async () => {
    const db = new InMemoryD1();
    seedCollisionIntent(db);
    const send = vi.fn();
    const canonicalPayload = collisionWebhook();
    const canonicalRawBody = JSON.stringify({
      ...canonicalPayload,
      ProviderEvidence: {
        nested: { first: 1, second: 2 }
      }
    });

    const first = await postRawSignedWompi(db, canonicalRawBody, send);
    const replayRawBody = JSON.stringify({
      ProviderEvidence: {
        nested: { second: 2, first: 1 }
      },
      cliente: {
        celular: "70000005",
        email: "donor@example.org",
        direccion: "canonical-address",
        apellidos: "Person",
        nombre: "Example"
      },
      enlacePago: {
        identificadorEnlaceComercio: "di_collision",
        id: 555
      },
      esProductiva: false,
      cantidad: 1,
      idIntentoPago: null,
      codigoAutorizacion: "000001",
      resultadoTransaccion: "ExitosaAprobada",
      idTransaccion: "collision-transaction",
      monto: "25.00",
      fechaTransaccion: "2026-06-27T10:00:00-06:00",
      idCuenta: "acct_1"
    });
    const replay = await postRawSignedWompi(db, replayRawBody, send);

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      inserted: false,
      queued: false
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.donationIntents[0].paid_at).not.toBeNull();
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0].raw_body).toBe(canonicalRawBody);
    expect(db.audits.find((row) => row.action === "WOMPI_DUPLICATE")?.summary)
      .toBe("collision-transaction ExitosaAprobada");
  });

  it("deduplicates one approved payment link even when Wompi uses a different transaction id later", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({
      id: "di_link_dedupe",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 555,
      paid_at: null
    });
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const payload = (transactionId: string) => JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: transactionId,
      ResultadoTransaccion: "ExitosaAprobada",
      CodigoAutorizacion: "000001",
      EsProductiva: false,
      Cliente: {
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org"
      },
      EnlacePago: {
        Id: 555,
        IdentificadorEnlaceComercio: "di_link_dedupe"
      }
    });
    const post = async (transactionId: string) => {
      const rawBody = payload(transactionId);
      return worker.fetch(
        new Request("https://example.org/webhooks/wompi", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            wompi_hash: await signWompiBody(rawBody, secret)
          },
          body: rawBody
        }),
        env(db, {
          APP_ENV: "staging",
          WOMPI_API_SECRET: secret,
          ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
        })
      );
    };

    const reconciledShape = await post("display-id-from-payment-link-api");
    const delayedWebhookShape = await post("uuid-from-delayed-webhook");

    expect(reconciledShape.status).toBe(202);
    await expect(reconciledShape.json()).resolves.toMatchObject({ inserted: true, queued: true });
    expect(delayedWebhookShape.status).toBe(200);
    await expect(delayedWebhookShape.json()).resolves.toMatchObject({ inserted: false, queued: false });
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0]).toMatchObject({
      transaction_id: "display-id-from-payment-link-api",
      payment_link_id: 555
    });
    expect(queued).toHaveLength(1);
    const duplicate = db.audits.find((row) => row.action === "WOMPI_DUPLICATE");
    expect(duplicate?.summary).toBe("display-id-from-payment-link-api ExitosaAprobada");
  });

  it("stores but quarantines a signed webhook whose ambiente is incompatible with the deployment", async () => {
    const db = new InMemoryD1();
    // Owner has the app set to PRODUCTION emission, but a TEST-mode payment arrives.
    db.settings.push({ key: "emission_environment", value: "01" });
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_mismatch",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        APP_ENV: "production",
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.clone().json()).resolves.toMatchObject({ queued: false });
    expect(db.wompiEvents[0]).toMatchObject({ transaction_id: "wompi_env_tx_mismatch", environment: "00" });
    const mismatch = db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH");
    expect(mismatch).toMatchObject({ entity_type: "wompi_event", entity_id: db.wompiEvents[0].id });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { payloadEnvironment: string; activeEnvironment: string };
    expect(metadata).toMatchObject({ payloadEnvironment: "00", activeEnvironment: "01" });
    expect(queued).toEqual([]);
  });

  it("rejects a manually injected incompatible Wompi queue event before any issuance side effect", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push({
      id: "wompi_injected_prod",
      transaction_id: "wompi_injected_prod_tx",
      environment: "01",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify({
        IdCuenta: "acct_1",
        FechaTransaccion: "2026-07-09T12:00:00-06:00",
        Monto: "25.00",
        IdTransaccion: "wompi_injected_prod_tx",
        ResultadoTransaccion: "ExitosaAprobada",
        EsProductiva: true
      }),
      headers_json: "{}",
      received_at: "2026-07-09T18:00:00.000Z",
      processed_at: null,
      created_document_id: null
    });

    const error = await new IssuancePipeline(env(db, { APP_ENV: "staging" }))
      .processWompiEvent("wompi_injected_prod")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentNotAllowedError);
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
    expect(db.wompiEvents[0].processed_at).toBeNull();
  });

  it("does not audit a mismatch when the signed payload agrees with the active emission setting", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "emission_environment", value: "00" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_agree",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents[0]).toMatchObject({ environment: "00" });
    expect(db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH")).toBeUndefined();
  });

  it("normalizes the stored raw Wompi body before generating the queued CDE", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_pipeline_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const body = await response.json() as { wompiEventId: string };
    const certificateXml = await generatedCertificateXml("cert-password");

    const record = await new IssuancePipeline(env(db, {
      EMISOR_CONFIG_JSON: JSON.stringify({ ...emisorConfig(), defaultDonationType: 1 }),
      MH_CERT_XML: certificateXml,
      MH_CERT_PASSWORD: "cert-password"
    })).processWompiEvent(body.wompiEventId);

    expect(record).toMatchObject({
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 2500,
      status: "ACCEPTED"
    });
    const cde = JSON.parse(record!.plain_json) as { receptor: { nombre: string; correo: string; telefono: string } };
    expect(cde.receptor).toMatchObject({
      nombre: "Example Person",
      correo: "donor@example.org",
      telefono: "70000005"
    });
  });

  it("returns a clear 400 for signed webhook payloads Wompi cannot map to a transaction", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "25.00",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_wompi_payload",
      message: expect.stringContaining("IdTransaccion")
    });
    expect(db.wompiEvents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("does not mark paid_at from an IdExterno-only app identifier", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_paidmark",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_paid_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_paidmark"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.paid_at ?? null).toBeNull();
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.status).toBe("LINK_CREATED");
  });

  it("marks paid_at only from an exact canonical commerce id and numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_enlacepaid",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_enlace_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_enlacepaid" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_enlacepaid")?.paid_at).toBeTruthy();
  });

  it("does not mark paid_at when the canonical commerce id lacks the numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_missing_link",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_missing_link_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "di_missing_link" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents[0].paid_at ?? null).toBeNull();
  });

  it("does not change paid_at on a replayed webhook for an already-paid intent", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_replay",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: "2026-07-04T12:30:00.000Z"
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_replay_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_replay",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_replay" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    // markIntentPaid is idempotent (WHERE paid_at IS NULL): the first stamp stands.
    expect(db.donationIntents.find((row) => row.id === "di_replay")?.paid_at).toBe("2026-07-04T12:30:00.000Z");
  });

  // /donar no longer asks for phone or address (Wompi's sheet forces both), so the
  // webhook is the only source. Backfilling them onto the intent row is what keeps the
  // contacts/CRM export whole — it reads donation_intents.donor_phone and
  // .direccion_complemento directly.
  it("backfills donor phone and address from the webhook onto the paid intent", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_backfill",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      donor_phone: null,
      direccion_complemento: null,
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z"
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_backfill_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_backfill",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_backfill" },
      Cliente: { Celular: "70009999", Direccion: "Av. Wompi 456, San Salvador" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents.find((row) => row.id === "di_backfill")).toMatchObject({
      donor_phone: "70009999",
      direccion_complemento: "Av. Wompi 456, San Salvador"
    });
  });

  it("never overwrites a donor-supplied phone or address on backfill", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_keep",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      donor_phone: "22221111",
      direccion_complemento: "Calle Donante 123",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z"
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_keep_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_keep",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_keep" },
      Cliente: { Celular: "70009999", Direccion: "Av. Wompi 456" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents.find((row) => row.id === "di_keep")).toMatchObject({
      donor_phone: "22221111",
      direccion_complemento: "Calle Donante 123"
    });
  });

  it("leaves non-intent (legacy static-link) webhooks unaffected — no intent, no error", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_legacy_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "DONACION-123" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    // Still processed and queued; nothing to mark paid, no crash.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true, queued: true });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("never lets a paid-marker failure (unknown di_ intent) break webhook processing", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    // A di_ id that has no matching intent row — the marker must no-op, not 500.
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_orphan_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_does_not_exist"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true });
    expect(db.wompiEvents).toHaveLength(1);
  });

  it("does not mark paid_at for a declined di_ webhook", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_declined",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_declined_tx_1",
      ResultadoTransaccion: "Rechazada",
      EsProductiva: false,
      IdExterno: "di_declined"
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents.find((row) => row.id === "di_declined")?.paid_at ?? null).toBeNull();
  });
});
