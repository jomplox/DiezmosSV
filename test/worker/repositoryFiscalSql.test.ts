import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Repository } from "../../src/worker/storage/repository";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("fiscal repository SQL on SQLite", () => {
  it("stores one correction for concurrent reuse of the same request id", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    seedFailedWompiEvent(database, "wompi_bad_dui");

    const input = wompiCorrectionClaimInput({
      requestId: "11111111-1111-4111-8111-111111111111"
    });
    const [first, second] = await Promise.all([
      repository.claimWompiFiscalCorrection(input),
      repository.claimWompiFiscalCorrection(input)
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["claimed", "duplicate"]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections"
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT issuance_status, processed_at, issuance_attempt_id
         FROM wompi_events WHERE id = ?`
    ).get("wompi_bad_dui")).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      processed_at: null,
      issuance_attempt_id: expect.any(String)
    });
    database.close();
  });

  it("returns duplicate only for the same correction target and payload", async () => {
    const database = migratedDatabase();
    seedFailedWompiEvent(database, "wompi_conflict");
    const repository = new Repository(new SqliteD1(database).database);
    const input = wompiCorrectionClaimInput({
      wompiEventId: "wompi_conflict",
      requestId: "70000003-2222-4222-8222-700000032222"
    });

    await expect(repository.claimWompiFiscalCorrection(input)).resolves.toMatchObject({
      kind: "claimed"
    });
    await expect(repository.claimWompiFiscalCorrection(input)).resolves.toMatchObject({
      kind: "duplicate"
    });
    await expect(repository.claimWompiFiscalCorrection({
      ...input,
      requestPayloadSha256: "different-payload"
    })).resolves.toMatchObject({ kind: "conflict" });
    await expect(repository.claimWompiFiscalCorrection({
      ...input,
      wompiEventId: "another-target"
    })).resolves.toMatchObject({ kind: "conflict" });
    database.close();
  });

  it("snapshots a rejected document before claiming it", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_rejected");
    const repository = new Repository(new SqliteD1(database).database);

    const result = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput()
    );

    expect(result).toMatchObject({ kind: "claimed" });
    const stored = database.prepare(
      "SELECT source_document_snapshot_json FROM fiscal_corrections"
    ).get() as { source_document_snapshot_json: string };
    expect(JSON.parse(stored.source_document_snapshot_json)).toMatchObject({
      id: "doc_rejected",
      status: "REJECTED",
      plain_json: "{\"identificacion\":{\"tipoDte\":\"15\"}}",
      signed_jws: "rejected-jws",
      mh_estado: "RECHAZADO"
    });
    expect(database.prepare(
      `SELECT fiscal_operation_claim_id, fiscal_operation_claimed_at,
              fiscal_operation_kind
         FROM dte_documents WHERE id = ?`
    ).get("doc_rejected")).toMatchObject({
      fiscal_operation_claim_id: expect.any(String),
      fiscal_operation_claimed_at: expect.any(String),
      fiscal_operation_kind: "TRANSMISSION"
    });
    database.close();
  });

  it("allows exactly one different request to claim a rejected document", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_competing_requests");
    const repository = new Repository(new SqliteD1(database).database);

    const [first, second] = await Promise.all([
      repository.claimDocumentFiscalCorrection(documentCorrectionClaimInput({
        documentId: "doc_competing_requests",
        requestId: "10101010-1010-4010-8010-101010101010"
      })),
      repository.claimDocumentFiscalCorrection(documentCorrectionClaimInput({
        documentId: "doc_competing_requests",
        requestId: "20202020-2020-4020-8020-202020202020"
      }))
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["claimed", "ineligible"]);
    const corrections = database.prepare(
      `SELECT attempt_number, fiscal_claim_id
         FROM fiscal_corrections WHERE document_id = ?`
    ).all("doc_competing_requests") as Array<{
      attempt_number: number;
      fiscal_claim_id: string;
    }>;
    expect(corrections).toEqual([{
      attempt_number: 1,
      fiscal_claim_id: expect.any(String)
    }]);
    expect(database.prepare(
      `SELECT fiscal_operation_claim_id, fiscal_operation_kind
         FROM dte_documents WHERE id = ?`
    ).get("doc_competing_requests")).toEqual({
      fiscal_operation_claim_id: corrections[0].fiscal_claim_id,
      fiscal_operation_kind: "TRANSMISSION"
    });
    database.close();
  });

  it("never reclaims a rejected document after an accepted correction", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_accepted_history");
    const repository = new Repository(new SqliteD1(database).database);
    const first = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_accepted_history",
        requestId: "30303030-3030-4030-8030-303030303030"
      })
    );
    if (first.kind !== "claimed") throw new Error("expected accepted-history claim");
    await repository.claimFiscalCorrectionProcessing({
      id: first.correction.id,
      processingClaimId: first.correction.processing_claim_id,
      fiscalClaimId: first.correction.fiscal_claim_id ?? undefined
    });
    await repository.markFiscalCorrectionMhDispatchStarted(
      first.correction.id,
      first.correction.processing_claim_id
    );
    await expect(repository.finalizeFiscalCorrection(
      first.correction.id,
      first.correction.processing_claim_id,
      { status: "ACCEPTED" }
    )).resolves.toBe(true);

    expect(database.prepare(
      "SELECT status FROM dte_documents WHERE id = ?"
    ).get("doc_accepted_history")).toEqual({ status: "REJECTED" });
    await expect(repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_accepted_history",
        requestId: "40404040-4040-4040-8040-404040404040"
      })
    )).resolves.toEqual({ kind: "ineligible" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections WHERE document_id = ?"
    ).get("doc_accepted_history")).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
    ).get("doc_accepted_history")).toEqual({ fiscal_operation_claim_id: null });
    database.close();
  });

  it("requires both correction and target ownership before processing", async () => {
    const database = migratedDatabase();
    seedFailedWompiEvent(database, "wompi_processing_fence");
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({ wompiEventId: "wompi_processing_fence" })
    );
    if (claimed.kind !== "claimed") throw new Error("expected correction claim");
    const correction = claimed.correction;

    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: "stale-processing-token",
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    })).resolves.toBe("busy");
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: "stale-issuance-attempt"
    })).resolves.toBe("busy");
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    })).resolves.toBe("claimed");
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    })).resolves.toBe("busy");
    database.close();
  });

  it("keeps processing and MH dispatch evidence separate and fences finalization", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_dispatch_fence");
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({ documentId: "doc_dispatch_fence" })
    );
    if (claimed.kind !== "claimed") throw new Error("expected document correction claim");
    const correction = claimed.correction;

    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id ?? undefined
    })).resolves.toBe("claimed");
    const processing = database.prepare(
      `SELECT processing_started_at, mh_dispatch_started_at
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id) as {
      processing_started_at: string;
      mh_dispatch_started_at: string | null;
    };
    expect(processing).toMatchObject({
      processing_started_at: expect.any(String),
      mh_dispatch_started_at: null
    });
    await expect(repository.markFiscalCorrectionMhDispatchStarted(
      correction.id,
      "stale-processing-token"
    )).resolves.toBe(false);
    await expect(repository.markFiscalCorrectionMhDispatchStarted(
      correction.id,
      correction.processing_claim_id
    )).resolves.toBe(true);
    expect(database.prepare(
      `SELECT processing_started_at, mh_dispatch_started_at
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id)).toMatchObject({
      processing_started_at: processing.processing_started_at,
      mh_dispatch_started_at: expect.any(String)
    });
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      "stale-processing-token",
      { status: "REVIEW_REQUIRED", failureCode: "MH_OUTCOME_UNKNOWN", failureMessage: "Sin respuesta definitiva" }
    )).resolves.toBe(false);
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      correction.processing_claim_id,
      { status: "REVIEW_REQUIRED", failureCode: "MH_OUTCOME_UNKNOWN", failureMessage: "Sin respuesta definitiva" }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
    ).get("doc_dispatch_fence")).toEqual({
      fiscal_operation_claim_id: correction.fiscal_claim_id
    });
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id ?? undefined
    })).resolves.toBe("terminal");
    database.close();
  });

  it("requires MH dispatch evidence for known and uncertain MH outcomes", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    const outcomes = [
      { status: "ACCEPTED" as const },
      { status: "REJECTED" as const, failureCode: "MH_REJECTED" },
      { status: "REVIEW_REQUIRED" as const, failureCode: "MH_OUTCOME_UNKNOWN" }
    ];

    for (const [index, outcome] of outcomes.entries()) {
      const documentId = `doc_dispatch_required_${index}`;
      seedRejectedDocument(database, documentId);
      const claimed = await repository.claimDocumentFiscalCorrection(
        documentCorrectionClaimInput({
          documentId,
          requestId: `50505050-5050-4050-8050-50505050505${index}`
        })
      );
      if (claimed.kind !== "claimed") throw new Error("expected dispatch-required claim");
      const correction = claimed.correction;
      await repository.claimFiscalCorrectionProcessing({
        id: correction.id,
        processingClaimId: correction.processing_claim_id,
        fiscalClaimId: correction.fiscal_claim_id ?? undefined
      });

      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        outcome
      )).resolves.toBe(false);
      expect(database.prepare(
        "SELECT status, mh_dispatch_started_at FROM fiscal_corrections WHERE id = ?"
      ).get(correction.id)).toEqual({
        status: "PROCESSING",
        mh_dispatch_started_at: null
      });
      expect(database.prepare(
        "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
      ).get(documentId)).toEqual({
        fiscal_operation_claim_id: correction.fiscal_claim_id
      });

      await repository.markFiscalCorrectionMhDispatchStarted(
        correction.id,
        correction.processing_claim_id
      );
      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        outcome
      )).resolves.toBe(true);
    }
    database.close();
  });

  it("releases document ownership only for proven outcomes", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_predispatch_failure");
    seedRejectedDocument(database, "doc_explicit_rejection");
    const repository = new Repository(new SqliteD1(database).database);

    const failed = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_predispatch_failure",
        requestId: "33333333-3333-4333-8333-333333333333"
      })
    );
    if (failed.kind !== "claimed") throw new Error("expected failed correction claim");
    await repository.claimFiscalCorrectionProcessing({
      id: failed.correction.id,
      processingClaimId: failed.correction.processing_claim_id,
      fiscalClaimId: failed.correction.fiscal_claim_id ?? undefined
    });
    await expect(repository.finalizeFiscalCorrection(
      failed.correction.id,
      failed.correction.processing_claim_id,
      { status: "FAILED", failureCode: "BUILD_FAILED", failureMessage: "No se transmitió" }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
    ).get("doc_predispatch_failure")).toEqual({ fiscal_operation_claim_id: null });

    const rejected = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_explicit_rejection",
        requestId: "44444444-4444-4444-8444-444444444444"
      })
    );
    if (rejected.kind !== "claimed") throw new Error("expected rejected correction claim");
    await repository.claimFiscalCorrectionProcessing({
      id: rejected.correction.id,
      processingClaimId: rejected.correction.processing_claim_id,
      fiscalClaimId: rejected.correction.fiscal_claim_id ?? undefined
    });
    await repository.markFiscalCorrectionMhDispatchStarted(
      rejected.correction.id,
      rejected.correction.processing_claim_id
    );
    await expect(repository.finalizeFiscalCorrection(
      rejected.correction.id,
      rejected.correction.processing_claim_id,
      { status: "REJECTED", failureCode: "MH_REJECTED", failureMessage: "Rechazo explícito" }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
    ).get("doc_explicit_rejection")).toEqual({ fiscal_operation_claim_id: null });
    database.close();
  });

  it("lists only stale queued and safe pre-dispatch processing corrections", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    for (const id of ["wompi_stale_queued", "wompi_safe_processing", "wompi_ambiguous_processing"]) {
      seedFailedWompiEvent(database, id);
    }
    const claims = [];
    for (const [index, id] of ["wompi_stale_queued", "wompi_safe_processing", "wompi_ambiguous_processing"].entries()) {
      const result = await repository.claimWompiFiscalCorrection(wompiCorrectionClaimInput({
        wompiEventId: id,
        requestId: `55555555-5555-4555-8555-55555555555${index}`
      }));
      if (result.kind !== "claimed") throw new Error("expected recoverable correction claim");
      claims.push(result.correction);
    }
    database.prepare(
      "UPDATE fiscal_corrections SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(claims[0].id);
    for (const correction of claims.slice(1)) {
      await repository.claimFiscalCorrectionProcessing({
        id: correction.id,
        processingClaimId: correction.processing_claim_id,
        issuanceAttemptId: correction.issuance_attempt_id ?? undefined
      });
      database.prepare(
        "UPDATE fiscal_corrections SET processing_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      ).run(correction.id);
    }
    await repository.markFiscalCorrectionMhDispatchStarted(
      claims[2].id,
      claims[2].processing_claim_id
    );

    expect((await repository.listRecoverableFiscalCorrections(
      "2026-01-01T00:00:00.000Z"
    )).map((correction) => correction.id).sort()).toEqual([
      claims[0].id,
      claims[1].id
    ].sort());
    database.close();
  });

  it("durably fences operational alerts by incident, channel, and target", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);
    const input = {
      kind: "EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert",
      incidentId: "delivery_1",
      channel: "email" as const,
      targetKey: "email:owner@example.org"
    };
    const first = await repository.claimOperationalAlertDelivery(input);
    expect(first).toMatchObject({ kind: "claimed" });
    if (first.kind !== "claimed") throw new Error("expected alert claim");
    await expect(repository.claimOperationalAlertDelivery(input)).resolves.toMatchObject({
      kind: "in_progress",
      id: first.id
    });
    expect(await repository.markOperationalAlertDispatchStarted(first.id, first.claimToken)).toBe(true);
    await repository.finalizeOperationalAlertDelivery(first.id, first.claimToken, {
      status: "SENT"
    });
    await expect(repository.claimOperationalAlertDelivery(input)).resolves.toMatchObject({
      kind: "already_sent",
      id: first.id
    });
    await expect(repository.claimOperationalAlertDelivery({
      ...input,
      incidentId: "delivery_2"
    })).resolves.toMatchObject({ kind: "claimed" });

    database.close();
  });

  it("reclaims only an operational alert proven not sent", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);
    const input = {
      kind: "EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert_retry",
      incidentId: "delivery_retry",
      channel: "email" as const,
      targetKey: "email:owner@example.org"
    };
    const first = await repository.claimOperationalAlertDelivery(input);
    if (first.kind !== "claimed") throw new Error("expected alert claim");
    expect(await repository.markOperationalAlertDispatchStarted(first.id, first.claimToken)).toBe(true);
    await repository.finalizeOperationalAlertDelivery(first.id, first.claimToken, {
      status: "FAILED",
      outcomeClass: "NOT_SENT",
      failureCode: "E_RECIPIENT_NOT_ALLOWED",
      retrySafe: true
    });

    const retried = await repository.claimOperationalAlertDelivery(input);
    expect(retried).toMatchObject({
      kind: "claimed",
      id: first.id
    });
    if (retried.kind !== "claimed") throw new Error("expected alert retry claim");
    expect(retried.claimToken).not.toBe(first.claimToken);
    database.close();
  });

  it("atomically attaches and completes an accepted invalidation", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_invalidation", "2026-06-01T12:00:02.000Z");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentInvalidation("doc_invalidation", "claim_invalidation")).toBe(true);
    const eventId = await repository.createAndAttachDocumentInvalidationEvent({
      documentId: "doc_invalidation",
      claimId: "claim_invalidation",
      environment: "00",
      codigoGeneracion: "70000003-2222-4222-8222-700000032222",
      plainJson: { identificacion: { tipoDte: "15" } },
      signedJws: "signed-invalidation",
      legalDeadlineAt: "2026-07-15T05:59:59.000Z",
      createdBy: "user_operator"
    });

    expect(await repository.completeDocumentInvalidation({
      documentId: "doc_invalidation",
      claimId: "claim_invalidation",
      eventId,
      accepted: true,
      sello: "INVALIDATION-SEAL",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-01T15:00:00.000Z",
      actorId: "user_operator",
      raw: { estado: "PROCESADO" }
    })).toBe(true);

    expect(database.prepare(
      `SELECT status, fiscal_operation_claim_id, fiscal_operation_kind,
              fiscal_operation_event_id
         FROM dte_documents WHERE id = ?`
    ).get("doc_invalidation")).toEqual({
      status: "INVALIDATED",
      fiscal_operation_claim_id: null,
      fiscal_operation_kind: null,
      fiscal_operation_event_id: null
    });
    expect(database.prepare(
      "SELECT status, sello_recibido, mh_estado FROM dte_events WHERE id = ?"
    ).get(eventId)).toEqual({
      status: "ACCEPTED",
      sello_recibido: "INVALIDATION-SEAL",
      mh_estado: "PROCESADO"
    });
    expect(database.prepare(
      "SELECT action, entity_id FROM audit_logs WHERE id = ?"
    ).get(`audit_invalidation_${eventId}`)).toEqual({
      action: "DTE_INVALIDATED",
      entity_id: "doc_invalidation"
    });
    database.close();
  });

  it("excludes every claimed document from status-dependent readers", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES (?, ?, '00', 'Exitosa', 2500, '{}')`
    ).run("wompi_claimed", "transaction_claimed");
    seedAcceptedDocument(database, "doc_claimed_reader", "2026-06-01T12:00:02.000Z", "donor@example.org");
    database.prepare(
      `UPDATE dte_documents
          SET wompi_event_id = ?, fiscal_operation_claim_id = ?,
              fiscal_operation_claimed_at = ?, fiscal_operation_kind = 'TRANSMISSION'
        WHERE id = ?`
    ).run("wompi_claimed", "ambiguous_transmission", "2026-07-14T12:00:00.000Z", "doc_claimed_reader");
    const repository = new Repository(d1.database);
    const range = { startIso: "2026-01-01T00:00:00.000Z", endIso: "2027-01-01T00:00:00.000Z" };

    expect(await repository.listAcceptedDteDocumentsForExport()).toEqual([]);
    expect(await repository.listAcceptedDocumentsInYear(range, null)).toEqual([]);
    expect(await repository.listAcceptedWompiContactRows("00", null, 100, range)).toEqual([]);
    expect(await repository.listWompiLaneDocumentsForAnalytics(range, "00", null)).toEqual([]);
    database.close();
  });

  it("claims and owner-qualifies post-accept finalization", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_finalization", null, "donor@example.org");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization", "finalize_owner")).toBe(true);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization", "finalize_loser")).toBe(false);
    expect(await repository.markDocumentPostAcceptEmailDispatchStarted("doc_finalization", "finalize_loser")).toBe(false);
    expect(await repository.markDocumentPostAcceptEmailDispatchStarted("doc_finalization", "finalize_owner")).toBe(true);
    expect(await repository.markDocumentPostAcceptFinalized("doc_finalization", "finalize_loser")).toBe(false);
    expect(await repository.markDocumentPostAcceptFinalized("doc_finalization", "finalize_owner")).toBe(true);

    expect(database.prepare(
      `SELECT post_accept_finalized_at, post_accept_finalization_claim_id,
              post_accept_finalization_claimed_at, post_accept_email_dispatch_started_at
         FROM dte_documents WHERE id = ?`
    ).get("doc_finalization")).toMatchObject({
      post_accept_finalized_at: expect.any(String),
      post_accept_finalization_claim_id: null,
      post_accept_finalization_claimed_at: null,
      post_accept_email_dispatch_started_at: null
    });
    database.close();
  });

  it("serializes donor-email corrections with accepted-document finalization", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_email_owner", null, "original@example.org");
    const repository = new Repository(d1.database);

    expect(await repository.updateDocumentDonorEmail("doc_email_owner", "before-claim@example.org")).toBe(true);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_email_owner", "finalize_owner")).toBe(true);
    expect(await repository.updateDocumentDonorEmail("doc_email_owner", "racing@example.org")).toBe(false);
    expect(database.prepare("SELECT donor_email FROM dte_documents WHERE id = ?").get("doc_email_owner")).toEqual({
      donor_email: "before-claim@example.org"
    });

    expect(await repository.markDocumentPostAcceptFinalized("doc_email_owner", "finalize_owner")).toBe(true);
    expect(await repository.updateDocumentDonorEmail("doc_email_owner", "after-finalization@example.org")).toBe(true);
    expect(database.prepare("SELECT donor_email FROM dte_documents WHERE id = ?").get("doc_email_owner")).toEqual({
      donor_email: "after-finalization@example.org"
    });
    database.close();
  });

  it("prevents a stale finalizer from completing intent or audit bookkeeping", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_stale_owner", null, null);
    database.prepare(
      `INSERT INTO donation_intents (
         id, status, amount_cents, donor_name, donor_document_type, donor_document,
         donor_email, direccion_departamento, direccion_municipio, direccion_distrito,
         direccion_complemento, expires_at
       ) VALUES (?, 'LINK_CREATED', 2500, 'Donor', '13', '100000001',
                 'donor@example.org', '06', '22', '01', 'Address', ?)`
    ).run("intent_stale_owner", "2099-01-01T00:00:00.000Z");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentPostAcceptFinalization("doc_stale_owner", "owner_a")).toBe(true);
    database.prepare(
      `UPDATE dte_documents
          SET post_accept_finalization_claim_id = ?, post_accept_finalization_claimed_at = ?
        WHERE id = ?`
    ).run("owner_b", "2026-07-14T12:00:00.000Z", "doc_stale_owner");

    expect(await repository.completeIntentForPostAcceptOwner(
      "intent_stale_owner",
      "doc_stale_owner",
      "owner_a"
    )).toBe(false);
    expect(await repository.ensurePostAcceptAudit({
      auditId: "audit_post_accept_doc_stale_owner",
      documentId: "doc_stale_owner",
      claimId: "owner_a",
      action: "ADVANCED_CDE_ACCEPTED",
      entityType: "dte_document",
      entityId: "doc_stale_owner",
      summary: "stale owner must not write"
    })).toBe(false);

    expect(await repository.completeIntentForPostAcceptOwner(
      "intent_stale_owner",
      "doc_stale_owner",
      "owner_b"
    )).toBe(true);
    const audit = {
      auditId: "audit_post_accept_doc_stale_owner",
      documentId: "doc_stale_owner",
      claimId: "owner_b",
      action: "ADVANCED_CDE_ACCEPTED",
      entityType: "dte_document",
      entityId: "doc_stale_owner",
      summary: "current owner writes once"
    };
    expect(await repository.ensurePostAcceptAudit(audit)).toBe(true);
    expect(await repository.ensurePostAcceptAudit(audit)).toBe(true);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE id = ?"
    ).get(audit.auditId)).toEqual({ count: 1 });
    database.close();
  });

  it("recovers a stale pre-dispatch lease but locks an ambiguous post-dispatch lease", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_finalization_crash", null, "donor@example.org");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_before_crash")).toBe(true);
    database.prepare(
      "UPDATE dte_documents SET post_accept_finalization_claimed_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", "doc_finalization_crash");

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_before_dispatch")).toBe(true);
    expect(await repository.markDocumentPostAcceptEmailDispatchStarted("doc_finalization_crash", "owner_before_dispatch")).toBe(true);
    database.prepare(
      "UPDATE dte_documents SET post_accept_finalization_claimed_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", "doc_finalization_crash");

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_ambiguous_retry")).toBe(false);
    expect(database.prepare(
      `SELECT post_accept_finalization_claim_id, post_accept_email_dispatch_started_at
         FROM dte_documents WHERE id = ?`
    ).get("doc_finalization_crash")).toMatchObject({
      post_accept_finalization_claim_id: "owner_before_dispatch",
      post_accept_email_dispatch_started_at: expect.any(String)
    });

    await repository.recordEmailDelivery({
      documentId: "doc_finalization_crash",
      toEmail: "donor@example.org",
      status: "FAILED",
      emailType: "dteReceipt",
      documentStatusAtSend: "REJECTED"
    });
    expect(await repository.hasHandledEmail("doc_finalization_crash", "dteReceipt", "ACCEPTED")).toBe(false);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_with_rejected_evidence")).toBe(false);

    await repository.recordEmailDelivery({
      documentId: "doc_finalization_crash",
      toEmail: "donor@example.org",
      status: "FAILED",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED"
    });
    expect(await repository.hasHandledEmail("doc_finalization_crash", "dteReceipt", "ACCEPTED")).toBe(true);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_with_evidence")).toBe(true);
    database.close();
  });

  it("reclaims only proven-safe or stale pre-dispatch receipt claims", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_delivery_recovery", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);

    const safeInput = {
      documentId: "doc_delivery_recovery",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED"
    };
    const safeClaim = await repository.claimEmailDelivery(safeInput);
    expect(safeClaim).not.toBeNull();
    expect(await repository.markEmailDeliveryDispatchStarted(safeClaim!.id, "wrong-token")).toBe(false);
    expect(await repository.markEmailDeliveryDispatchStarted(safeClaim!.id, safeClaim!.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(safeClaim!.id, safeClaim!.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_HEADER_NOT_ALLOWED" },
      emailType: safeInput.emailType,
      documentStatusAtSend: safeInput.documentStatusAtSend,
      outcomeClass: "NOT_SENT",
      failureCode: "E_HEADER_NOT_ALLOWED",
      retrySafe: true
    });
    await expect(repository.claimEmailDelivery(safeInput)).resolves.toMatchObject({
      id: safeClaim!.id,
      claimToken: expect.any(String)
    });

    const unknownInput = { ...safeInput, emailType: "dteReceiptUnknown" };
    const unknownClaim = await repository.claimEmailDelivery(unknownInput);
    expect(unknownClaim).not.toBeNull();
    expect(await repository.markEmailDeliveryDispatchStarted(unknownClaim!.id, unknownClaim!.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(unknownClaim!.id, unknownClaim!.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_INTERNAL_SERVER_ERROR" },
      emailType: unknownInput.emailType,
      documentStatusAtSend: unknownInput.documentStatusAtSend,
      outcomeClass: "UNKNOWN",
      failureCode: "E_INTERNAL_SERVER_ERROR",
      retrySafe: false
    });
    await expect(repository.claimEmailDelivery(unknownInput)).resolves.toBeNull();

    const preDispatchInput = { ...safeInput, emailType: "dteReceiptPreDispatch" };
    const preDispatchClaim = await repository.claimEmailDelivery(preDispatchInput);
    expect(preDispatchClaim).not.toBeNull();
    database.prepare(
      "UPDATE email_deliveries SET claim_attempted_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", preDispatchClaim!.id);
    await expect(repository.claimEmailDelivery(preDispatchInput)).resolves.toMatchObject({
      id: preDispatchClaim!.id,
      claimToken: expect.any(String)
    });

    const postDispatchInput = { ...safeInput, emailType: "dteReceiptPostDispatch" };
    const postDispatchClaim = await repository.claimEmailDelivery(postDispatchInput);
    expect(postDispatchClaim).not.toBeNull();
    expect(await repository.markEmailDeliveryDispatchStarted(postDispatchClaim!.id, postDispatchClaim!.claimToken)).toBe(true);
    database.prepare(
      "UPDATE email_deliveries SET claim_attempted_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", postDispatchClaim!.id);
    await expect(repository.claimEmailDelivery(postDispatchInput)).resolves.toBeNull();

    database.close();
  });

  it("deduplicates a deliberate resend request and only retries proven-safe outcomes", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_manual_resend", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);
    const input = {
      documentId: "doc_manual_resend",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "11111111-1111-4111-8111-111111111111"
    };

    const first = await repository.claimManualEmailDelivery(input);
    expect(first).toMatchObject({
      kind: "claimed",
      id: expect.any(String),
      idempotencyKey: expect.stringMatching(/^dsv-receipt-resend-v1-[a-f0-9]{64}$/),
      claimToken: expect.any(String),
      attemptNo: 1
    });
    if (first.kind !== "claimed") throw new Error("expected first manual resend claim");
    expect(await repository.markEmailDeliveryDispatchStarted(first.id, first.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(first.id, first.claimToken, {
      status: "SENT",
      providerResponse: { messageId: "manual-resend-1" },
      emailType: input.emailType,
      documentStatusAtSend: input.documentStatusAtSend,
      providerDeliveryId: "manual-resend-1"
    });

    await expect(repository.claimManualEmailDelivery(input)).resolves.toMatchObject({
      kind: "already_sent",
      id: first.id,
      attemptNo: 1
    });
    await expect(repository.claimManualEmailDelivery({
      ...input,
      toEmail: "other@example.org"
    })).resolves.toMatchObject({
      kind: "conflict",
      id: first.id
    });

    const retryInput = {
      ...input,
      resendRequestId: "70000003-2222-4222-8222-700000032222"
    };
    const retryFirst = await repository.claimManualEmailDelivery(retryInput);
    if (retryFirst.kind !== "claimed") throw new Error("expected retry-safe manual resend claim");
    expect(await repository.markEmailDeliveryDispatchStarted(retryFirst.id, retryFirst.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(retryFirst.id, retryFirst.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_HEADER_NOT_ALLOWED" },
      emailType: retryInput.emailType,
      documentStatusAtSend: retryInput.documentStatusAtSend,
      outcomeClass: "NOT_SENT",
      failureCode: "E_HEADER_NOT_ALLOWED",
      retrySafe: true
    });
    const retrySecond = await repository.claimManualEmailDelivery(retryInput);
    expect(retrySecond).toMatchObject({
      kind: "claimed",
      id: retryFirst.id,
      idempotencyKey: retryFirst.idempotencyKey,
      claimToken: expect.any(String),
      attemptNo: 3
    });
    if (retrySecond.kind !== "claimed") throw new Error("expected retry-safe reclaim");
    expect(await repository.markEmailDeliveryDispatchStarted(retrySecond.id, retrySecond.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(retrySecond.id, retrySecond.claimToken, {
      status: "SENT",
      providerResponse: { messageId: "manual-resend-retry" },
      emailType: retryInput.emailType,
      documentStatusAtSend: retryInput.documentStatusAtSend,
      providerDeliveryId: "manual-resend-retry"
    });

    const reviewInput = {
      ...input,
      resendRequestId: "33333333-3333-4333-8333-333333333333"
    };
    const reviewFirst = await repository.claimManualEmailDelivery(reviewInput);
    if (reviewFirst.kind !== "claimed") throw new Error("expected manual-review resend claim");
    expect(await repository.markEmailDeliveryDispatchStarted(reviewFirst.id, reviewFirst.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(reviewFirst.id, reviewFirst.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_INTERNAL_SERVER_ERROR" },
      emailType: reviewInput.emailType,
      documentStatusAtSend: reviewInput.documentStatusAtSend,
      outcomeClass: "UNKNOWN",
      failureCode: "E_INTERNAL_SERVER_ERROR",
      retrySafe: false
    });
    await expect(repository.claimManualEmailDelivery(reviewInput)).resolves.toMatchObject({
      kind: "manual_review",
      id: reviewFirst.id,
      attemptNo: 4,
      outcomeClass: "UNKNOWN"
    });

    database.close();
  });

  it("allocates a new document-wide attempt number for a deliberate resend after success", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_attempt_sequence", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);
    const input = {
      documentId: "doc_attempt_sequence",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "44444444-4444-4444-8444-444444444444"
    };
    const first = await repository.claimManualEmailDelivery(input);
    expect(first).toMatchObject({ kind: "claimed", attemptNo: 1 });
    if (first.kind !== "claimed") throw new Error("expected first manual claim");
    expect(await repository.markEmailDeliveryDispatchStarted(first.id, first.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(first.id, first.claimToken, {
      status: "SENT",
      providerResponse: { messageId: "attempt-1" },
      emailType: input.emailType,
      documentStatusAtSend: input.documentStatusAtSend,
      providerDeliveryId: "attempt-1"
    });

    await expect(repository.claimManualEmailDelivery({
      ...input,
      resendRequestId: "70000005-7777-4777-8777-700000057777"
    })).resolves.toMatchObject({
      kind: "claimed",
      attemptNo: 2
    });
    database.close();
  });

  it("blocks different resend IDs while a receipt attempt is active or ambiguous", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_manual_fence", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);
    const firstInput = {
      documentId: "doc_manual_fence",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "55555555-5555-4555-8555-555555555555"
    };
    const competingInput = {
      ...firstInput,
      resendRequestId: "66666666-6666-4666-8666-666666666666"
    };

    const first = await repository.claimManualEmailDelivery(firstInput);
    expect(first).toMatchObject({ kind: "claimed", attemptNo: 1 });
    if (first.kind !== "claimed") throw new Error("expected first manual claim");

    await expect(repository.claimManualEmailDelivery(competingInput)).resolves.toMatchObject({
      kind: "in_progress",
      id: first.id,
      attemptNo: 1
    });

    expect(await repository.markEmailDeliveryDispatchStarted(first.id, first.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(first.id, first.claimToken, {
      status: "FAILED",
      providerResponse: { code: "EMAIL_DISPATCH_UNKNOWN" },
      emailType: firstInput.emailType,
      documentStatusAtSend: firstInput.documentStatusAtSend,
      outcomeClass: "UNKNOWN",
      failureCode: "EMAIL_DISPATCH_UNKNOWN",
      retrySafe: false
    });

    await expect(repository.claimManualEmailDelivery(competingInput)).resolves.toMatchObject({
      kind: "manual_review",
      id: first.id,
      attemptNo: 1,
      outcomeClass: "UNKNOWN"
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM email_deliveries WHERE document_id = ?"
    ).get("doc_manual_fence")).toEqual({ count: 1 });
    database.close();
  });

  it("blocks a fresh resend when the latest legacy receipt failure is ambiguous without a claim token", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_legacy_ambiguous", "2026-06-01T12:00:02.000Z", "donor@example.org");
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, claim_token,
         outcome_class, retry_safe, attempt_no, created_at
       ) VALUES (?, ?, ?, 'FAILED', '{}', 'dteReceipt', 'ACCEPTED',
                 NULL, NULL, 0, 1, ?)`
    ).run(
      "email_legacy_ambiguous",
      "doc_legacy_ambiguous",
      "donor@example.org",
      "2026-06-01T12:00:03.000Z"
    );
    const repository = new Repository(d1.database);

    await expect(repository.claimManualEmailDelivery({
      documentId: "doc_legacy_ambiguous",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "88888888-8888-4888-8888-888888888888"
    })).resolves.toMatchObject({
      kind: "manual_review",
      id: "email_legacy_ambiguous",
      attemptNo: 1,
      outcomeClass: null
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM email_deliveries WHERE document_id = ?"
    ).get("doc_legacy_ambiguous")).toEqual({ count: 1 });
    database.close();
  });

  it("does not reclaim an older retry-safe request after a newer ambiguous attempt", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_stale_safe_replay", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);
    const safeInput = {
      documentId: "doc_stale_safe_replay",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "99999999-9999-4999-8999-999999999999"
    };
    const safeClaim = await repository.claimManualEmailDelivery(safeInput);
    if (safeClaim.kind !== "claimed") throw new Error("expected retry-safe claim");
    expect(await repository.markEmailDeliveryDispatchStarted(safeClaim.id, safeClaim.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(safeClaim.id, safeClaim.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_HEADER_NOT_ALLOWED" },
      emailType: safeInput.emailType,
      documentStatusAtSend: safeInput.documentStatusAtSend,
      outcomeClass: "NOT_SENT",
      failureCode: "E_HEADER_NOT_ALLOWED",
      retrySafe: true
    });

    const ambiguousInput = {
      ...safeInput,
      resendRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    };
    const ambiguousClaim = await repository.claimManualEmailDelivery(ambiguousInput);
    if (ambiguousClaim.kind !== "claimed") throw new Error("expected ambiguous claim");
    expect(await repository.markEmailDeliveryDispatchStarted(ambiguousClaim.id, ambiguousClaim.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(ambiguousClaim.id, ambiguousClaim.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_INTERNAL_SERVER_ERROR" },
      emailType: ambiguousInput.emailType,
      documentStatusAtSend: ambiguousInput.documentStatusAtSend,
      outcomeClass: "UNKNOWN",
      failureCode: "E_INTERNAL_SERVER_ERROR",
      retrySafe: false
    });

    await expect(repository.claimManualEmailDelivery(safeInput)).resolves.toMatchObject({
      kind: "manual_review",
      id: ambiguousClaim.id,
      attemptNo: 2,
      outcomeClass: "UNKNOWN"
    });
    expect(database.prepare(
      "SELECT status, attempt_no FROM email_deliveries WHERE id = ?"
    ).get(safeClaim.id)).toEqual({ status: "FAILED", attempt_no: 1 });
    database.close();
  });

  it("orders the latest receipt outcome by document attempt number before tied timestamps", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_latest_attempt", "2026-06-01T12:00:02.000Z", "donor@example.org");
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, outcome_class, failure_code,
         retry_safe, attempt_no, created_at
       ) VALUES (?, ?, ?, ?, '{}', 'dteReceipt', 'ACCEPTED', ?, ?, ?, ?, ?)`
    ).run(
      "email_z_older_attempt",
      "doc_latest_attempt",
      "donor@example.org",
      "FAILED",
      "UNKNOWN",
      "EMAIL_DISPATCH_UNKNOWN",
      0,
      1,
      "2026-07-17T17:00:00.000Z"
    );
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, retry_safe, attempt_no, created_at
       ) VALUES (?, ?, ?, 'SENT', '{}', 'dteReceipt', 'ACCEPTED', 0, ?, ?)`
    ).run(
      "email_a_newer_attempt",
      "doc_latest_attempt",
      "donor@example.org",
      2,
      "2026-07-17T17:00:00.000Z"
    );
    const repository = new Repository(d1.database);

    await expect(repository.listDteDocuments({ attention: "failures" })).resolves.toMatchObject({
      documents: []
    });
    database.close();
  });

  it("surfaces post-dispatch pending receipts for manual review but not pre-dispatch work", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_pending_review", "2026-06-01T12:00:02.000Z", "donor@example.org", "5");
    seedAcceptedDocument(database, "doc_pending_pre_dispatch", "2026-06-01T12:00:03.000Z", "donor@example.org", "6");
    const insert = database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, claim_attempted_at,
         provider_dispatch_started_at, idempotency_key, claim_token, attempt_no,
         created_at
       ) VALUES (?, ?, 'donor@example.org', 'PENDING', '{}', 'dteReceipt',
                 'ACCEPTED', ?, ?, ?, ?, 1, ?)`
    );
    insert.run(
      "email_pending_review",
      "doc_pending_review",
      "2026-07-17T17:00:00.000Z",
      "2026-07-17T17:00:01.000Z",
      "pending-review-key",
      "pending-review-claim",
      "2026-07-17T17:00:00.000Z"
    );
    insert.run(
      "email_pending_pre_dispatch",
      "doc_pending_pre_dispatch",
      "2026-07-17T17:00:00.000Z",
      null,
      "pending-pre-dispatch-key",
      "pending-pre-dispatch-claim",
      "2026-07-17T17:00:00.000Z"
    );
    const repository = new Repository(d1.database);

    await expect(repository.listDteDocuments({ attention: "failures" })).resolves.toMatchObject({
      documents: [
        expect.objectContaining({
          id: "doc_pending_review",
          receipt_email_status: "PENDING",
          receipt_email_requires_review: 1
        })
      ]
    });
    await expect(repository.getLatestReceiptEmailDelivery("doc_pending_review")).resolves.toMatchObject({
      status: "PENDING",
      requiresReview: true
    });
    database.close();
  });

  it("upgrades a populated pre-0025 database with duplicate legacy claimed failures", () => {
    const database = migratedDatabaseThrough("0024");
    seedAcceptedDocument(database, "doc_legacy_delivery", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const insert = database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, claim_attempted_at,
         idempotency_key, claim_token, created_at
       ) VALUES (?, 'doc_legacy_delivery', 'donor@example.org', 'FAILED', '{}',
                 'dteReceipt', 'ACCEPTED', ?, ?, ?, ?)`
    );
    insert.run(
      "legacy_failure_1",
      "2026-07-17T17:00:00.000Z",
      "legacy-key-1",
      "legacy-claim-1",
      "2026-07-17T17:00:00.000Z"
    );
    insert.run(
      "legacy_failure_2",
      "2026-07-17T17:01:00.000Z",
      "legacy-key-2",
      "legacy-claim-2",
      "2026-07-17T17:01:00.000Z"
    );

    expect(() => database.exec(
      readFileSync(resolve(migrationsDirectory, "0025_email_delivery_recovery.sql"), "utf8")
    )).not.toThrow();
    expect(database.prepare(
      `SELECT retry_safe, attempt_no
         FROM email_deliveries
        WHERE id = 'legacy_failure_1'`
    ).get()).toEqual({ retry_safe: 0, attempt_no: 1 });
    expect(database.prepare(
      `SELECT id, claim_token
         FROM email_deliveries
        WHERE document_id = 'doc_legacy_delivery'
        ORDER BY created_at, id`
    ).all()).toEqual([
      { id: "legacy_failure_1", claim_token: null },
      { id: "legacy_failure_2", claim_token: "legacy-claim-2" }
    ]);
    database.close();
  });

  it("classifies only the known pre-dispatch legacy header rejection as retry-safe", async () => {
    const database = migratedDatabaseThrough("0025");
    seedAcceptedDocument(database, "doc_legacy_header_rejection", "2026-06-01T12:00:02.000Z", "donor@example.org", "5");
    seedAcceptedDocument(database, "doc_legacy_unknown_failure", "2026-06-01T12:00:02.000Z", "donor@example.org", "6");
    seedAcceptedDocument(database, "doc_legacy_post_dispatch", "2026-06-01T12:00:02.000Z", "donor@example.org", "7");
    const headerRejection =
      "custom header 'Idempotency-Key' is not allowed. Only whitelisted headers and X-* headers are accepted.";
    const insert = database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, provider_dispatch_started_at,
         outcome_class, failure_code, retry_safe, attempt_no, created_at
       ) VALUES (?, ?, 'donor@example.org', 'FAILED', ?, 'dteReceipt',
                 'ACCEPTED', ?, NULL, NULL, 0, 1, ?)`
    );
    insert.run(
      "legacy_header_rejection",
      "doc_legacy_header_rejection",
      JSON.stringify({ error: headerRejection }),
      null,
      "2026-07-17T17:00:00.000Z"
    );
    insert.run(
      "legacy_unknown_failure",
      "doc_legacy_unknown_failure",
      JSON.stringify({ error: "provider request timed out" }),
      null,
      "2026-07-17T17:01:00.000Z"
    );
    insert.run(
      "legacy_post_dispatch",
      "doc_legacy_post_dispatch",
      JSON.stringify({ error: headerRejection }),
      "2026-07-17T17:02:00.000Z",
      "2026-07-17T17:02:00.000Z"
    );

    for (const filename of readdirSync(migrationsDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) > "0025")
      .sort()) {
      database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
    }

    expect(database.prepare(
      `SELECT id, outcome_class, failure_code, retry_safe
         FROM email_deliveries
        WHERE id LIKE 'legacy_%'
        ORDER BY id`
    ).all()).toEqual([
      {
        id: "legacy_header_rejection",
        outcome_class: "NOT_SENT",
        failure_code: "E_HEADER_NOT_ALLOWED",
        retry_safe: 1
      },
      {
        id: "legacy_post_dispatch",
        outcome_class: null,
        failure_code: null,
        retry_safe: 0
      },
      {
        id: "legacy_unknown_failure",
        outcome_class: null,
        failure_code: null,
        retry_safe: 0
      }
    ]);

    const repository = new Repository(new SqliteD1(database).database);
    await expect(repository.claimManualEmailDelivery({
      documentId: "doc_legacy_header_rejection",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "99999999-9999-4999-8999-999999999999"
    })).resolves.toMatchObject({ kind: "claimed", attemptNo: 2 });
    await expect(repository.claimManualEmailDelivery({
      documentId: "doc_legacy_unknown_failure",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    })).resolves.toMatchObject({ kind: "manual_review", outcomeClass: null });
    await expect(repository.claimManualEmailDelivery({
      documentId: "doc_legacy_post_dispatch",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    })).resolves.toMatchObject({ kind: "manual_review", outcomeClass: null });
    database.close();
  });

  it("clears an older ambiguous claim when a newer terminal legacy receipt supersedes it", async () => {
    const database = migratedDatabaseThrough("0024");
    seedAcceptedDocument(database, "doc_legacy_superseded", "2026-06-01T12:00:02.000Z", "donor@example.org");
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, claim_attempted_at,
         idempotency_key, claim_token, created_at
       ) VALUES ('legacy_ambiguous_claim', 'doc_legacy_superseded',
                 'donor@example.org', 'FAILED', '{}', 'dteReceipt',
                 'ACCEPTED', '2026-07-17T17:00:00.000Z',
                 'legacy-ambiguous-key', 'legacy-ambiguous-claim',
                 '2026-07-17T17:00:00.000Z')`
    ).run();
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, sent_at, created_at
       ) VALUES ('legacy_later_sent', 'doc_legacy_superseded',
                 'donor@example.org', 'SENT', '{}', 'dteReceipt',
                 'ACCEPTED', '2026-07-17T17:01:00.000Z',
                 '2026-07-17T17:01:00.000Z')`
    ).run();

    database.exec(
      readFileSync(resolve(migrationsDirectory, "0025_email_delivery_recovery.sql"), "utf8")
    );
    expect(database.prepare(
      "SELECT claim_token FROM email_deliveries WHERE id = 'legacy_ambiguous_claim'"
    ).get()).toEqual({ claim_token: null });

    const repository = new Repository(new SqliteD1(database).database);
    await expect(repository.claimManualEmailDelivery({
      documentId: "doc_legacy_superseded",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    })).resolves.toMatchObject({
      kind: "claimed",
      attemptNo: 2
    });
    database.close();
  });

  it("skips more than one page of reconciliation-locked fiscal work", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    const insert = database.prepare(
      `INSERT INTO dte_documents (
         id, environment, codigo_generacion, numero_control, status, plain_json,
         signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
         accepted_at, transmission_deferred_at, post_accept_finalized_at,
         fiscal_operation_claim_id, fiscal_operation_claimed_at, fiscal_operation_kind,
         post_accept_finalization_claim_id, post_accept_finalization_claimed_at,
         post_accept_email_dispatch_started_at, donor_email, created_at, updated_at
       ) VALUES (?, '00', ?, ?, ?, '{}', 'signed-document', ?, ?, 2500, ?, ?, ?, NULL,
                 ?, ?, 'TRANSMISSION', ?, ?, ?, 'donor@example.org', ?, ?)`
    );
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const createdAt = `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.${suffix}Z`;
      insert.run(
        `accepted_locked_${suffix}`,
        `accepted-generation-${suffix}`,
        `accepted-control-${suffix}`,
        "ACCEPTED",
        "DOCUMENT-SEAL",
        "PROCESADO",
        createdAt,
        createdAt,
        null,
        `transmission_claim_${suffix}`,
        "2000-01-01T00:00:00.000Z",
        `finalization_claim_${suffix}`,
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:01.000Z",
        createdAt,
        createdAt
      );
      insert.run(
        `deferred_locked_${suffix}`,
        `deferred-generation-${suffix}`,
        `deferred-control-${suffix}`,
        "SIGNED",
        null,
        "MH_NO_DISPONIBLE",
        createdAt,
        null,
        createdAt,
        `deferred_claim_${suffix}`,
        "2000-01-01T00:00:00.000Z",
        null,
        null,
        null,
        createdAt,
        createdAt
      );
    }
    insert.run(
      "accepted_claimable_after_locked",
      "accepted-generation-claimable",
      "accepted-control-claimable",
      "ACCEPTED",
      "DOCUMENT-SEAL",
      "PROCESADO",
      "2026-12-01T00:00:00.000Z",
      "2026-12-01T00:00:01.000Z",
      null,
      null,
      null,
      null,
      null,
      null,
      "2026-12-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z"
    );
    insert.run(
      "deferred_claimable_after_locked",
      "deferred-generation-claimable",
      "deferred-control-claimable",
      "SIGNED",
      null,
      "MH_NO_DISPONIBLE",
      "2026-12-01T00:00:00.000Z",
      null,
      "2026-12-01T00:00:01.000Z",
      null,
      null,
      null,
      null,
      null,
      "2026-12-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z"
    );
    const repository = new Repository(d1.database);

    expect((await repository.listPendingPostAcceptFinalizations(100)).map((row) => row.id)).toEqual([
      "accepted_claimable_after_locked"
    ]);
    expect((await repository.listDeferredTransmissionDocuments(100)).map((row) => row.id)).toEqual([
      "deferred_claimable_after_locked"
    ]);
    database.close();
  });
});

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  readonly database = {
    prepare: (sql: string) => new SqliteStatement(this.sqlite, sql),
    batch: async (statements: SqliteStatement[]) => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

class SqliteStatement {
  private args: SQLInputValue[] = [];
  private readonly statement: StatementSync;

  constructor(database: DatabaseSync, sql: string) {
    this.statement = database.prepare(sql);
  }

  bind(...args: unknown[]): this {
    this.args = args as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<D1Result> {
    return this.runSync() as unknown as D1Result;
  }

  runSync(): { success: true; meta: { changes: number }; results: never[] } {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

function migratedDatabase(): DatabaseSync {
  return migratedDatabaseThrough(null);
}

function migratedDatabaseThrough(lastMigrationPrefix: string | null): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    if (lastMigrationPrefix && filename.slice(0, 4) > lastMigrationPrefix) {
      break;
    }
    database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
  }
  database.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, password_salt)
     VALUES ('user_operator', 'operator@example.org', 'Operator', 'OPERATOR', 'hash', 'salt')`
  ).run();
  return database;
}

function seedAcceptedDocument(
  database: DatabaseSync,
  id: string,
  finalizedAt: string | null,
  donorEmail: string | null = null,
  documentSuffix = id === "doc_invalidation" ? "3" : "4"
): void {
  database.prepare(
    `INSERT INTO dte_documents (
       id, environment, codigo_generacion, numero_control, status, plain_json,
       signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
       accepted_at, post_accept_finalized_at, donor_email, created_at, updated_at
     ) VALUES (?, '00', ?, ?, 'ACCEPTED', '{}', 'signed-document',
               'DOCUMENT-SEAL', 'PROCESADO', 2500, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `33333333-3333-4333-8333-33333333333${documentSuffix}`,
    `DTE-15-M001P001-00000000000000${documentSuffix}`,
    "2026-06-01T12:00:00.000Z",
    "2026-06-01T12:00:01.000Z",
    finalizedAt,
    donorEmail,
    "2026-06-01T12:00:00.000Z",
    "2026-06-01T12:00:01.000Z"
  );
}

function seedFailedWompiEvent(database: DatabaseSync, id: string): void {
  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body,
       issuance_status, issuance_attempt_id, issuance_error_code,
       issuance_error_message, processed_at
     ) VALUES (?, ?, '00', 'ExitosaAprobada', 2500, '{}', 'FAILED',
       'previous-attempt', 'INVALID_DUI', 'DUI inválido', ?)`
  ).run(id, `transaction_${id}`, "2026-07-18T12:00:00.000Z");
}

function seedRejectedDocument(database: DatabaseSync, id: string): void {
  database.prepare(
    `INSERT INTO dte_documents (
       id, environment, codigo_generacion, numero_control, status, plain_json,
       signed_jws, sello_recibido, mh_estado, mh_observaciones_json, amount_cents,
       issued_at, created_at, updated_at
     ) VALUES (?, '00', ?, ?, 'REJECTED', ?, 'rejected-jws', NULL, 'RECHAZADO',
       '["Receptor inválido"]', 2500, '2026-07-18T12:00:00.000Z',
       '2026-07-18T12:00:00.000Z', '2026-07-18T12:01:00.000Z')`
  ).run(
    id,
    `generation_${id}`,
    `control_${id}`,
    '{"identificacion":{"tipoDte":"15"}}'
  );
}

function wompiCorrectionClaimInput(overrides: Record<string, string> = {}) {
  return {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestPayloadSha256: "payload-sha256",
    wompiEventId: "wompi_bad_dui",
    environment: "00" as const,
    beforeReceptorJson: JSON.stringify({ nombre: "Donante anterior" }),
    correctedReceptorJson: JSON.stringify({ nombre: "Donante corregida" }),
    changedFieldsJson: JSON.stringify(["nombre"]),
    createdBy: "user_operator",
    ...overrides
  };
}

function documentCorrectionClaimInput(overrides: Record<string, string> = {}) {
  return {
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    requestPayloadSha256: "document-payload-sha256",
    documentId: "doc_rejected",
    environment: "00" as const,
    beforeReceptorJson: JSON.stringify({ nombre: "Donante anterior" }),
    correctedReceptorJson: JSON.stringify({ nombre: "Donante corregida" }),
    changedFieldsJson: JSON.stringify(["nombre"]),
    createdBy: "user_operator",
    ...overrides
  };
}
