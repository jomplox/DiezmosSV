import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { INTENT_EXPIRY_SWEEP_LIMIT } from "../../src/worker/storage/repository";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { emisorConfig } from "./support/dteFixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("donation intents", () => {
  // A checksum-valid DUI (10000001-9) and a deliberately invalid one that only
  // fails the verifier digit (01234567-0; correct check digit is 8).
  const VALID_DUI = "10000001-9";
  const BAD_CHECKSUM_DUI = "01234567-0";

  function validIntentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    // Name and email are collected on Wompi's hosted sheet, not on the /donar form,
    // so the intent body carries only documento, teléfono, dirección, and monto.
    return {
      amount: "25.50",
      donorDocumentType: "13",
      donorDocument: VALID_DUI,
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "Colonia Escalón, San Salvador",
      ...overrides
    };
  }

  function intentRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
    return new Request("https://example.org/api/donations/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: JSON.stringify(body)
    });
  }

  it.each([
    [undefined, validIntentBody()],
    ["preview", validIntentBody()],
    [undefined, { amount: "25.00", giftType: "DIEZMO" }],
    ["preview", { amount: "25.00", giftType: "DIEZMO" }]
  ] as const)("rejects payment creation in APP_ENV %s before DB or Wompi work", async (appEnv, body) => {
    const db = new InMemoryD1();
    const outbound = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      intentRequest(body as Record<string, unknown>),
      env(db, { APP_ENV: appEnv })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "payment_collection_disabled"
    });
    expect(db.preparedSql).toHaveLength(0);
    expect(db.donationIntents).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects payment creation for a non-string runtime APP_ENV before DB or Wompi work", async () => {
    const db = new InMemoryD1();
    const outbound = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      intentRequest(validIntentBody()),
      env(db, { APP_ENV: 42 } as unknown as Partial<Env>)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "payment_collection_disabled"
    });
    expect(db.preparedSql).toHaveLength(0);
    expect(db.donationIntents).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("creates a PENDING intent, attaches a mock Wompi link, and returns all three link fields", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { intentId: string; urlEnlace: string; urlEnlaceLargo: string; datosToken?: string };
    expect(payload.intentId).toMatch(/^di_/);
    expect(payload.urlEnlace).toBe(`https://mock.wompi.sv/enlace/${payload.intentId}`);
    expect(payload.urlEnlaceLargo).toBe(`https://mock.wompi.sv/enlace-largo/${payload.intentId}`);
    expect(payload.datosToken).toBeUndefined();

    expect(db.donationIntents).toHaveLength(1);
    const intent = db.donationIntents[0];
    expect(intent.status).toBe("LINK_CREATED");
    expect(intent.amount_cents).toBe(2550);
    expect(intent.donor_document).toBe("10000001-9"); // stored canonically via formatDui
    // Name and email are never collected on the form: they are bound null and later
    // sourced from the webhook.
    expect(intent.donor_name).toBeNull();
    expect(intent.donor_email).toBeNull();
    expect(intent.client_ip).toBe("203.0.113.7");
    expect(intent.wompi_url_enlace).toBe(payload.urlEnlace);
    expect(intent.rate_limit_claim_id).toBe(db.securityRateLimitClaims[0].id);

    // Audit records the intent creation with amount + document type, never the number.
    const audit = db.audits.find((row) => row.action === "DONATION_INTENT_CREATED");
    expect(audit).toBeDefined();
    expect(audit?.entity_type).toBe("donation_intent");
    expect(audit?.entity_id).toBe(payload.intentId);
    const metadata = JSON.stringify(audit?.metadata_json ?? "");
    expect(metadata).not.toContain("04182769");
  });

  it("atomically admits at most five overlapping intent creations from one IP", async () => {
    const db = new InMemoryD1();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => worker.fetch(intentRequest(validIntentBody()), env(db)))
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(db.donationIntents).toHaveLength(5);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "donation_intent")).toHaveLength(5);
    const [claim] = db.securityRateLimitClaims;
    expect(claim.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.key_hash).not.toContain("203.0.113.7");
  });

  it("counts pre-ledger intents while atomically admitting overlapping creations", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      const db = new InMemoryD1();
      for (let index = 0; index < 2; index += 1) {
        db.donationIntents.push({
          id: `legacy_intent_${index}`,
          client_ip: "203.0.113.7",
          created_at: `2026-07-04T11:5${index}:00.000Z`
        });
      }

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => worker.fetch(intentRequest(validIntentBody()), env(db)))
      );

      expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(17);
      expect(db.donationIntents).toHaveLength(5);
      expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "donation_intent")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an oversized public intent body with 413 before any persistence", async () => {
    // A body over the 16 KiB cap is refused up front, so oversized spam never
    // reaches validation or the atomic D1 admission ledger.
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ filler: "x".repeat(17 * 1024) })),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request_body_too_large",
      message: "La solicitud es demasiado grande."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("accepts a numeric amount and a type 37 free-form document without checksum rules", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ amount: 100, donorDocumentType: "37", donorDocument: "PASAPORTE-XZ-9" })),
      env(db)
    );

    expect(response.status).toBe(201);
    expect(db.donationIntents[0].amount_cents).toBe(10000);
    expect(db.donationIntents[0].donor_document).toBe("PASAPORTE-XZ-9");
    // Domestic intents never carry a país.
    expect(db.donationIntents[0].donor_pais).toBeNull();
    // Absent giftType stays null (legacy/US paths never send it).
    expect(db.donationIntents[0].gift_type).toBeNull();
  });

  it("persists a chosen gift type (DIEZMO / OFRENDA) on the intent", async () => {
    const diezmoDb = new InMemoryD1();
    const diezmo = await worker.fetch(intentRequest(validIntentBody({ giftType: "DIEZMO" })), env(diezmoDb));
    expect(diezmo.status).toBe(201);
    expect(diezmoDb.donationIntents[0].gift_type).toBe("DIEZMO");

    const ofrendaDb = new InMemoryD1();
    const ofrenda = await worker.fetch(intentRequest(validIntentBody({ giftType: "OFRENDA" })), env(ofrendaDb));
    expect(ofrenda.status).toBe(201);
    expect(ofrendaDb.donationIntents[0].gift_type).toBe("OFRENDA");
  });

  it("rejects an invalid gift type without persisting the intent", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ giftType: "GIFT" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_gift_type",
      message: "Seleccione el tipo de aportación: diezmo u ofrenda."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("still accepts an intent with no gift type at all (legacy / US paths)", async () => {
    const db = new InMemoryD1();
    // validIntentBody carries no giftType key.
    const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

    expect(response.status).toBe(201);
    expect(db.donationIntents[0].gift_type).toBeNull();
  });

  it("creates a NIT (36) intent with canonical document storage and the razón social", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121", donorName: "Empresa Ejemplo, S.A. de C.V." })),
      env(db)
    );

    expect(response.status).toBe(201);
    const intent = db.donationIntents[0];
    // Stored canonically as XXXX-XXXXXX-XXX-X regardless of input hyphenation.
    expect(intent.donor_document).toBe("0614-280390-112-1");
    // The razón social rides in donor_name so the correlated CDE names the empresa,
    // not the Wompi cardholder.
    expect(intent.donor_name).toBe("Empresa Ejemplo, S.A. de C.V.");
  });

  it("rejects an empresa NIT without exactly 14 digits", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "0614-280390-112", donorName: "Empresa Ejemplo" })),
      env(db)
    );

    expect(response.status).toBe(400);
    // Donor-facing copy frames the 36 type as the empresa's NIT (the /donar select
    // labels it "Empresa" so legacy personal-NIT holders are not baited into it).
    await expect(response.json()).resolves.toEqual({
      error: "invalid_nit",
      message: "Ingrese el NIT de la empresa (14 dígitos)."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("requires the razón social for NIT intents and caps it at 200 characters", async () => {
    const missing = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121" })),
      env(new InMemoryD1())
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_razon_social" });

    const tooLong = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121", donorName: "x".repeat(201) })),
      env(new InMemoryD1())
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ error: "invalid_razon_social" });
  });

  it("bounds pasaporte (03) and carnet (02) documents to 5-20 chars and stores them uppercase", async () => {
    const pasaporteDb = new InMemoryD1();
    const pasaporte = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "03", donorDocument: "ab-123456" })),
      env(pasaporteDb)
    );
    expect(pasaporte.status).toBe(201);
    expect(pasaporteDb.donationIntents[0].donor_document).toBe("AB-123456");

    const carnetDb = new InMemoryD1();
    const carnet = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "02", donorDocument: "cr 2026-001" })),
      env(carnetDb)
    );
    expect(carnet.status).toBe(201);
    expect(carnetDb.donationIntents[0].donor_document).toBe("CR 2026-001");

    const tooShort = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "03", donorDocument: "A123" })),
      env(new InMemoryD1())
    );
    expect(tooShort.status).toBe(400);
    await expect(tooShort.json()).resolves.toMatchObject({ error: "invalid_identity_document" });

    const tooLong = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "02", donorDocument: "X".repeat(21) })),
      env(new InMemoryD1())
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ error: "invalid_identity_document" });
  });

  it("rejects document types outside the five CAT-022 receptor codes", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ donorDocumentType: "99" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_document_type" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("stores the 00/00/00 geography plus the CAT-020 país for a foreign-resident intent", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(
        validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "US", complemento: "742 Evergreen Terrace, Springfield" })
      ),
      env(db)
    );

    expect(response.status).toBe(201);
    const intent = db.donationIntents[0];
    expect(intent.direccion_departamento).toBe("00");
    expect(intent.direccion_municipio).toBe("00");
    expect(intent.direccion_distrito).toBe("00");
    expect(intent.donor_pais).toBe("US");
  });

  it("rejects SV as the país on the foreign path", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "SV" })),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_pais_sv" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a foreign-path intent whose país is missing or outside CAT-020", async () => {
    const missing = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00" })),
      env(new InMemoryD1())
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_pais" });

    const bogus = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "XX" })),
      env(new InMemoryD1())
    );
    expect(bogus.status).toBe(400);
    await expect(bogus.json()).resolves.toMatchObject({ error: "invalid_pais" });
  });

  it("rejects an amount below the one-dollar minimum", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ amount: "0.99" })), env(db));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; message: string };
    expect(payload.error).toBe("invalid_amount");
    expect(payload.message).toMatch(/usted|monto/i);
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects an amount above the five-thousand-dollar maximum", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ amount: "5000.01" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_amount" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("ignores a donorName/donorEmail on non-NIT intents: they are neither validated nor persisted", async () => {
    const db = new InMemoryD1();
    // Even if a client sends name/email on a non-NIT intent, the endpoint neither
    // requires nor stores them (the razón social is bound only for NIT/36, so the
    // webhook cardholder name still wins for personal donors).
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorName: "Ignorado", donorEmail: "ignorado@example.org" })),
      env(db)
    );

    expect(response.status).toBe(201);
    expect(db.donationIntents).toHaveLength(1);
    expect(db.donationIntents[0].donor_name).toBeNull();
    expect(db.donationIntents[0].donor_email).toBeNull();
  });

  it("rejects a DUI that fails the check digit for document type 13", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ donorDocument: BAD_CHECKSUM_DUI })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_dui",
      message: "DUI inválido: revise el número y el dígito verificador."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a municipio that does not belong to the given departamento", async () => {
    const db = new InMemoryD1();
    // 23 is a valid San Salvador (06) municipio but not valid under Ahuachapán (01).
    const response = await worker.fetch(intentRequest(validIntentBody({ departamento: "01", municipio: "23", distrito: "01" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_municipio" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a distrito that does not belong to the given departamento", async () => {
    const db = new InMemoryD1();
    // 14 is a valid district under San Salvador (06) but not under Ahuachapán (01).
    const response = await worker.fetch(intentRequest(validIntentBody({ departamento: "01", municipio: "13", distrito: "14" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_distrito" });
  });

  it("rejects a missing complemento", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ complemento: "" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_complemento" });
  });

  it("rejects a complemento longer than the MH schema's 200-char cap", async () => {
    // fe-cd-v2 caps receptor direccion.complemento at 200. Anything longer would
    // pass intent validation, take the donor's payment, and then FAIL the schema
    // at CDE build time — a paid donation stranded without a comprobante.
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ complemento: "x".repeat(201) })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_complemento" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("blocks the sixth intent from one IP within 15 minutes with a 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      const db = new InMemoryD1();
      // Five intents already created by this IP inside the window.
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({
          id: `di_seed_${i}`,
          status: "LINK_CREATED",
          client_ip: "203.0.113.7",
          expires_at: "2026-07-04T13:00:00.000Z",
          created_at: `2026-07-04T11:5${i}:00.000Z`
        });
      }

      const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: "too_many_attempts",
        message: "Demasiados intentos. Espere 15 minutos e intente de nuevo."
      });
      // No new intent was created.
      expect(db.donationIntents).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 502 and leaves the intent PENDING when Wompi link creation fails", async () => {
    const db = new InMemoryD1();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    try {
      const response = await worker.fetch(
        intentRequest(validIntentBody()),
        env(db, {
          MOCK_EXTERNAL_SERVICES: "false",
          APP_ORIGIN: "https://donar.example.org",
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
          WOMPI_CLIENT_ID: "id",
          WOMPI_CLIENT_SECRET: "secret"
        })
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ error: "wompi_link_failed" });
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].status).toBe("PENDING");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns the status and paid flag for a known intent id", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({ id: "di_known", status: "LINK_CREATED", donor_name: "Secreto", donor_document: "10000001-9", paid_at: null });

    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_known/status"), env(db));

    expect(response.status).toBe(200);
    // Backward-compatible: status unchanged, paid added. Unpaid intent → paid:false.
    await expect(response.json()).resolves.toEqual({ status: "LINK_CREATED", paid: false });
  });

  it("reports paid:true once paid_at is stamped (donor thanks keys on payment, not MH acceptance)", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({
      id: "di_paidflag",
      status: "LINK_CREATED",
      donor_name: "Secreto",
      donor_document: "10000001-9",
      paid_at: "2026-07-04T12:30:00.000Z"
    });

    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_paidflag/status"), env(db));

    expect(response.status).toBe(200);
    // Status is still LINK_CREATED (CDE not yet accepted) but the donor already paid.
    await expect(response.json()).resolves.toEqual({ status: "LINK_CREATED", paid: true });
  });

  it("returns 404 for an unknown intent id", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_missing/status"), env(db));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "intent_not_found" });
  });

  it("expires overdue unpaid (PENDING and LINK_CREATED) intents on the 15-minute cron sweep", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_overdue", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_fresh", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T13:00:00.000Z", created_at: "2026-07-04T12:00:00.000Z" },
      { id: "di_done", status: "COMPLETED", wompi_id_enlace: 999, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    // Mock mode (env's default): deactivatePaymentLink is a no-op, so no fetch happens.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
    } finally {
      vi.useRealTimers();
    }

    // An abandoned checkout (link minted, donor never paid) must not sit as
    // LINK_CREATED forever — it expires just like an unlinked PENDING intent.
    expect(db.donationIntents.find((row) => row.id === "di_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_fresh")?.status).toBe("PENDING");
    expect(db.donationIntents.find((row) => row.id === "di_done")?.status).toBe("COMPLETED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deactivates the Wompi link of each expired LINK_CREATED intent in real mode", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_pending_overdue", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    // Token, then the PUT that deactivates the one link with a wompi_id_enlace.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ idEnlace: 555, usable: false }), { status: 200 }));

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        APP_ORIGIN: "https://donar.example.org",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        WOMPI_CLIENT_ID: "id",
        WOMPI_CLIENT_SECRET: "secret"
      }));
    } finally {
      vi.useRealTimers();
    }

    // Both intents expire; only the linked one triggers a token + PUT (2 calls).
    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_pending_overdue")?.status).toBe("EXPIRED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchSpy.mock.calls[1];
    expect(putUrl).toBe("https://api.wompi.sv/EnlacePago/555");
    expect((putInit as RequestInit).method).toBe("PUT");
  });

  it("still expires intents when a Wompi deactivation PUT fails", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      // A deactivation failure must not throw out of the sweep or leave the intent unexpired.
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        APP_ORIGIN: "https://donar.example.org",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        WOMPI_CLIENT_ID: "id",
        WOMPI_CLIENT_SECRET: "secret"
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("caps one sweep at INTENT_EXPIRY_SWEEP_LIMIT and lets the next tick continue", async () => {
    const db = new InMemoryD1();
    // More expirable rows than a single tick can process, so attacker-created intents
    // cannot force one cron invocation to snapshot or deactivate an unbounded set.
    const overflow = 5;
    for (let i = 0; i < INTENT_EXPIRY_SWEEP_LIMIT + overflow; i += 1) {
      const suffix = String(i).padStart(4, "0");
      db.donationIntents.push({
        id: `di_exp_${suffix}`,
        status: "PENDING",
        wompi_id_enlace: null,
        amount_cents: 2550,
        expires_at: "2026-07-04T11:00:00.000Z",
        created_at: "2026-07-04T10:00:00.000Z"
      });
    }
    const expiredCount = () => db.donationIntents.filter((row) => row.status === "EXPIRED").length;

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
      // Exactly the cap expires this tick; the remainder stays PENDING for the next one.
      expect(expiredCount()).toBe(INTENT_EXPIRY_SWEEP_LIMIT);
      expect(db.donationIntents.filter((row) => row.status === "PENDING")).toHaveLength(overflow);

      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
      // The next tick continues from where the first left off.
      expect(expiredCount()).toBe(INTENT_EXPIRY_SWEEP_LIMIT + overflow);
      expect(db.donationIntents.some((row) => row.status === "PENDING")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Premint: draft create (amount + optional giftType only) ────────────────
  //
  // The donor wizard mints the Wompi link in the background when the SV donor
  // ENTERS Paso 2, before the fiscal data exists. That draft body carries only the
  // amount (and, on the SV path, the gift type) — no documento/dirección — yet the
  // link is minted exactly as today (identificadorEnlaceComercio = intent id).
  describe("draft create (no donor fields)", () => {
    function draftRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
      return new Request("https://example.org/api/donations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body)
      });
    }

    it("mints the Wompi link for a draft carrying only { amount, giftType } (donor data absent)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "25.50", giftType: "DIEZMO" }), env(db));

      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        intentId: string;
        datosToken?: string;
        urlEnlace?: string;
        urlEnlaceLargo?: string;
      };
      // Preminting remains an internal latency optimization. The payment capability
      // stays server-side until /datos atomically commits the fiscal fields.
      expect(payload.intentId).toMatch(/^di_/);
      expect(payload.datosToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(payload).not.toHaveProperty("urlEnlace");
      expect(payload).not.toHaveProperty("urlEnlaceLargo");

      expect(db.donationIntents).toHaveLength(1);
      const intent = db.donationIntents[0];
      expect(intent.status).toBe("LINK_CREATED");
      expect(intent.wompi_url_enlace).toBe(`https://mock.wompi.sv/enlace/${payload.intentId}`);
      expect(intent.wompi_url_enlace_largo).toBe(`https://mock.wompi.sv/enlace-largo/${payload.intentId}`);
      expect(intent.amount_cents).toBe(2550);
      expect(intent.gift_type).toBe("DIEZMO");
      // The draft marker: donor document + address stay NULL until the datos call.
      expect(intent.donor_document).toBeNull();
      expect(intent.direccion_departamento).toBeNull();
      expect(intent.direccion_complemento).toBeNull();
      expect(intent.donor_name).toBeNull();
      expect(intent.client_ip).toBe("203.0.113.7");
      expect(String(intent.datos_token_hash)).toMatch(/^[a-f0-9]{64}$/);
      expect(intent.datos_token_hash).not.toBe(payload.datosToken);
    });

    it("rejects cross-site simple and mismatched-origin JSON before any side effect", async () => {
      const db = new InMemoryD1();
      const simpleResponse = await worker.fetch(
        new Request("https://example.org/api/donations/intent", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            Origin: "https://attacker.example",
            "Sec-Fetch-Site": "cross-site",
            "cf-connecting-ip": "203.0.113.7"
          },
          body: JSON.stringify({ amount: "25.50", giftType: "DIEZMO" })
        }),
        env(db)
      );
      const mismatchedOriginResponse = await worker.fetch(
        new Request("https://example.org/api/donations/intent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://attacker.example",
            "Sec-Fetch-Site": "same-site",
            "cf-connecting-ip": "203.0.113.7"
          },
          body: JSON.stringify({ amount: "25.50", giftType: "DIEZMO" })
        }),
        env(db)
      );

      expect(simpleResponse.status).toBe(415);
      expect(mismatchedOriginResponse.status).toBe(403);
      expect(db.securityRateLimitClaims).toHaveLength(0);
      expect(db.donationIntents).toHaveLength(0);
      expect(db.audits).toHaveLength(0);
    });

    it("accepts same-origin JSON through the public mutation admission check", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(
        draftRequest(
          { amount: "25.50", giftType: "DIEZMO" },
          { Origin: "https://example.org", "Sec-Fetch-Site": "same-origin" }
        ),
        env(db)
      );

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
    });

    it("accepts the request origin when APP_ORIGIN names a different canonical host", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(
        draftRequest(
          { amount: "25.50", giftType: "DIEZMO" },
          { Origin: "https://example.org", "Sec-Fetch-Site": "same-origin" }
        ),
        env(db, { APP_ORIGIN: "https://canonical.example.org" })
      );

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
    });

    it("mints a draft with no gift type at all (US / legacy background mint)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "10" }), env(db));

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].gift_type).toBeNull();
      expect(db.donationIntents[0].donor_document).toBeNull();
    });

    it("still validates the amount for a draft (same rule as the full create)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "0.50", giftType: "DIEZMO" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_amount",
        message: "El monto debe estar entre $1.00 y $5,000.00."
      });
      expect(db.donationIntents).toHaveLength(0);
    });

    it("rejects a present-but-invalid gift type on a draft (no persistence)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "25.00", giftType: "GIFT" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_gift_type",
        message: "Seleccione el tipo de aportación: diezmo u ofrenda."
      });
      expect(db.donationIntents).toHaveLength(0);
    });

    it("applies the same per-IP throttle to draft creates", async () => {
      const db = new InMemoryD1();
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({ id: `di_seed_${i}`, client_ip: "203.0.113.7", created_at: "2026-07-04T12:00:00.000Z" });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:05:00.000Z") });
      try {
        const response = await worker.fetch(draftRequest({ amount: "25.00", giftType: "DIEZMO" }), env(db));
        expect(response.status).toBe(429);
        expect(db.donationIntents).toHaveLength(5);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Premint: datos completion (fast D1-only) ───────────────────────────────
  //
  // Attaches the donor's fiscal data to a minted draft with the same validation the
  // full create runs; NO Wompi call, and it must never touch amount or gift type.
  describe("datos completion", () => {
    const DATOS_TOKEN = "datos-capability-test-token";

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:30:00.000Z") });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function seedDraft(db: InMemoryD1, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const draft = {
        id: "di_draft_1",
        status: "LINK_CREATED",
        amount_cents: 2550,
        donor_name: null,
        donor_document_type: "13",
        donor_document: null,
        donor_email: null,
        donor_phone: null,
        direccion_departamento: null,
        direccion_municipio: null,
        direccion_distrito: null,
        direccion_complemento: null,
        donor_pais: null,
        gift_type: "DIEZMO",
        wompi_id_enlace: 123456,
        wompi_url_enlace: "https://mock.wompi.sv/enlace/di_draft_1",
        wompi_url_enlace_largo: "https://mock.wompi.sv/enlace-largo/di_draft_1",
        document_id: null,
        client_ip: "203.0.113.7",
        datos_token_hash: await sha256Hex(utf8Bytes(DATOS_TOKEN)),
        paid_at: null,
        created_at: "2026-07-04T12:00:00.000Z",
        updated_at: "2026-07-04T12:00:00.000Z",
        expires_at: "2026-07-04T13:00:00.000Z",
        ...overrides
      };
      db.donationIntents.push(draft);
      return draft;
    }

    function datosRequest(
      id: string,
      body: Record<string, unknown>,
      headers: Record<string, string> = { "X-Donation-Datos-Token": DATOS_TOKEN }
    ): Request {
      return new Request(`https://example.org/api/donations/intent/${id}/datos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body)
      });
    }

    const validDatos = {
      donorDocumentType: "13",
      donorDocument: "10000001-9",
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "Colonia Escalón, San Salvador"
    };

    it("attaches donor data to a minted draft without a Wompi call or an amount/gift change", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        intentId: "di_draft_1",
        urlEnlace: "https://mock.wompi.sv/enlace/di_draft_1",
        urlEnlaceLargo: "https://mock.wompi.sv/enlace-largo/di_draft_1"
      });
      // No outbound HTTP: datos is D1-only.
      expect(fetchSpy).not.toHaveBeenCalled();

      const intent = db.donationIntents.find((row) => row.id === "di_draft_1")!;
      expect(intent.donor_document).toBe("10000001-9"); // stored canonically
      expect(intent.donor_document_type).toBe("13");
      expect(intent.donor_phone).toBe("70001122");
      expect(intent.direccion_departamento).toBe("06");
      expect(intent.direccion_complemento).toBe("Colonia Escalón, San Salvador");
      // Untouched by datos: money + tipo were locked at draft-mint time.
      expect(intent.amount_cents).toBe(2550);
      expect(intent.gift_type).toBe("DIEZMO");
      // Still LINK_CREATED and pointing at the same minted link.
      expect(intent.status).toBe("LINK_CREATED");
      expect(intent.wompi_id_enlace).toBe(123456);
      expect(intent.datos_token_hash).toBeNull();
    });

    it("rejects an oversized public datos body with 413 before mutating the draft", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(
        datosRequest("di_draft_1", { ...validDatos, filler: "x".repeat(17 * 1024) }),
        env(db)
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "request_body_too_large",
        message: "La solicitud es demasiado grande."
      });
      // The draft is untouched: donor data was never attached.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("mirrors the full-create validation messages (invalid DUI)", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, donorDocument: "01234567-0" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_dui",
        message: "DUI inválido: revise el número y el dígito verificador."
      });
      // Nothing persisted on a rejected datos call.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("requires the razón social for a NIT (36) datos completion", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(
        datosRequest("di_draft_1", { ...validDatos, donorDocumentType: "36", donorDocument: "06142803901121" }),
        env(db)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_razon_social",
        message: "Ingrese la razón social (máximo 200 caracteres)."
      });
    });

    it("returns 404 for an unknown intent id", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(datosRequest("di_missing", validDatos), env(db));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_not_found" });
    });

    it("returns 409 for a COMPLETED intent", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "COMPLETED", document_id: "dte_prev" });
      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      // The completed intent is not mutated.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("rejects datos on an EXPIRED intent", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "EXPIRED" });
      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      const intent = db.donationIntents.find((row) => row.id === "di_draft_1")!;
      expect(intent.donor_document).toBeNull();
      expect(intent.status).toBe("EXPIRED");
    });

    it("rejects datos after expires_at even before the cron sweep marks the intent EXPIRED", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "LINK_CREATED", expires_at: "2026-07-04T12:59:59.000Z" });
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T13:00:00.000Z") });
      try {
        const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
        expect(db.donationIntents[0].donor_document).toBeNull();
        expect(db.donationIntents[0].datos_token_hash).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a missing or incorrect datos capability without mutating the draft", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const missing = await worker.fetch(datosRequest("di_draft_1", validDatos, {}), env(db));
      const incorrect = await worker.fetch(
        datosRequest("di_draft_1", validDatos, { "X-Donation-Datos-Token": "wrong-capability" }),
        env(db)
      );

      expect(missing.status).toBe(409);
      expect(incorrect.status).toBe(409);
      await expect(missing.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      await expect(incorrect.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(db.donationIntents[0].donor_document).toBeNull();
    });

    it("rejects replay after the datos capability has been consumed", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const first = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));
      const replay = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Ataque de replay" }), env(db));

      expect(first.status).toBe(200);
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(db.donationIntents[0].direccion_complemento).toBe("Colonia Escalón, San Salvador");
    });

    it("allows exactly one of two concurrent datos capability requests", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const responses = await Promise.all([
        worker.fetch(datosRequest("di_draft_1", validDatos), env(db)),
        worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Segundo escritor" }), env(db))
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(db.donationIntents[0].datos_token_hash).toBeNull();
      expect(["Colonia Escalón, San Salvador", "Segundo escritor"]).toContain(db.donationIntents[0].direccion_complemento);
    });

    it("rejects datos after payment and on full-create intents without a capability", async () => {
      const paidDb = new InMemoryD1();
      await seedDraft(paidDb, { paid_at: "2026-07-04T12:30:00.000Z" });
      const paid = await worker.fetch(datosRequest("di_draft_1", validDatos), env(paidDb));

      const fullDb = new InMemoryD1();
      await seedDraft(fullDb, {
        donor_document: "10000001-9",
        direccion_complemento: "Colonia Escalón, San Salvador",
        datos_token_hash: null
      });
      const full = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Sobrescritura" }), env(fullDb));

      expect(paid.status).toBe(409);
      expect(full.status).toBe(409);
      await expect(paid.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      await expect(full.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(paidDb.donationIntents[0].donor_document).toBeNull();
      expect(fullDb.donationIntents[0].direccion_complemento).toBe("Colonia Escalón, San Salvador");
    });

    it("applies the per-IP throttle to the public datos endpoint", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const keyHash = await sha256Hex(utf8Bytes("203.0.113.7"));
      for (let i = 0; i < 5; i += 1) {
        db.securityRateLimitClaims.push({
          id: `datos_rate_${i}`,
          scope: "donation_datos",
          key_hash: keyHash,
          claimed_at: "2026-07-04T12:00:00.000Z",
          expires_at: "2026-07-04T12:15:00.000Z"
        });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:05:00.000Z") });
      try {
        const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));
        expect(response.status).toBe(429);
        // The draft was not modified.
        expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts failed datos capability guesses even when no intent rows are created", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const statuses: number[] = [];

      for (let index = 0; index < 6; index += 1) {
        const response = await worker.fetch(
          datosRequest("di_draft_1", validDatos, { "X-Donation-Datos-Token": `wrong-${index}` }),
          env(db)
        );
        statuses.push(response.status);
      }

      expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].donor_document).toBeNull();
      expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "donation_datos")).toHaveLength(5);
      expect(db.securityRateLimitClaims.some((claim) => claim.scope === "donation_intent")).toBe(false);
    });
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
