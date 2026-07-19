import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RETENTION_FOREIGN_KEY_PROTOCOL } from "../../src/worker/services/retention";
import { Repository } from "../../src/worker/storage/repository";
import { SqliteD1 } from "./support/sqliteD1";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("fiscal repository SQL on SQLite", () => {
  it("does not claim a generic retry after the observed failure becomes receptor-correctable", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_retry_failure_race";
    seedFailedWompiEvent(database, wompiEventId);
    database.prepare(
      `UPDATE wompi_events
          SET issuance_error_code = 'ISSUANCE_ERROR',
              issuance_error_message = 'El proveedor no respondió.'
        WHERE id = ?`
    ).run(wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const observed = await observedWompiRetry(repository, wompiEventId);
    database.prepare(
      `UPDATE wompi_events
          SET issuance_error_code = 'WOMPI_INVALID_DONOR_DUI',
              issuance_error_message = 'Los datos del donante contienen un DUI inválido.'
        WHERE id = ?`
    ).run(wompiEventId);

    await expect(repository.claimWompiIssuanceRetry(
      wompiEventId,
      "user_operator",
      observed
    )).resolves.toBeNull();
    expect(database.prepare(
      `SELECT issuance_status, processed_at, issuance_attempt_id,
              issuance_error_code, issuance_error_message
         FROM wompi_events
        WHERE id = ?`
    ).get(wompiEventId)).toEqual({
      issuance_status: "FAILED",
      processed_at: "2026-07-18T12:00:00.000Z",
      issuance_attempt_id: "previous-attempt",
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "Los datos del donante contienen un DUI inválido."
    });
    database.close();
  });

  it("clears terminal processed evidence when an operator queues a generic retry", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_operator_retry";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);

    await expect(repository.claimWompiIssuanceRetry(
      wompiEventId,
      "user_operator",
      await observedWompiRetry(repository, wompiEventId)
    )).resolves.toEqual(expect.any(String));
    expect(database.prepare(
      `SELECT issuance_status, processed_at, issuance_attempt_id
         FROM wompi_events WHERE id = ?`
    ).get(wompiEventId)).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      processed_at: null,
      issuance_attempt_id: expect.any(String)
    });
    database.close();
  });

  it.each(["RETRY_QUEUED", "PROCESSING"] as const)(
    "claims a non-correctable legacy terminal row stuck in %s",
    async (issuanceStatus) => {
      const database = migratedDatabase();
      const wompiEventId = `wompi_operator_legacy_${issuanceStatus.toLowerCase()}`;
      seedFailedWompiEvent(database, wompiEventId);
      database.prepare(
        `UPDATE wompi_events
            SET issuance_status = ?,
                issuance_attempt_id = 'legacy-stuck-attempt'
          WHERE id = ?`
      ).run(issuanceStatus, wompiEventId);
      const repository = new Repository(new SqliteD1(database).database);

      await expect(repository.claimWompiIssuanceRetry(
        wompiEventId,
        "user_operator",
        await observedWompiRetry(repository, wompiEventId)
      )).resolves.toEqual(expect.any(String));
      expect(database.prepare(
        `SELECT issuance_status, processed_at, issuance_attempt_id
           FROM wompi_events WHERE id = ?`
      ).get(wompiEventId)).toMatchObject({
        issuance_status: "RETRY_QUEUED",
        processed_at: null,
        issuance_attempt_id: expect.not.stringMatching(/^legacy-/)
      });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM audit_logs
          WHERE action = 'WOMPI_ISSUANCE_RETRY_QUEUED'
            AND entity_id = ?`
      ).get(wompiEventId)).toEqual({ count: 1 });
      database.close();
    }
  );

  it("keeps generic retry off rows owned by an issuance claim or active correction", async () => {
    const database = migratedDatabase();
    const heldEventId = "wompi_operator_held_claim";
    const correctedEventId = "wompi_operator_active_correction";
    seedFailedWompiEvent(database, heldEventId);
    seedFailedWompiEvent(database, correctedEventId);
    database.prepare(
      `UPDATE wompi_events
          SET issuance_status = 'PROCESSING',
              issuance_claim_id = 'held-issuance-claim',
              issuance_claimed_at = '2026-07-18T12:05:00.000Z'
        WHERE id = ?`
    ).run(heldEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const active = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: correctedEventId,
        requestId: "06060606-0606-4606-8606-060606060606"
      })
    );
    if (active.kind !== "claimed") throw new Error("expected active correction");
    database.prepare(
      `UPDATE wompi_events
          SET issuance_status = 'PROCESSING',
              processed_at = '2026-07-18T12:05:00.000Z'
        WHERE id = ?`
    ).run(correctedEventId);

    await expect(repository.claimWompiIssuanceRetry(
      heldEventId,
      "user_operator",
      await observedWompiRetry(repository, heldEventId)
    )).resolves.toBeNull();
    await expect(repository.claimWompiIssuanceRetry(
      correctedEventId,
      "user_operator",
      await observedWompiRetry(repository, correctedEventId)
    )).resolves.toBeNull();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections WHERE wompi_event_id = ?"
    ).get(correctedEventId)).toEqual({ count: 1 });
    database.close();
  });

  it("does not sweep a legacy terminal row whose in-flight status is stale", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_legacy_terminal";
    seedFailedWompiEvent(database, wompiEventId);
    database.prepare(
      `UPDATE wompi_events
          SET issuance_status = 'PROCESSING',
              issuance_attempt_id = 'legacy-stuck-attempt',
              issuance_last_attempt_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);

    await expect(repository.listStalledApprovedWompiEvents(
      "2026-01-01T00:00:00.000Z"
    )).resolves.toEqual([]);
    await expect(repository.claimStalledWompiIssuanceAttempt(
      wompiEventId,
      "legacy-stuck-attempt",
      "2026-01-01T00:00:00.000Z"
    )).resolves.toBeNull();
    expect(database.prepare(
      `SELECT issuance_status, processed_at, issuance_attempt_id
         FROM wompi_events WHERE id = ?`
    ).get(wompiEventId)).toEqual({
      issuance_status: "PROCESSING",
      processed_at: "2026-07-18T12:00:00.000Z",
      issuance_attempt_id: "legacy-stuck-attempt"
    });
    database.close();
  });

  it("claims exactly one guarded correction for a legacy stuck correctable event", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_legacy_stuck_correction";
    seedFailedWompiEvent(database, wompiEventId);
    database.prepare(
      `UPDATE wompi_events
          SET issuance_status = 'PROCESSING',
              issuance_attempt_id = 'legacy-stuck-attempt',
              issuance_last_attempt_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);

    const [first, second] = await Promise.all([
      repository.claimWompiFiscalCorrection(
        wompiCorrectionClaimInput({
          wompiEventId,
          requestId: "01010101-0101-4101-8101-010101010101"
        })
      ),
      repository.claimWompiFiscalCorrection(
        wompiCorrectionClaimInput({
          wompiEventId,
          requestId: "02020202-0202-4202-8202-020202020202"
        })
      )
    ]);

    expect([first.kind, second.kind].sort()).toEqual(["claimed", "ineligible"]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections WHERE wompi_event_id = ?"
    ).get(wompiEventId)).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT issuance_status, processed_at, issuance_attempt_id
         FROM wompi_events WHERE id = ?`
    ).get(wompiEventId)).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      processed_at: null,
      issuance_attempt_id: expect.any(String)
    });
    database.close();
  });

  it("keeps a legacy row blocked while an active correction owns it", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_legacy_active_correction";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const first = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "03030303-0303-4303-8303-030303030303"
      })
    );
    if (first.kind !== "claimed") throw new Error("expected active correction");
    database.prepare(
      `UPDATE wompi_events
          SET issuance_status = 'PROCESSING',
              processed_at = '2026-07-18T12:05:00.000Z'
        WHERE id = ?`
    ).run(wompiEventId);

    await expect(repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "04040404-0404-4404-8404-040404040404"
      })
    )).resolves.toEqual({ kind: "ineligible" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections WHERE wompi_event_id = ?"
    ).get(wompiEventId)).toEqual({ count: 1 });
    database.close();
  });

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

  it("couples the queued audit to the claim and reconciles it on duplicate requests", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_audit_duplicate";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const input = wompiCorrectionClaimInput({
      wompiEventId,
      requestId: "31313131-3131-4131-8131-313131313131"
    });
    const first = await repository.claimWompiFiscalCorrection(input);
    if (first.kind !== "claimed") throw new Error("expected audited correction claim");
    expect(database.prepare(
      `SELECT action, entity_id FROM audit_logs
        WHERE entity_type = 'fiscal_correction'`
    ).all()).toEqual([{
      action: "FISCAL_CORRECTION_QUEUED",
      entity_id: first.correction.id
    }]);

    database.prepare(
      `DELETE FROM audit_logs
        WHERE action = 'FISCAL_CORRECTION_QUEUED' AND entity_id = ?`
    ).run(first.correction.id);
    await expect(repository.claimWompiFiscalCorrection(input)).resolves.toMatchObject({
      kind: "duplicate",
      correction: { id: first.correction.id }
    });
    expect(database.prepare(
      `SELECT action FROM audit_logs
        WHERE entity_type = 'fiscal_correction' AND entity_id = ?`
    ).all(first.correction.id)).toEqual([{
      action: "FISCAL_CORRECTION_QUEUED"
    }]);
    database.close();
  });

  it("does not attribute a reconciled queued audit to the duplicate caller", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_audit_duplicate_context";
    seedFailedWompiEvent(database, wompiEventId);
    const input = wompiCorrectionClaimInput({
      wompiEventId,
      requestId: "31313131-3131-4131-8131-313131313132"
    });
    const firstRepository = new Repository(new SqliteD1(database).database);
    const first = await firstRepository.claimWompiFiscalCorrection(input);
    if (first.kind !== "claimed") throw new Error("expected audited correction claim");
    database.prepare(
      `DELETE FROM audit_logs
        WHERE action = 'FISCAL_CORRECTION_QUEUED' AND entity_id = ?`
    ).run(first.correction.id);

    const replayRepository = new Repository(new SqliteD1(database).database, {
      ip: "198.51.100.77",
      context: { country: "US", userAgent: "Duplicate replay" }
    });
    await expect(replayRepository.claimWompiFiscalCorrection(input)).resolves.toMatchObject({
      kind: "duplicate",
      correction: { id: first.correction.id }
    });

    const recovered = database.prepare(
      `SELECT actor_ip, actor_context, metadata_json
         FROM audit_logs
        WHERE action = 'FISCAL_CORRECTION_QUEUED' AND entity_id = ?`
    ).get(first.correction.id) as {
      actor_ip: string | null;
      actor_context: string | null;
      metadata_json: string;
    };
    expect(recovered.actor_ip).toBeNull();
    expect(recovered.actor_context).toBeNull();
    expect(JSON.parse(recovered.metadata_json)).toMatchObject({ auditRecovered: true });
    database.close();
  });

  it("preserves request context only on the initial user fiscal-correction audit", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_audit_request_context";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database, {
      ip: " 203.0.113.42 ",
      context: {
        country: " SV ",
        city: " San Salvador ",
        asn: 64500,
        userAgent: " Fiscal Console "
      }
    });
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "32323232-3232-4232-8232-323232323233"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected contextual correction claim");

    await expect(repository.claimFiscalCorrectionProcessing({
      id: claimed.correction.id,
      processingClaimId: claimed.correction.processing_claim_id,
      issuanceAttemptId: claimed.correction.issuance_attempt_id ?? undefined
    })).resolves.toBe("claimed");

    const rows = database.prepare(
      `SELECT action, actor_type, actor_ip, actor_context
         FROM audit_logs
        WHERE entity_type = 'fiscal_correction' AND entity_id = ?
        ORDER BY CASE action
          WHEN 'FISCAL_CORRECTION_QUEUED' THEN 1
          ELSE 2
        END`
    ).all(claimed.correction.id) as Array<{
      action: string;
      actor_type: string;
      actor_ip: string | null;
      actor_context: string | null;
    }>;
    expect(rows[0]).toMatchObject({
      action: "FISCAL_CORRECTION_QUEUED",
      actor_type: "USER",
      actor_ip: "203.0.113.42"
    });
    expect(JSON.parse(rows[0].actor_context ?? "{}")).toEqual({
      country: "SV",
      city: "San Salvador",
      asn: 64500,
      userAgent: "Fiscal Console"
    });
    expect(rows[1]).toEqual({
      action: "FISCAL_CORRECTION_STARTED",
      actor_type: "SYSTEM",
      actor_ip: null,
      actor_context: null
    });
    database.close();
  });

  it("rolls back a correction claim when its required queued audit cannot persist", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_audit_claim_rollback";
    seedFailedWompiEvent(database, wompiEventId);
    database.exec(`
      CREATE TRIGGER block_fiscal_queued_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'FISCAL_CORRECTION_QUEUED'
      BEGIN
        SELECT RAISE(ABORT, 'blocked queued audit');
      END;
    `);
    const repository = new Repository(new SqliteD1(database).database);

    await expect(repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "32323232-3232-4232-8232-323232323232"
      })
    )).rejects.toThrow("blocked queued audit");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections"
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT issuance_status, issuance_attempt_id
         FROM wompi_events WHERE id = ?`
    ).get(wompiEventId)).toEqual({
      issuance_status: "FAILED",
      issuance_attempt_id: "previous-attempt"
    });
    database.close();
  });

  it("rolls back started and failed transitions when their required audits fail", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_audit_transition_rollback";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "33333333-3333-4333-8333-333333333333"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected transition audit claim");
    const correction = claimed.correction;
    database.exec(`
      CREATE TRIGGER block_fiscal_started_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'FISCAL_CORRECTION_STARTED'
      BEGIN
        SELECT RAISE(ABORT, 'blocked started audit');
      END;
    `);

    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    })).rejects.toThrow("blocked started audit");
    expect(database.prepare(
      "SELECT status, processing_started_at FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({
      status: "QUEUED",
      processing_started_at: null
    });
    database.exec("DROP TRIGGER block_fiscal_started_audit");
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    })).resolves.toBe("claimed");

    database.exec(`
      CREATE TRIGGER block_fiscal_failed_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'FISCAL_CORRECTION_FAILED'
      BEGIN
        SELECT RAISE(ABORT, 'blocked failed audit');
      END;
    `);
    await expect(repository.finalizeWompiFiscalCorrectionFailure(
      correction.id,
      correction.processing_claim_id,
      { failureCode: "PRE_DISPATCH", failureMessage: "No enviado" }
    )).rejects.toThrow("blocked failed audit");
    expect(database.prepare(
      "SELECT status, completed_at FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({
      status: "PROCESSING",
      completed_at: null
    });
    expect(database.prepare(
      "SELECT issuance_status FROM wompi_events WHERE id = ?"
    ).get(wompiEventId)).toEqual({ issuance_status: "RETRY_QUEUED" });

    database.exec("DROP TRIGGER block_fiscal_failed_audit");
    await expect(repository.finalizeWompiFiscalCorrectionFailure(
      correction.id,
      correction.processing_claim_id,
      { failureCode: "PRE_DISPATCH", failureMessage: "No enviado" }
    )).resolves.toBe(true);
    expect(database.prepare(
      `SELECT action FROM audit_logs
        WHERE entity_type = 'fiscal_correction' AND entity_id = ?
        ORDER BY CASE action
          WHEN 'FISCAL_CORRECTION_QUEUED' THEN 1
          WHEN 'FISCAL_CORRECTION_STARTED' THEN 2
          ELSE 3
        END`
    ).all(correction.id)).toEqual([
      { action: "FISCAL_CORRECTION_QUEUED" },
      { action: "FISCAL_CORRECTION_STARTED" },
      { action: "FISCAL_CORRECTION_FAILED" }
    ]);
    database.close();
  });

  it("durably claims a pre-dispatch Wompi document before quarantining its correction", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_existing_document_quarantine";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "53535353-5353-4353-8353-535353535353"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected Wompi correction claim");
    const correction = claimed.correction;
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    })).resolves.toBe("claimed");
    const issuanceClaimId = `wompi_correction_${correction.id}`;
    await expect(repository.claimCorrectedWompiEventIssuance({
      id: wompiEventId,
      claimId: issuanceClaimId,
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    })).resolves.toBe(true);
    const reserved = await repository.reserveWompiDocumentIdentifiers(
      wompiEventId,
      "00",
      "M001P004"
    );
    const document = await repository.createClaimedWompiDteDocument({
      wompiEventId,
      issuanceClaimId,
      environment: "00",
      codigoGeneracion: reserved.codigoGeneracion,
      numeroControl: reserved.numeroControl,
      plainJson: { identificacion: { tipoDte: "15" } },
      donorEmail: "quarantine@example.org",
      donorName: "Donante en cuarentena",
      amountCents: 2500,
      issuedAt: "2026-07-18T12:02:00.000Z"
    });
    if (!document) throw new Error("expected claimed Wompi document");

    await expect(repository.updateDocumentSigned(
      document.id,
      "signed-before-correction-fence",
      "PENDING"
    )).resolves.toBe(true);
    await expect(repository.claimDocumentTransmission(
      document.id,
      "SIGNED",
      "signed-before-correction-fence",
      "generic-retry-must-not-win"
    )).resolves.toBe(false);

    await expect(repository.claimWompiFiscalCorrectionDocument({
      correctionId: correction.id,
      processingClaimId: "stale-processing-claim",
      issuanceAttemptId: correction.issuance_attempt_id!,
      documentId: document.id
    })).resolves.toBe(false);
    await expect(repository.claimWompiFiscalCorrectionDocument({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!,
      documentId: document.id
    })).resolves.toBe(true);

    const quarantineClaimId = `fiscal_correction_${correction.id}`;
    expect(database.prepare(
      `SELECT status, fiscal_operation_claim_id, fiscal_operation_kind,
              fiscal_operation_event_id
         FROM dte_documents WHERE id = ?`
    ).get(document.id)).toEqual({
      status: "SIGNED",
      fiscal_operation_claim_id: quarantineClaimId,
      fiscal_operation_kind: "TRANSMISSION",
      fiscal_operation_event_id: null
    });
    await expect(repository.claimDocumentTransmission(
      document.id,
      "SIGNED",
      "signed-before-correction-fence",
      "generic-retry-still-blocked"
    )).resolves.toBe(false);
    await expect(repository.finalizeWompiFiscalCorrectionFailure(
      correction.id,
      correction.processing_claim_id,
      {
        failureCode: "WOMPI_INTENT_QUARANTINED",
        failureMessage: "La intención ya no coincide."
      }
    )).resolves.toBe(false);
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      correction.processing_claim_id,
      {
        status: "FAILED",
        failureCode: "WOMPI_INTENT_QUARANTINED",
        failureMessage: "La intención ya no coincide."
      }
    )).resolves.toBe(true);
    expect(database.prepare(
      `SELECT status, failure_code FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id)).toEqual({
      status: "FAILED",
      failure_code: "WOMPI_INTENT_QUARANTINED"
    });
    expect(database.prepare(
      `SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?`
    ).get(document.id)).toEqual({ fiscal_operation_claim_id: quarantineClaimId });
    database.close();
  });

  it("signs a Wompi correction document only under its deterministic claim and expected status", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_claimed_document_signing";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "54545454-5454-4454-8454-545454545454"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected Wompi correction claim");
    const correction = claimed.correction;
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    })).resolves.toBe("claimed");
    const issuanceClaimId = `wompi_correction_${correction.id}`;
    await expect(repository.claimCorrectedWompiEventIssuance({
      id: wompiEventId,
      claimId: issuanceClaimId,
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    })).resolves.toBe(true);
    const reserved = await repository.reserveWompiDocumentIdentifiers(
      wompiEventId,
      "00",
      "M001P004"
    );
    const document = await repository.createClaimedWompiDteDocument({
      wompiEventId,
      issuanceClaimId,
      environment: "00",
      codigoGeneracion: reserved.codigoGeneracion,
      numeroControl: reserved.numeroControl,
      plainJson: { identificacion: { tipoDte: "15" } },
      donorEmail: "claimed-signing@example.org",
      donorName: "Donante con reclamo",
      amountCents: 2500,
      issuedAt: "2026-07-18T12:03:00.000Z"
    });
    if (!document) throw new Error("expected claimed Wompi document");
    await expect(repository.claimWompiFiscalCorrectionDocument({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!,
      documentId: document.id
    })).resolves.toBe(true);

    const documentClaimId = `fiscal_correction_${correction.id}`;
    await expect(repository.updateClaimedDocumentSigned(
      document.id,
      "wrong-claim-jws",
      "PENDING",
      "wrong-claim"
    )).resolves.toBe(false);
    await expect(repository.updateClaimedDocumentSigned(
      document.id,
      "wrong-status-jws",
      "SIGNED",
      documentClaimId
    )).resolves.toBe(false);
    expect(database.prepare(
      `SELECT status, signed_jws, fiscal_operation_claim_id,
              fiscal_operation_kind, fiscal_operation_event_id
         FROM dte_documents WHERE id = ?`
    ).get(document.id)).toEqual({
      status: "PENDING",
      signed_jws: null,
      fiscal_operation_claim_id: documentClaimId,
      fiscal_operation_kind: "TRANSMISSION",
      fiscal_operation_event_id: null
    });

    await expect(repository.updateClaimedDocumentSigned(
      document.id,
      "deterministic-correction-jws",
      "PENDING",
      documentClaimId
    )).resolves.toBe(true);
    await expect(repository.updateClaimedDocumentSigned(
      document.id,
      "stale-status-jws",
      "PENDING",
      documentClaimId
    )).resolves.toBe(false);
    expect(database.prepare(
      `SELECT status, signed_jws, fiscal_operation_claim_id,
              fiscal_operation_kind, fiscal_operation_event_id
         FROM dte_documents WHERE id = ?`
    ).get(document.id)).toEqual({
      status: "SIGNED",
      signed_jws: "deterministic-correction-jws",
      fiscal_operation_claim_id: documentClaimId,
      fiscal_operation_kind: "TRANSMISSION",
      fiscal_operation_event_id: null
    });
    database.close();
  });

  it("lists every nonterminal document owned by a terminal failed Wompi correction as requiring attention", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    const statuses = ["PENDING", "SIGNED", "FAILED", "CONTINGENCY_PENDING"] as const;
    for (const [index, status] of statuses.entries()) {
      seedFailedCorrectionOwnedDocument(database, {
        suffix: index + 1,
        documentStatus: status,
        correctionStatus: "FAILED"
      });
    }
    seedFailedCorrectionOwnedDocument(database, {
      suffix: 9,
      documentStatus: "PENDING",
      correctionStatus: "PROCESSING"
    });

    const page = await repository.listDteDocuments({
      attention: "failures",
      limit: 20
    });

    expect(page.documents.map((document) => document.id).sort()).toEqual(
      statuses.map((status, index) =>
        `doc_failed_correction_${index + 1}_${status.toLowerCase()}`
      ).sort()
    );
    database.close();
  });

  it("projects only the terminal failed Wompi correction that owns the selected document claim", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    const seeded = seedFailedCorrectionOwnedDocument(database, {
      suffix: 10,
      documentStatus: "PENDING",
      correctionStatus: "FAILED"
    });
    const processing = seedFailedCorrectionOwnedDocument(database, {
      suffix: 11,
      documentStatus: "SIGNED",
      correctionStatus: "PROCESSING"
    });
    await expect(repository.getFailedWompiFiscalCorrectionForDocument(
      seeded.documentId
    )).resolves.toEqual({
      id: seeded.correctionId,
      status: "FAILED",
      failureCode: "FISCAL_CORRECTION_EXISTING_DOCUMENT_MISMATCH",
      failureMessage:
        "El CDE preexistente no coincide con la corrección fiscal vigente o con la intención Wompi enlazada. Requiere reconciliación manual; no se transmitió a MH."
    });
    await expect(repository.getFailedWompiFiscalCorrectionForDocument(
      processing.documentId
    )).resolves.toBeNull();
    database.close();
  });

  it("rolls back recovery token rotation until missing queued and started audits persist", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_audit_recovery";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "34343434-3434-4434-8434-343434343434"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected recovery audit claim");
    const correction = claimed.correction;
    database.prepare(
      `UPDATE fiscal_corrections
          SET created_at = '2000-01-01T00:00:00.000Z',
              updated_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(correction.id);
    database.prepare(
      "DELETE FROM audit_logs WHERE entity_type = 'fiscal_correction' AND entity_id = ?"
    ).run(correction.id);
    database.exec(`
      CREATE TRIGGER block_recovery_started_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'FISCAL_CORRECTION_STARTED'
      BEGIN
        SELECT RAISE(ABORT, 'blocked recovery audit');
      END;
    `);

    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "correction_processing_blocked_recovery",
      staleBefore: "2026-01-01T00:00:00.000Z"
    })).rejects.toThrow("blocked recovery audit");
    expect(database.prepare(
      "SELECT status, processing_claim_id FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({
      status: "QUEUED",
      processing_claim_id: correction.processing_claim_id
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'fiscal_correction'"
    ).get()).toEqual({ count: 0 });

    database.exec("DROP TRIGGER block_recovery_started_audit");
    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "correction_processing_recovered_audit",
      staleBefore: "2026-01-01T00:00:00.000Z"
    })).resolves.toMatchObject({
      status: "PROCESSING",
      processing_claim_id: "correction_processing_recovered_audit"
    });
    expect(database.prepare(
      `SELECT action FROM audit_logs
        WHERE entity_type = 'fiscal_correction' AND entity_id = ?
        ORDER BY CASE action
          WHEN 'FISCAL_CORRECTION_QUEUED' THEN 1
          WHEN 'FISCAL_CORRECTION_STARTED' THEN 2
          ELSE 3
        END`
    ).all(correction.id)).toEqual([
      { action: "FISCAL_CORRECTION_QUEUED" },
      { action: "FISCAL_CORRECTION_STARTED" }
    ]);
    database.close();
  });

  it("returns only the latest nonterminal correction for one target", async () => {
    const database = migratedDatabase();
    seedFailedWompiEvent(database, "wompi_active_correction");
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: "wompi_active_correction",
        requestId: "23232323-2323-4323-8323-232323232323"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected active correction claim");

    await expect(repository.getActiveFiscalCorrectionForTarget(
      "WOMPI_EVENT",
      "wompi_active_correction"
    )).resolves.toEqual({
      id: claimed.correction.id,
      status: "QUEUED"
    });
    await expect(repository.getActiveFiscalCorrectionForTarget(
      "DTE_DOCUMENT",
      "wompi_active_correction"
    )).resolves.toBeNull();

    await repository.claimFiscalCorrectionProcessing({
      id: claimed.correction.id,
      processingClaimId: claimed.correction.processing_claim_id,
      issuanceAttemptId: claimed.correction.issuance_attempt_id ?? undefined
    });
    await repository.finalizeFiscalCorrection(
      claimed.correction.id,
      claimed.correction.processing_claim_id,
      { status: "FAILED", failureCode: "PRE_DISPATCH", failureMessage: "No enviado" }
    );
    await expect(repository.getActiveFiscalCorrectionForTarget(
      "WOMPI_EVENT",
      "wompi_active_correction"
    )).resolves.toBeNull();
    database.close();
  });

  it("keeps REVIEW_REQUIRED visible as the active non-actionable correction", async () => {
    const database = migratedDatabase();
    seedFailedWompiEvent(database, "wompi_review_required");
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: "wompi_review_required",
        requestId: "24242424-2424-4424-8424-242424242424"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected review-required claim");
    database.prepare(
      "UPDATE fiscal_corrections SET status = 'REVIEW_REQUIRED' WHERE id = ?"
    ).run(claimed.correction.id);

    await expect(repository.getActiveFiscalCorrectionForTarget(
      "WOMPI_EVENT",
      "wompi_review_required"
    )).resolves.toEqual({
      id: claimed.correction.id,
      status: "REVIEW_REQUIRED"
    });
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

  it("prepares a corrected signed row only while the document correction owns every token", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_prepare_correction");
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({ documentId: "doc_prepare_correction" })
    );
    if (claimed.kind !== "claimed") throw new Error("expected document correction claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id ?? undefined
    });
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      correction,
      "doc_prepare_correction",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "DTE-15-M001P004-000000000000101"
    );
    const input = {
      correctionId: correction.id,
      documentId: "doc_prepare_correction",
      processingClaimId: correction.processing_claim_id,
      claimId: correction.fiscal_claim_id!,
      codigoGeneracion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      numeroControl: "DTE-15-M001P004-000000000000101",
      plainJson: { identificacion: { tipoDte: "15", codigoGeneracion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" } },
      signedJws: "new-signed-jws",
      donorName: "Donante corregida",
      donorEmail: "corregida@example.org"
    };

    await expect(repository.prepareClaimedFiscalCorrectionDocument({
      ...input,
      claimId: "stale-fiscal-claim"
    })).resolves.toBe(false);
    await expect(repository.prepareClaimedFiscalCorrectionDocument({
      ...input,
      correctionId: "stale-correction"
    })).resolves.toBe(false);
    await expect(repository.prepareClaimedFiscalCorrectionDocument(input)).resolves.toBe(true);

    expect(database.prepare(
      `SELECT id, codigo_generacion, numero_control, status, plain_json, signed_jws,
              donor_name, donor_email, fiscal_operation_claim_id, fiscal_operation_kind
         FROM dte_documents WHERE id = ?`
    ).get("doc_prepare_correction")).toEqual({
      id: "doc_prepare_correction",
      codigo_generacion: input.codigoGeneracion,
      numero_control: input.numeroControl,
      status: "SIGNED",
      plain_json: JSON.stringify(input.plainJson),
      signed_jws: input.signedJws,
      donor_name: input.donorName,
      donor_email: input.donorEmail,
      fiscal_operation_claim_id: correction.fiscal_claim_id,
      fiscal_operation_kind: "TRANSMISSION"
    });
    const snapshot = database.prepare(
      "SELECT source_document_snapshot_json FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id) as { source_document_snapshot_json: string };
    expect(JSON.parse(snapshot.source_document_snapshot_json)).toMatchObject({
      id: "doc_prepare_correction",
      codigo_generacion: "generation_doc_prepare_correction",
      numero_control: "control_doc_prepare_correction",
      status: "REJECTED",
      signed_jws: "rejected-jws"
    });
    database.close();
  });

  it("atomically restores a pre-dispatch direct document when policy retires its correction", async () => {
    const database = migratedDatabase();
    const documentId = "doc_policy_retired_correction";
    seedRejectedDocument(database, documentId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({ documentId })
    );
    if (claimed.kind !== "claimed") throw new Error("expected document correction claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id ?? undefined
    });
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      correction,
      documentId,
      "98989898-9898-4898-8898-989898989898",
      "DTE-15-M001P004-000000000000098"
    );
    await repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: correction.id,
      documentId,
      processingClaimId: correction.processing_claim_id,
      claimId: correction.fiscal_claim_id!,
      codigoGeneracion: "98989898-9898-4898-8898-989898989898",
      numeroControl: "DTE-15-M001P004-000000000000098",
      plainJson: {
        identificacion: {
          tipoDte: "15",
          codigoGeneracion: "98989898-9898-4898-8898-989898989898"
        },
        receptor: { nombre: "Donante pre-fix corregida" }
      },
      signedJws: "pre-fix-corrected-jws",
      donorName: "Donante pre-fix corregida",
      donorEmail: "corregida@example.org"
    });

    await expect(repository.finalizeDirectFiscalCorrectionGenerationDisabled(
      correction.id,
      "stale-processing-claim"
    )).resolves.toBe(false);
    expect(database.prepare(
      `SELECT status, codigo_generacion, fiscal_operation_claim_id
         FROM dte_documents WHERE id = ?`
    ).get(documentId)).toEqual({
      status: "SIGNED",
      codigo_generacion: "98989898-9898-4898-8898-989898989898",
      fiscal_operation_claim_id: correction.fiscal_claim_id
    });

    await expect(repository.finalizeDirectFiscalCorrectionGenerationDisabled(
      correction.id,
      correction.processing_claim_id
    )).resolves.toBe(true);
    expect(database.prepare(
      `SELECT status, codigo_generacion, numero_control, plain_json, signed_jws,
              sello_recibido, mh_estado, mh_observaciones_json, donor_name,
              donor_email, fiscal_operation_claim_id, fiscal_operation_claimed_at,
              fiscal_operation_kind, fiscal_operation_event_id, transmission_claim_id
         FROM dte_documents WHERE id = ?`
    ).get(documentId)).toEqual({
      status: "REJECTED",
      codigo_generacion: `generation_${documentId}`,
      numero_control: `control_${documentId}`,
      plain_json: "{\"identificacion\":{\"tipoDte\":\"15\"}}",
      signed_jws: "rejected-jws",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[\"Receptor inválido\"]",
      donor_name: null,
      donor_email: null,
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null,
      fiscal_operation_event_id: null,
      transmission_claim_id: null
    });
    expect(database.prepare(
      `SELECT status, failure_code, failure_message, completed_at
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id)).toMatchObject({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_DIRECT_GENERATION_DISABLED",
      failure_message: "La corrección de CDE directos está deshabilitada en este despliegue.",
      completed_at: expect.any(String)
    });
    expect(database.prepare(
      `SELECT action, json_extract(metadata_json, '$.outcomeCode') AS outcome_code
         FROM audit_logs
        WHERE entity_type = 'fiscal_correction' AND entity_id = ?
        ORDER BY CASE action
          WHEN 'FISCAL_CORRECTION_QUEUED' THEN 1
          WHEN 'FISCAL_CORRECTION_STARTED' THEN 2
          ELSE 3
        END`
    ).all(correction.id)).toEqual([
      { action: "FISCAL_CORRECTION_QUEUED", outcome_code: "QUEUED" },
      { action: "FISCAL_CORRECTION_STARTED", outcome_code: "PROCESSING" },
      {
        action: "FISCAL_CORRECTION_FAILED",
        outcome_code: "FISCAL_CORRECTION_DIRECT_GENERATION_DISABLED"
      }
    ]);
    database.close();
  });

  it("fences a recovered DTE worker before identifier allocation and reuses one reservation", async () => {
    const database = migratedDatabase();
    const documentId = "doc_recovery_fence";
    seedRejectedDocument(database, documentId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId,
        requestId: "91919191-9191-4191-8191-919191919191"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected fenced correction claim");
    const correction = claimed.correction;
    const oldProcessingClaimId = correction.processing_claim_id;
    const fiscalClaimId = correction.fiscal_claim_id!;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: oldProcessingClaimId,
      fiscalClaimId
    });
    database.prepare(
      "UPDATE fiscal_corrections SET processing_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(correction.id);

    let releaseOld!: () => void;
    let markOldPaused!: () => void;
    const oldPaused = new Promise<void>((resolve) => {
      markOldPaused = resolve;
    });
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let signCount = 0;
    const oldWorker = (async () => {
      markOldPaused();
      await oldGate;
      const identifiers = await repository.reserveFiscalCorrectionDocumentIdentifiers({
        correctionId: correction.id,
        documentId,
        processingClaimId: oldProcessingClaimId,
        fiscalClaimId,
        environment: "00",
        controlPrefix: "M001P004",
        codigoGeneracion: "91919191-9191-4191-8191-919191919191"
      });
      if (!identifiers) return false;
      signCount += 1;
      return repository.prepareClaimedFiscalCorrectionDocument({
        correctionId: correction.id,
        documentId,
        processingClaimId: oldProcessingClaimId,
        claimId: fiscalClaimId,
        codigoGeneracion: identifiers.codigoGeneracion,
        numeroControl: identifiers.numeroControl,
        plainJson: { identificacion: identifiers },
        signedJws: "stale-owner-signed-jws",
        donorName: "Dueño anterior",
        donorEmail: null
      });
    })();
    await oldPaused;

    const nextProcessingClaimId = "correction_processing_recovered_fence";
    const recovered = await repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: oldProcessingClaimId,
      nextProcessingClaimId,
      staleBefore: "2026-01-01T00:00:00.000Z"
    });
    expect(recovered).toMatchObject({
      id: correction.id,
      processing_claim_id: nextProcessingClaimId
    });
    releaseOld();
    await expect(oldWorker).resolves.toBe(false);
    expect(signCount).toBe(0);

    const reserved = await repository.reserveFiscalCorrectionDocumentIdentifiers({
      correctionId: correction.id,
      documentId,
      processingClaimId: nextProcessingClaimId,
      fiscalClaimId,
      environment: "00",
      controlPrefix: "M001P004",
      codigoGeneracion: "92929292-9292-4292-8292-929292929292"
    });
    expect(reserved).toEqual({
      sequence: 1,
      codigoGeneracion: "92929292-9292-4292-8292-929292929292",
      numeroControl: "DTE-15-M001P004-000000000000001"
    });
    await expect(repository.renewFiscalCorrectionDocumentSigningLease({
      correctionId: correction.id,
      documentId,
      processingClaimId: oldProcessingClaimId,
      fiscalClaimId,
      codigoGeneracion: reserved!.codigoGeneracion,
      numeroControl: reserved!.numeroControl
    })).resolves.toBe(false);
    database.prepare(
      `UPDATE fiscal_corrections
          SET processing_started_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(correction.id);
    await expect(repository.renewFiscalCorrectionDocumentSigningLease({
      correctionId: correction.id,
      documentId,
      processingClaimId: nextProcessingClaimId,
      fiscalClaimId,
      codigoGeneracion: reserved!.codigoGeneracion,
      numeroControl: reserved!.numeroControl
    })).resolves.toBe(true);
    expect(database.prepare(
      "SELECT processing_started_at FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({
      processing_started_at: expect.not.stringMatching(/^2000-/)
    });
    signCount += 1;
    await expect(repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: correction.id,
      documentId,
      processingClaimId: nextProcessingClaimId,
      claimId: fiscalClaimId,
      codigoGeneracion: reserved!.codigoGeneracion,
      numeroControl: reserved!.numeroControl,
      plainJson: { identificacion: reserved },
      signedJws: "current-owner-signed-jws",
      donorName: "Dueño actual",
      donorEmail: null
    })).resolves.toBe(true);

    database.prepare(
      `UPDATE fiscal_corrections
          SET processing_started_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(correction.id);
    await expect(repository.reserveFiscalCorrectionDocumentIdentifiers({
      correctionId: correction.id,
      documentId,
      processingClaimId: nextProcessingClaimId,
      fiscalClaimId,
      environment: "00",
      controlPrefix: "M001P004",
      codigoGeneracion: "93939393-9393-4393-8393-939393939393"
    })).resolves.toEqual(reserved);
    expect(database.prepare(
      "SELECT processing_started_at FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({
      processing_started_at: expect.not.stringMatching(/^2000-/)
    });
    expect(signCount).toBe(1);
    expect(database.prepare(
      `SELECT next_value FROM document_sequences
        WHERE environment = '00' AND control_prefix = 'M001P004'`
    ).get()).toEqual({ next_value: 2 });
    expect(database.prepare(
      `SELECT status, signed_jws, codigo_generacion, numero_control
         FROM dte_documents WHERE id = ?`
    ).get(documentId)).toEqual({
      status: "SIGNED",
      signed_jws: "current-owner-signed-jws",
      codigo_generacion: reserved!.codigoGeneracion,
      numero_control: reserved!.numeroControl
    });
    database.close();
  });

  it("does not rotate Wompi correction ownership while its issuance claim is held", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_recovery_fence";
    seedFailedWompiEvent(database, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "94949494-9494-4494-8494-949494949494"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected Wompi correction claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });
    const issuanceClaimId = `wompi_correction_${correction.id}`;
    expect(await repository.claimCorrectedWompiEventIssuance({
      id: wompiEventId,
      claimId: issuanceClaimId,
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    })).toBe(true);
    database.prepare(
      "UPDATE fiscal_corrections SET processing_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(correction.id);

    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "must_not_rotate_held_wompi",
      staleBefore: "2026-01-01T00:00:00.000Z"
    })).resolves.toBeNull();
    await repository.releaseWompiEventIssuance(wompiEventId, issuanceClaimId);
    const recovered = await repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "correction_processing_recovered_wompi",
      staleBefore: "2026-01-01T00:00:00.000Z"
    });
    expect(recovered).toMatchObject({
      processing_claim_id: "correction_processing_recovered_wompi"
    });
    await expect(repository.claimCorrectedWompiEventIssuance({
      id: wompiEventId,
      claimId: issuanceClaimId,
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    })).resolves.toBe(false);
    await expect(repository.claimCorrectedWompiEventIssuance({
      id: wompiEventId,
      claimId: issuanceClaimId,
      correctionId: correction.id,
      processingClaimId: "correction_processing_recovered_wompi",
      issuanceAttemptId: correction.issuance_attempt_id!
    })).resolves.toBe(true);
    database.close();
  });

  it("keeps the ordinary stalled-Wompi sweep off an active correction token", async () => {
    const database = migratedDatabase();
    const wompiEventId = "wompi_stalled_correction_fence";
    const rawBody = JSON.stringify({
      Cliente: {
        DocumentoIdentidad: "12345678-9",
        Nombre: "Donante original inválida"
      }
    });
    seedFailedWompiEvent(database, wompiEventId);
    database.prepare(
      `UPDATE wompi_events
          SET raw_body = ?,
              received_at = '2000-01-01T00:00:00.000Z',
              issuance_last_attempt_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(rawBody, wompiEventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId,
        requestId: "95959595-9595-4595-8595-959595959595",
        correctedReceptorJson: JSON.stringify({
          numDocumento: "10000002-7",
          nombre: "Donante corregida"
        })
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected protected correction");
    const correction = claimed.correction;
    const correctionAttemptId = correction.issuance_attempt_id!;
    database.prepare(
      `UPDATE wompi_events
          SET issuance_last_attempt_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(wompiEventId);

    await expect(repository.listStalledApprovedWompiEvents(
      "2026-01-01T00:00:00.000Z"
    )).resolves.toEqual([]);
    await expect(repository.claimStalledWompiIssuanceAttempt(
      wompiEventId,
      correctionAttemptId,
      "2026-01-01T00:00:00.000Z"
    )).resolves.toBeNull();
    expect(database.prepare(
      `SELECT issuance_status, issuance_attempt_id, raw_body
         FROM wompi_events WHERE id = ?`
    ).get(wompiEventId)).toEqual({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correctionAttemptId,
      raw_body: rawBody
    });
    expect(database.prepare(
      `SELECT status, processing_claim_id, corrected_receptor_json
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id)).toEqual({
      status: "QUEUED",
      processing_claim_id: correction.processing_claim_id,
      corrected_receptor_json: JSON.stringify({
        numDocumento: "10000002-7",
        nombre: "Donante corregida"
      })
    });

    database.prepare(
      `UPDATE fiscal_corrections
          SET updated_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
    ).run(correction.id);
    const recovered = await repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "correction_processing_stalled_wompi_recovered",
      staleBefore: "2026-01-01T00:00:00.000Z"
    });
    expect(recovered).toMatchObject({
      id: correction.id,
      status: "PROCESSING",
      processing_claim_id: "correction_processing_stalled_wompi_recovered",
      issuance_attempt_id: correctionAttemptId
    });
    await expect(repository.claimCorrectedWompiEventIssuance({
      id: wompiEventId,
      claimId: `wompi_correction_${correction.id}`,
      correctionId: correction.id,
      processingClaimId: "correction_processing_stalled_wompi_recovered",
      issuanceAttemptId: correctionAttemptId
    })).resolves.toBe(true);
    expect(database.prepare(
      "SELECT raw_body FROM wompi_events WHERE id = ?"
    ).get(wompiEventId)).toEqual({ raw_body: rawBody });
    database.close();
  });

  it("blocks a second correction in the MH rejection finalization gap", async () => {
    const database = migratedDatabase();
    seedRejectedDocument(database, "doc_rejected_twice");
    const repository = new Repository(new SqliteD1(database).database);
    const first = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_rejected_twice",
        requestId: "61616161-6161-4161-8161-616161616161"
      })
    );
    if (first.kind !== "claimed") throw new Error("expected first correction claim");
    await repository.claimFiscalCorrectionProcessing({
      id: first.correction.id,
      processingClaimId: first.correction.processing_claim_id,
      fiscalClaimId: first.correction.fiscal_claim_id ?? undefined
    });
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      first.correction,
      "doc_rejected_twice",
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      "DTE-15-M001P004-000000000000111"
    );
    await repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: first.correction.id,
      documentId: "doc_rejected_twice",
      processingClaimId: first.correction.processing_claim_id,
      claimId: first.correction.fiscal_claim_id!,
      codigoGeneracion: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      numeroControl: "DTE-15-M001P004-000000000000111",
      plainJson: { identificacion: { codigoGeneracion: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" }, receptor: { nombre: "Primera corrección" } },
      signedJws: "first-corrected-jws",
      donorName: "Primera corrección",
      donorEmail: null
    });
    await repository.markFiscalCorrectionMhDispatchStarted({
      correctionId: first.correction.id,
      processingClaimId: first.correction.processing_claim_id,
      documentId: "doc_rejected_twice",
      documentClaimId: first.correction.fiscal_claim_id!,
      signedJws: "first-corrected-jws"
    });
    await repository.completeDocumentTransmission(
      "doc_rejected_twice",
      first.correction.fiscal_claim_id!,
      {
        status: "REJECTED",
        sello: null,
        mhEstado: "RECHAZADO",
        observaciones: ["#/receptor/nombre rechazado nuevamente"],
        acceptedAt: null
      }
    );
    expect(database.prepare(
      `SELECT status, fiscal_operation_claim_id
         FROM dte_documents WHERE id = ?`
    ).get("doc_rejected_twice")).toEqual({
      status: "REJECTED",
      fiscal_operation_claim_id: null
    });
    await expect(repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_rejected_twice",
        requestId: "60606060-6060-4060-8060-606060606060",
        requestPayloadSha256: "gap-race-payload"
      })
    )).resolves.toEqual({ kind: "ineligible" });
    expect(database.prepare(
      "SELECT status FROM fiscal_corrections WHERE id = ?"
    ).get(first.correction.id)).toEqual({ status: "PROCESSING" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM fiscal_corrections WHERE document_id = ?"
    ).get("doc_rejected_twice")).toEqual({ count: 1 });

    await expect(repository.finalizeFiscalCorrection(
      first.correction.id,
      first.correction.processing_claim_id,
      {
        status: "REJECTED",
        document: {
          documentId: "doc_rejected_twice",
          documentClaimId: first.correction.fiscal_claim_id!,
          signedJws: "first-corrected-jws"
        }
      }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT status FROM fiscal_corrections WHERE id = ?"
    ).get(first.correction.id)).toEqual({ status: "REJECTED" });

    const second = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: "doc_rejected_twice",
        requestId: "62626262-6262-4262-8262-626262626262",
        requestPayloadSha256: "second-correction-payload"
      })
    );
    expect(second).toMatchObject({
      kind: "claimed",
      correction: { attempt_number: 2 }
    });
    if (second.kind !== "claimed") throw new Error("expected second correction claim");
    expect(second.correction.fiscal_claim_id).not.toBe(first.correction.fiscal_claim_id);
    const snapshots = database.prepare(
      `SELECT attempt_number, source_document_snapshot_json
         FROM fiscal_corrections WHERE document_id = ? ORDER BY attempt_number`
    ).all("doc_rejected_twice") as Array<{
      attempt_number: number;
      source_document_snapshot_json: string;
    }>;
    expect(snapshots).toHaveLength(2);
    expect(JSON.parse(snapshots[0].source_document_snapshot_json)).toMatchObject({
      codigo_generacion: "generation_doc_rejected_twice",
      signed_jws: "rejected-jws"
    });
    expect(JSON.parse(snapshots[1].source_document_snapshot_json)).toMatchObject({
      codigo_generacion: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      numero_control: "DTE-15-M001P004-000000000000111",
      signed_jws: "first-corrected-jws",
      status: "REJECTED"
    });
    await repository.claimFiscalCorrectionProcessing({
      id: second.correction.id,
      processingClaimId: second.correction.processing_claim_id,
      fiscalClaimId: second.correction.fiscal_claim_id ?? undefined
    });
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      second.correction,
      "doc_rejected_twice",
      "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
      "DTE-15-M001P004-000000000000112"
    );
    await expect(repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: second.correction.id,
      documentId: "doc_rejected_twice",
      processingClaimId: second.correction.processing_claim_id,
      claimId: second.correction.fiscal_claim_id!,
      codigoGeneracion: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
      numeroControl: "DTE-15-M001P004-000000000000112",
      plainJson: {
        identificacion: { codigoGeneracion: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC" },
        receptor: { nombre: "Segunda corrección" }
      },
      signedJws: "second-corrected-jws",
      donorName: "Segunda corrección",
      donorEmail: null
    })).resolves.toBe(true);
    expect(database.prepare(
      `SELECT codigo_generacion, numero_control, signed_jws, status
         FROM dte_documents WHERE id = ?`
    ).get("doc_rejected_twice")).toEqual({
      codigo_generacion: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
      numero_control: "DTE-15-M001P004-000000000000112",
      signed_jws: "second-corrected-jws",
      status: "SIGNED"
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
    const allocations = await Promise.all(
      [first, second].map((result) =>
        result.kind === "claimed"
          ? repository.nextControlSequence("00", "M001P004")
          : Promise.resolve(null)
      )
    );
    expect(allocations.filter((value) => value !== null)).toEqual([1]);
    expect(database.prepare(
      `SELECT next_value FROM document_sequences
        WHERE environment = '00' AND control_prefix = 'M001P004'`
    ).get()).toEqual({ next_value: 2 });
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
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      first.correction,
      "doc_accepted_history",
      "29292929-2929-4929-8929-292929292929",
      "DTE-15-M001P004-000000000000099"
    );
    await repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: first.correction.id,
      documentId: "doc_accepted_history",
      processingClaimId: first.correction.processing_claim_id,
      claimId: first.correction.fiscal_claim_id!,
      codigoGeneracion: "29292929-2929-4929-8929-292929292929",
      numeroControl: "DTE-15-M001P004-000000000000099",
      plainJson: { identificacion: { tipoDte: "15" } },
      signedJws: "accepted-history-jws",
      donorName: "Donante corregida",
      donorEmail: null
    });
    await repository.markFiscalCorrectionMhDispatchStarted({
      correctionId: first.correction.id,
      processingClaimId: first.correction.processing_claim_id,
      documentId: "doc_accepted_history",
      documentClaimId: first.correction.fiscal_claim_id!,
      signedJws: "accepted-history-jws"
    });
    await repository.completeDocumentTransmission(
      "doc_accepted_history",
      first.correction.fiscal_claim_id!,
      {
        status: "ACCEPTED",
        sello: "accepted-history-seal",
        mhEstado: "PROCESADO",
        observaciones: [],
        acceptedAt: "2026-07-18T12:03:00.000Z"
      }
    );
    await expect(repository.finalizeFiscalCorrection(
      first.correction.id,
      first.correction.processing_claim_id,
      {
        status: "ACCEPTED",
        document: {
          documentId: "doc_accepted_history",
          documentClaimId: first.correction.fiscal_claim_id!,
          signedJws: "accepted-history-jws"
        }
      }
    )).resolves.toBe(true);

    expect(database.prepare(
      "SELECT status FROM dte_documents WHERE id = ?"
    ).get("doc_accepted_history")).toEqual({ status: "ACCEPTED" });
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
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      correction,
      "doc_dispatch_fence",
      "31313131-3131-4131-8131-313131313131",
      "DTE-15-M001P004-000000000000100"
    );
    await repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: correction.id,
      documentId: "doc_dispatch_fence",
      processingClaimId: correction.processing_claim_id,
      claimId: correction.fiscal_claim_id!,
      codigoGeneracion: "31313131-3131-4131-8131-313131313131",
      numeroControl: "DTE-15-M001P004-000000000000100",
      plainJson: { identificacion: { tipoDte: "15" } },
      signedJws: "dispatch-fence-jws",
      donorName: "Donante corregida",
      donorEmail: null
    });
    const processingBeforeDispatch = database.prepare(
      `SELECT processing_started_at, mh_dispatch_started_at
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id) as {
      processing_started_at: string;
      mh_dispatch_started_at: string | null;
    };
    expect(processingBeforeDispatch).toMatchObject({
      processing_started_at: expect.any(String),
      mh_dispatch_started_at: null
    });
    const dispatchInput = {
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId: "doc_dispatch_fence",
      documentClaimId: correction.fiscal_claim_id!,
      signedJws: "dispatch-fence-jws"
    };
    await expect(repository.markFiscalCorrectionMhDispatchStarted({
      ...dispatchInput,
      processingClaimId: "stale-processing-token"
    })).resolves.toBe(false);
    await expect(repository.markFiscalCorrectionMhDispatchStarted(
      dispatchInput
    )).resolves.toBe(true);
    expect(database.prepare(
      `SELECT processing_started_at, mh_dispatch_started_at
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id)).toMatchObject({
      processing_started_at: processingBeforeDispatch.processing_started_at,
      mh_dispatch_started_at: expect.any(String)
    });
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      "stale-processing-token",
      {
        status: "REVIEW_REQUIRED",
        failureCode: "MH_OUTCOME_UNKNOWN",
        failureMessage: "Sin respuesta definitiva",
        document: {
          documentId: dispatchInput.documentId,
          documentClaimId: dispatchInput.documentClaimId,
          signedJws: dispatchInput.signedJws
        }
      }
    )).resolves.toBe(false);
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      correction.processing_claim_id,
      {
        status: "REVIEW_REQUIRED",
        failureCode: "MH_OUTCOME_UNKNOWN",
        failureMessage: "Sin respuesta definitiva",
        document: {
          documentId: dispatchInput.documentId,
          documentClaimId: dispatchInput.documentClaimId,
          signedJws: dispatchInput.signedJws
        }
      }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
    ).get("doc_dispatch_fence")).toEqual({
      fiscal_operation_claim_id: correction.fiscal_claim_id
    });
    database.prepare(
      "UPDATE fiscal_corrections SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(correction.id);
    expect(await repository.listRecoverableFiscalCorrections(
      "2026-01-01T00:00:00.000Z"
    )).not.toContainEqual(expect.objectContaining({ id: correction.id }));
    await expect(repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id ?? undefined
    })).resolves.toBe("terminal");
    database.close();
  });

  it("lets exactly one correction delivery cross the MH dispatch boundary", async () => {
    const database = migratedDatabase();
    seedFailedWompiEvent(database, "wompi_dispatch_cas");
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: "wompi_dispatch_cas",
        requestId: "45454545-4545-4545-8545-454545454545"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected dispatch CAS claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    });
    const documentId = "doc_wompi_dispatch_cas";
    const documentClaimId = `fiscal_correction_${correction.id}`;
    database.prepare(
      `INSERT INTO dte_documents (
         id, wompi_event_id, environment, codigo_generacion, numero_control,
         status, plain_json, signed_jws, amount_cents, issued_at, created_at,
         updated_at, fiscal_operation_claim_id, fiscal_operation_claimed_at,
         fiscal_operation_kind
       ) VALUES (?, 'wompi_dispatch_cas', '00', ?, ?, 'SIGNED', '{}',
                 'dispatch-cas-jws', 2500, ?, ?, ?, ?, ?, 'TRANSMISSION')`
    ).run(
      documentId,
      "41414141-4141-4141-8141-414141414141",
      "DTE-15-M001P004-000000000000109",
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      documentClaimId,
      "2026-07-18T12:00:00.000Z"
    );
    database.prepare(
      "UPDATE wompi_events SET created_document_id = ?, issuance_status = 'DOCUMENT_CREATED' WHERE id = ?"
    ).run(documentId, "wompi_dispatch_cas");
    const dispatchInput = {
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId,
      documentClaimId,
      signedJws: "dispatch-cas-jws"
    };
    await expect(repository.markFiscalCorrectionMhDispatchStarted(
      dispatchInput
    )).resolves.toBe(true);
    const firstMarker = database.prepare(
      "SELECT mh_dispatch_started_at FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id);
    await expect(repository.markFiscalCorrectionMhDispatchStarted(
      dispatchInput
    )).resolves.toBe(false);
    expect(database.prepare(
      "SELECT mh_dispatch_started_at FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual(firstMarker);
    database.close();
  });

  it("couples document correction dispatch to the exact current signed candidate owner", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    const scenarios = [
      {
        name: "released claim",
        mutate: (documentId: string) => database.prepare(
          `UPDATE dte_documents
              SET fiscal_operation_claim_id = NULL,
                  fiscal_operation_claimed_at = NULL,
                  fiscal_operation_kind = NULL
            WHERE id = ?`
        ).run(documentId),
        expected: false
      },
      {
        name: "reassigned claim",
        mutate: (documentId: string) => database.prepare(
          "UPDATE dte_documents SET fiscal_operation_claim_id = 'foreign-claim' WHERE id = ?"
        ).run(documentId),
        expected: false
      },
      {
        name: "status mismatch",
        mutate: (documentId: string) => database.prepare(
          "UPDATE dte_documents SET status = 'REJECTED' WHERE id = ?"
        ).run(documentId),
        expected: false
      },
      {
        name: "JWS mismatch",
        mutate: (documentId: string) => database.prepare(
          "UPDATE dte_documents SET signed_jws = 'foreign-signed-jws' WHERE id = ?"
        ).run(documentId),
        expected: false
      },
      {
        name: "current owner",
        mutate: (_documentId: string) => undefined,
        expected: true
      }
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const documentId = `doc_dispatch_owner_${index}`;
      const signedJws = `corrected-signed-jws-${index}`;
      seedRejectedDocument(database, documentId);
      const claimed = await repository.claimDocumentFiscalCorrection(
        documentCorrectionClaimInput({
          documentId,
          requestId: `71717171-7171-4171-8171-71717171717${index}`
        })
      );
      if (claimed.kind !== "claimed") {
        throw new Error(`expected ${scenario.name} correction claim`);
      }
      const correction = claimed.correction;
      await repository.claimFiscalCorrectionProcessing({
        id: correction.id,
        processingClaimId: correction.processing_claim_id,
        fiscalClaimId: correction.fiscal_claim_id ?? undefined
      });
      await reserveDocumentCorrectionIdentifiers(
        database,
        repository,
        correction,
        documentId,
        `72727272-7272-4272-8272-72727272727${index}`,
        `DTE-15-M001P004-${String(index + 121).padStart(15, "0")}`
      );
      await repository.prepareClaimedFiscalCorrectionDocument({
        correctionId: correction.id,
        documentId,
        processingClaimId: correction.processing_claim_id,
        claimId: correction.fiscal_claim_id!,
        codigoGeneracion: `72727272-7272-4272-8272-72727272727${index}`,
        numeroControl: `DTE-15-M001P004-${String(index + 121).padStart(15, "0")}`,
        plainJson: { identificacion: { tipoDte: "15" } },
        signedJws,
        donorName: "Donante corregida",
        donorEmail: null
      });
      scenario.mutate(documentId);

      await expect(repository.markFiscalCorrectionMhDispatchStarted({
        correctionId: correction.id,
        processingClaimId: correction.processing_claim_id,
        documentId,
        documentClaimId: correction.fiscal_claim_id!,
        signedJws
      })).resolves.toBe(scenario.expected);
    }
    database.close();
  });

  it("couples Wompi correction dispatch to the event-created document relationship", async () => {
    const database = migratedDatabase();
    const eventId = "wompi_dispatch_relationship";
    const documentId = "doc_wompi_dispatch_relationship";
    const documentClaimId = "fiscal_correction_document_claim";
    const signedJws = "wompi-corrected-signed-jws";
    seedFailedWompiEvent(database, eventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: eventId,
        requestId: "73737373-7373-4373-8373-737373737373"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected Wompi relationship claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    });
    database.prepare(
      `INSERT INTO dte_documents (
         id, wompi_event_id, environment, codigo_generacion, numero_control,
         status, plain_json, signed_jws, amount_cents, issued_at, created_at,
         updated_at, fiscal_operation_claim_id, fiscal_operation_claimed_at,
         fiscal_operation_kind
       ) VALUES (?, ?, '00', ?, ?, 'SIGNED', '{}', ?, 2500, ?, ?, ?, ?, ?,
                 'TRANSMISSION')`
    ).run(
      documentId,
      eventId,
      "74747474-7474-4474-8474-747474747474",
      "DTE-15-M001P004-000000000000131",
      signedJws,
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      documentClaimId,
      "2026-07-18T12:00:00.000Z"
    );
    database.prepare(
      "UPDATE wompi_events SET created_document_id = ?, issuance_status = 'DOCUMENT_CREATED' WHERE id = ?"
    ).run(documentId, eventId);

    await expect(repository.markFiscalCorrectionMhDispatchStarted({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId: "foreign-document",
      documentClaimId,
      signedJws
    })).resolves.toBe(false);
    await expect(repository.markFiscalCorrectionMhDispatchStarted({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId,
      documentClaimId,
      signedJws
    })).resolves.toBe(true);
    database.close();
  });

  it("blocks a DTE correction in the Wompi rejection finalization gap", async () => {
    const database = migratedDatabase();
    const eventId = "wompi_cross_target_gap";
    const documentId = "doc_wompi_cross_target_gap";
    const signedJws = "wompi-cross-target-jws";
    seedFailedWompiEvent(database, eventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: eventId,
        requestId: "81818181-8181-4181-8181-818181818181"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected Wompi correction claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    });
    const documentClaimId = `fiscal_correction_${correction.id}`;
    database.prepare(
      `UPDATE wompi_events
          SET control_prefix = 'M001P004',
              control_sequence = 161,
              reserved_codigo_generacion = ?,
              reserved_numero_control = ?
        WHERE id = ?`
    ).run(
      "82828282-8282-4282-8282-828282828282",
      "DTE-15-M001P004-000000000000161",
      eventId
    );
    database.prepare(
      `INSERT INTO dte_documents (
         id, wompi_event_id, environment, codigo_generacion, numero_control,
         status, plain_json, signed_jws, amount_cents, issued_at, created_at,
         updated_at, fiscal_operation_claim_id, fiscal_operation_claimed_at,
         fiscal_operation_kind
       ) VALUES (?, ?, '00', ?, ?, 'SIGNED', '{}', ?, 2500, ?, ?, ?, ?, ?,
                 'TRANSMISSION')`
    ).run(
      documentId,
      eventId,
      "82828282-8282-4282-8282-828282828282",
      "DTE-15-M001P004-000000000000161",
      signedJws,
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      documentClaimId,
      "2026-07-18T12:00:00.000Z"
    );
    database.prepare(
      "UPDATE wompi_events SET created_document_id = ?, issuance_status = 'DOCUMENT_CREATED' WHERE id = ?"
    ).run(documentId, eventId);
    await repository.markFiscalCorrectionMhDispatchStarted({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId,
      documentClaimId,
      signedJws
    });
    await repository.completeDocumentTransmission(documentId, documentClaimId, {
      status: "REJECTED",
      sello: null,
      mhEstado: "RECHAZADO",
      observaciones: ["#/receptor/nombre rechazado"],
      acceptedAt: null
    });

    await expect(repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId,
        requestId: "83838383-8383-4383-8383-838383838383",
        requestPayloadSha256: "cross-target-gap-payload"
      })
    )).resolves.toEqual({ kind: "ineligible" });
    expect(database.prepare(
      "SELECT status FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({ status: "PROCESSING" });

    database.prepare(
      `UPDATE wompi_events
          SET issuance_attempt_id = 'different-correction-attempt',
              reserved_codigo_generacion = 'different-generation-code'
        WHERE id = ?`
    ).run(eventId);
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      correction.processing_claim_id,
      {
        status: "REJECTED",
        document: { documentId, documentClaimId, signedJws }
      }
    )).resolves.toBe(false);
    database.prepare(
      `UPDATE wompi_events
          SET issuance_attempt_id = ?,
              reserved_codigo_generacion = ?
        WHERE id = ?`
    ).run(
      correction.issuance_attempt_id,
      "82828282-8282-4282-8282-828282828282",
      eventId
    );
    await expect(repository.finalizeFiscalCorrection(
      correction.id,
      correction.processing_claim_id,
      {
        status: "REJECTED",
        document: { documentId, documentClaimId, signedJws }
      }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT status FROM fiscal_corrections WHERE id = ?"
    ).get(correction.id)).toEqual({ status: "REJECTED" });
    await expect(repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId,
        requestId: "84848484-8484-4484-8484-848484848484",
        requestPayloadSha256: "cross-target-after-terminal-payload"
      })
    )).resolves.toMatchObject({
      kind: "claimed",
      correction: {
        target_kind: "DTE_DOCUMENT",
        attempt_number: 1
      }
    });
    database.close();
  });

  it("atomically retires an uncorrectable pre-CDE event without losing its evidence", async () => {
    const database = migratedDatabase();
    const eventId = "wompi_uncorrectable_candidate";
    const numeroControl = "DTE-15-M001P004-000000000000091";
    const codigoGeneracion = "91919191-9191-4191-8191-919191919191";
    seedFailedWompiEvent(database, eventId);
    database.prepare(
      `UPDATE wompi_events
          SET control_prefix = 'M001P004',
              control_sequence = 91,
              reserved_numero_control = ?,
              reserved_codigo_generacion = ?
        WHERE id = ?`
    ).run(numeroControl, codigoGeneracion, eventId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: eventId,
        requestId: "46464646-4646-4646-8646-464646464646"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected retirement claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id ?? undefined
    });

    await expect(repository.finalizeWompiFiscalCorrectionFailure(
      correction.id,
      correction.processing_claim_id,
      {
        failureCode: "FISCAL_CORRECTION_INVALID_CANDIDATE",
        failureMessage: "El receptor corregido no es válido."
      }
    )).resolves.toBe(true);

    expect(database.prepare(
      `SELECT issuance_status, processed_at, issuance_attempt_id, issuance_claim_id,
              issuance_claimed_at, issuance_error_code, issuance_error_message,
              control_prefix, control_sequence, reserved_numero_control,
              reserved_codigo_generacion
         FROM wompi_events WHERE id = ?`
    ).get(eventId)).toEqual({
      issuance_status: "FAILED",
      processed_at: expect.any(String),
      issuance_attempt_id: null,
      issuance_claim_id: null,
      issuance_claimed_at: null,
      issuance_error_code: "FISCAL_CORRECTION_INVALID_CANDIDATE",
      issuance_error_message: "El receptor corregido no es válido.",
      control_prefix: "M001P004",
      control_sequence: 91,
      reserved_numero_control: numeroControl,
      reserved_codigo_generacion: codigoGeneracion
    });
    expect(database.prepare(
      `SELECT status, failure_code, corrected_receptor_json, changed_fields_json
         FROM fiscal_corrections WHERE id = ?`
    ).get(correction.id)).toEqual({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_INVALID_CANDIDATE",
      corrected_receptor_json: JSON.stringify({ nombre: "Donante corregida" }),
      changed_fields_json: JSON.stringify(["nombre"])
    });
    expect(await repository.listStalledApprovedWompiEvents(
      "2099-01-01T00:00:00.000Z"
    )).toEqual([]);

    const next = await repository.claimWompiFiscalCorrection(
      wompiCorrectionClaimInput({
        wompiEventId: eventId,
        requestId: "47474747-4747-4747-8747-474747474747",
        requestPayloadSha256: "next-correction-payload"
      })
    );
    expect(next).toMatchObject({
      kind: "claimed",
      correction: {
        issuance_attempt_id: expect.any(String)
      }
    });
    if (next.kind !== "claimed") throw new Error("expected a new explicit correction");
    expect(next.correction.issuance_attempt_id).not.toBe(correction.issuance_attempt_id);
    expect(database.prepare(
      `SELECT control_prefix, control_sequence, reserved_numero_control,
              reserved_codigo_generacion
         FROM wompi_events WHERE id = ?`
    ).get(eventId)).toEqual({
      control_prefix: "M001P004",
      control_sequence: 91,
      reserved_numero_control: numeroControl,
      reserved_codigo_generacion: codigoGeneracion
    });
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
      const signedJws = `dispatch-required-jws-${index}`;
      await reserveDocumentCorrectionIdentifiers(
        database,
        repository,
        correction,
        documentId,
        `51515151-5151-4151-8151-51515151515${index}`,
        `DTE-15-M001P004-${String(index + 111).padStart(15, "0")}`
      );
      await repository.prepareClaimedFiscalCorrectionDocument({
        correctionId: correction.id,
        documentId,
        processingClaimId: correction.processing_claim_id,
        claimId: correction.fiscal_claim_id!,
        codigoGeneracion: `51515151-5151-4151-8151-51515151515${index}`,
        numeroControl: `DTE-15-M001P004-${String(index + 111).padStart(15, "0")}`,
        plainJson: { identificacion: { tipoDte: "15" } },
        signedJws,
        donorName: "Donante corregida",
        donorEmail: null
      });
      const document = {
        documentId,
        documentClaimId: correction.fiscal_claim_id!,
        signedJws
      };
      const documentedOutcome = { ...outcome, document };

      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        documentedOutcome
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

      await repository.markFiscalCorrectionMhDispatchStarted({
        correctionId: correction.id,
        processingClaimId: correction.processing_claim_id,
        ...document
      });
      if (outcome.status === "ACCEPTED" || outcome.status === "REJECTED") {
        await repository.completeDocumentTransmission(
          documentId,
          correction.fiscal_claim_id!,
          {
            status: outcome.status,
            sello: outcome.status === "ACCEPTED" ? `seal-${index}` : null,
            mhEstado: outcome.status === "ACCEPTED" ? "PROCESADO" : "RECHAZADO",
            observaciones: [],
            acceptedAt: outcome.status === "ACCEPTED"
              ? "2026-07-18T12:07:00.000Z"
              : null
          }
        );
      }
      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        documentedOutcome
      )).resolves.toBe(true);
    }
    database.close();
  });

  it("refuses false terminal correction verdicts until the exact document result is durable", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    for (const [index, status] of (["ACCEPTED", "REJECTED"] as const).entries()) {
      const documentId = `doc_terminal_evidence_${index}`;
      const signedJws = `terminal-evidence-jws-${index}`;
      const codigoGeneracion =
        `76767676-7676-4676-8676-76767676767${index}`;
      const numeroControl =
        `DTE-15-M001P004-${String(index + 141).padStart(15, "0")}`;
      seedRejectedDocument(database, documentId);
      const claimed = await repository.claimDocumentFiscalCorrection(
        documentCorrectionClaimInput({
          documentId,
          requestId: `75757575-7575-4575-8575-75757575757${index}`
        })
      );
      if (claimed.kind !== "claimed") throw new Error("expected terminal evidence claim");
      const correction = claimed.correction;
      await repository.claimFiscalCorrectionProcessing({
        id: correction.id,
        processingClaimId: correction.processing_claim_id,
        fiscalClaimId: correction.fiscal_claim_id ?? undefined
      });
      await reserveDocumentCorrectionIdentifiers(
        database,
        repository,
        correction,
        documentId,
        codigoGeneracion,
        numeroControl
      );
      await repository.prepareClaimedFiscalCorrectionDocument({
        correctionId: correction.id,
        documentId,
        processingClaimId: correction.processing_claim_id,
        claimId: correction.fiscal_claim_id!,
        codigoGeneracion,
        numeroControl,
        plainJson: { identificacion: { tipoDte: "15" } },
        signedJws,
        donorName: "Donante corregida",
        donorEmail: null
      });
      database.prepare(
        "UPDATE fiscal_corrections SET mh_dispatch_started_at = ? WHERE id = ?"
      ).run("2026-07-18T12:05:00.000Z", correction.id);
      const outcome = {
        status,
        document: {
          documentId,
          documentClaimId: correction.fiscal_claim_id!,
          signedJws
        }
      };

      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        outcome
      )).resolves.toBe(false);
      expect(database.prepare(
        "SELECT status FROM fiscal_corrections WHERE id = ?"
      ).get(correction.id)).toEqual({ status: "PROCESSING" });

      database.prepare(
        `UPDATE dte_documents
            SET status = ?,
                codigo_generacion = 'mismatched-generation-code',
                fiscal_operation_claim_id = NULL,
                fiscal_operation_claimed_at = NULL,
                fiscal_operation_kind = NULL
          WHERE id = ?`
      ).run(status, documentId);
      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        outcome
      )).resolves.toBe(false);
      database.prepare(
        "UPDATE dte_documents SET codigo_generacion = ? WHERE id = ?"
      ).run(codigoGeneracion, documentId);
      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        outcome
      )).resolves.toBe(true);
    }
    database.close();
  });

  it("requires REVIEW_REQUIRED to retain the exact signed correction claim", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    for (const [index, retained] of [false, true].entries()) {
      const documentId = `doc_review_owner_${index}`;
      const signedJws = `review-owner-jws-${index}`;
      seedRejectedDocument(database, documentId);
      const claimed = await repository.claimDocumentFiscalCorrection(
        documentCorrectionClaimInput({
          documentId,
          requestId: `70000005-7777-4777-8777-70000005777${index}`
        })
      );
      if (claimed.kind !== "claimed") throw new Error("expected review owner claim");
      const correction = claimed.correction;
      await repository.claimFiscalCorrectionProcessing({
        id: correction.id,
        processingClaimId: correction.processing_claim_id,
        fiscalClaimId: correction.fiscal_claim_id ?? undefined
      });
      await reserveDocumentCorrectionIdentifiers(
        database,
        repository,
        correction,
        documentId,
        `78787878-7878-4878-8878-78787878787${index}`,
        `DTE-15-M001P004-${String(index + 151).padStart(15, "0")}`
      );
      await repository.prepareClaimedFiscalCorrectionDocument({
        correctionId: correction.id,
        documentId,
        processingClaimId: correction.processing_claim_id,
        claimId: correction.fiscal_claim_id!,
        codigoGeneracion: `78787878-7878-4878-8878-78787878787${index}`,
        numeroControl: `DTE-15-M001P004-${String(index + 151).padStart(15, "0")}`,
        plainJson: { identificacion: { tipoDte: "15" } },
        signedJws,
        donorName: "Donante corregida",
        donorEmail: null
      });
      database.prepare(
        "UPDATE fiscal_corrections SET mh_dispatch_started_at = ? WHERE id = ?"
      ).run("2026-07-18T12:06:00.000Z", correction.id);
      if (!retained) {
        database.prepare(
          "UPDATE dte_documents SET fiscal_operation_claim_id = 'reassigned-claim' WHERE id = ?"
        ).run(documentId);
      }

      await expect(repository.finalizeFiscalCorrection(
        correction.id,
        correction.processing_claim_id,
        {
          status: "REVIEW_REQUIRED",
          document: {
            documentId,
            documentClaimId: correction.fiscal_claim_id!,
            signedJws
          }
        }
      )).resolves.toBe(retained);
      expect(database.prepare(
        "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
      ).get(documentId)).toEqual({
        fiscal_operation_claim_id: retained
          ? correction.fiscal_claim_id
          : "reassigned-claim"
      });
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
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      rejected.correction,
      "doc_explicit_rejection",
      "43434343-4343-4343-8343-434343434343",
      "DTE-15-M001P004-000000000000118"
    );
    await repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: rejected.correction.id,
      documentId: "doc_explicit_rejection",
      processingClaimId: rejected.correction.processing_claim_id,
      claimId: rejected.correction.fiscal_claim_id!,
      codigoGeneracion: "43434343-4343-4343-8343-434343434343",
      numeroControl: "DTE-15-M001P004-000000000000118",
      plainJson: { identificacion: { tipoDte: "15" } },
      signedJws: "explicit-rejection-jws",
      donorName: "Donante corregida",
      donorEmail: null
    });
    const rejectedDocument = {
      documentId: "doc_explicit_rejection",
      documentClaimId: rejected.correction.fiscal_claim_id!,
      signedJws: "explicit-rejection-jws"
    };
    await repository.markFiscalCorrectionMhDispatchStarted({
      correctionId: rejected.correction.id,
      processingClaimId: rejected.correction.processing_claim_id,
      ...rejectedDocument
    });
    await repository.completeDocumentTransmission(
      "doc_explicit_rejection",
      rejected.correction.fiscal_claim_id!,
      {
        status: "REJECTED",
        sello: null,
        mhEstado: "RECHAZADO",
        observaciones: ["Rechazo explícito"],
        acceptedAt: null
      }
    );
    await expect(repository.finalizeFiscalCorrection(
      rejected.correction.id,
      rejected.correction.processing_claim_id,
      {
        status: "REJECTED",
        failureCode: "MH_REJECTED",
        failureMessage: "Rechazo explícito",
        document: rejectedDocument
      }
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
    ).get("doc_explicit_rejection")).toEqual({ fiscal_operation_claim_id: null });
    database.close();
  });

  it("rotates only stale queued and safe pre-dispatch processing correction ownership", async () => {
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
      `UPDATE fiscal_corrections
          SET created_at = '2000-01-01T00:00:00.000Z',
              updated_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?`
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
    database.prepare(
      "UPDATE fiscal_corrections SET mh_dispatch_started_at = ? WHERE id = ?"
    ).run("2026-07-18T12:08:00.000Z", claims[2].id);

    expect((await repository.listRecoverableFiscalCorrections(
      "2026-01-01T00:00:00.000Z"
    )).map((correction) => correction.id).sort()).toEqual([
      claims[0].id,
      claims[1].id
    ].sort());
    const recoveredQueued = await repository.recoverFiscalCorrectionProcessingClaim({
      id: claims[0].id,
      currentProcessingClaimId: claims[0].processing_claim_id,
      nextProcessingClaimId: "correction_processing_recovered_queued",
      staleBefore: "2026-01-01T00:00:00.000Z"
    });
    const recoveredProcessing = await repository.recoverFiscalCorrectionProcessingClaim({
      id: claims[1].id,
      currentProcessingClaimId: claims[1].processing_claim_id,
      nextProcessingClaimId: "correction_processing_recovered_processing",
      staleBefore: "2026-01-01T00:00:00.000Z"
    });
    expect(recoveredQueued).toMatchObject({
      id: claims[0].id,
      status: "PROCESSING",
      processing_claim_id: "correction_processing_recovered_queued",
      issuance_attempt_id: claims[0].issuance_attempt_id
    });
    expect(recoveredProcessing).toMatchObject({
      id: claims[1].id,
      status: "PROCESSING",
      processing_claim_id: "correction_processing_recovered_processing",
      issuance_attempt_id: claims[1].issuance_attempt_id
    });
    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: claims[2].id,
      currentProcessingClaimId: claims[2].processing_claim_id,
      nextProcessingClaimId: "must_not_recover_ambiguous",
      staleBefore: "2026-01-01T00:00:00.000Z"
    })).resolves.toBeNull();
    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: claims[0].id,
      currentProcessingClaimId: claims[0].processing_claim_id,
      nextProcessingClaimId: "must_not_recover_stale_owner",
      staleBefore: "2030-01-01T00:00:00.000Z"
    })).resolves.toBeNull();
    database.close();
  });

  it("discovers stale terminal dispatches without exposing an ambiguous signed dispatch for recovery", async () => {
    const database = migratedDatabase();
    const repository = new Repository(new SqliteD1(database).database);
    const terminalDocumentId = "doc_terminal_dispatch_reconciliation";
    const ambiguousDocumentId = "doc_ambiguous_dispatch_reconciliation";
    seedRejectedDocument(database, terminalDocumentId);
    seedRejectedDocument(database, ambiguousDocumentId);
    const terminalClaim = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: terminalDocumentId,
        requestId: "57575757-5757-4757-8757-575757575757"
      })
    );
    const ambiguousClaim = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId: ambiguousDocumentId,
        requestId: "58585858-5858-4858-8858-585858585858"
      })
    );
    if (terminalClaim.kind !== "claimed" || ambiguousClaim.kind !== "claimed") {
      throw new Error("expected terminal reconciliation correction claims");
    }
    const cases = [
      {
        correction: terminalClaim.correction,
        documentId: terminalDocumentId,
        codigoGeneracion: "57575757-5757-4757-8757-575757575757",
        numeroControl: "DTE-15-M001P004-000000000000157",
        signedJws: "signed-terminal-dispatch"
      },
      {
        correction: ambiguousClaim.correction,
        documentId: ambiguousDocumentId,
        codigoGeneracion: "58585858-5858-4858-8858-585858585858",
        numeroControl: "DTE-15-M001P004-000000000000158",
        signedJws: "signed-ambiguous-dispatch"
      }
    ];
    for (const item of cases) {
      await repository.claimFiscalCorrectionProcessing({
        id: item.correction.id,
        processingClaimId: item.correction.processing_claim_id,
        fiscalClaimId: item.correction.fiscal_claim_id ?? undefined
      });
      await reserveDocumentCorrectionIdentifiers(
        database,
        repository,
        item.correction,
        item.documentId,
        item.codigoGeneracion,
        item.numeroControl
      );
      await repository.prepareClaimedFiscalCorrectionDocument({
        correctionId: item.correction.id,
        documentId: item.documentId,
        processingClaimId: item.correction.processing_claim_id,
        claimId: item.correction.fiscal_claim_id!,
        codigoGeneracion: item.codigoGeneracion,
        numeroControl: item.numeroControl,
        plainJson: {
          identificacion: {
            tipoDte: "15",
            codigoGeneracion: item.codigoGeneracion,
            numeroControl: item.numeroControl
          }
        },
        signedJws: item.signedJws,
        donorName: "Donante corregida",
        donorEmail: "corregida@example.org"
      });
      await repository.markFiscalCorrectionMhDispatchStarted({
        correctionId: item.correction.id,
        processingClaimId: item.correction.processing_claim_id,
        documentId: item.documentId,
        documentClaimId: item.correction.fiscal_claim_id!,
        signedJws: item.signedJws
      });
      database.prepare(
        "UPDATE fiscal_corrections SET processing_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
      ).run(item.correction.id);
    }
    await repository.completeDocumentTransmission(
      terminalDocumentId,
      terminalClaim.correction.fiscal_claim_id!,
      {
        status: "REJECTED",
        sello: null,
        mhEstado: "RECHAZADO",
        observaciones: ["Rechazo conocido"],
        acceptedAt: null
      }
    );

    await expect(repository.listRecoverableFiscalCorrections(
      "2026-01-01T00:00:00.000Z"
    )).resolves.toEqual([
      expect.objectContaining({
        id: terminalClaim.correction.id,
        status: "PROCESSING",
        processing_claim_id: terminalClaim.correction.processing_claim_id,
        mh_dispatch_started_at: expect.any(String)
      })
    ]);
    expect(database.prepare(
      "SELECT processing_claim_id FROM fiscal_corrections WHERE id = ?"
    ).get(terminalClaim.correction.id)).toEqual({
      processing_claim_id: terminalClaim.correction.processing_claim_id
    });
    expect(database.prepare(
      "SELECT processing_claim_id FROM fiscal_corrections WHERE id = ?"
    ).get(ambiguousClaim.correction.id)).toEqual({
      processing_claim_id: ambiguousClaim.correction.processing_claim_id
    });
    database.close();
  });

  it("recovers a stale signed document correction only with its matching fiscal claim", async () => {
    const database = migratedDatabase();
    const documentId = "doc_recover_signed_correction";
    seedRejectedDocument(database, documentId);
    const repository = new Repository(new SqliteD1(database).database);
    const claimed = await repository.claimDocumentFiscalCorrection(
      documentCorrectionClaimInput({
        documentId,
        requestId: "56565656-5656-4656-8656-565656565656"
      })
    );
    if (claimed.kind !== "claimed") throw new Error("expected signed recovery claim");
    const correction = claimed.correction;
    await repository.claimFiscalCorrectionProcessing({
      id: correction.id,
      processingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id ?? undefined
    });
    await reserveDocumentCorrectionIdentifiers(
      database,
      repository,
      correction,
      documentId,
      "56565656-5656-4656-8656-565656565656",
      "DTE-15-M001P004-000000000000156"
    );
    await repository.prepareClaimedFiscalCorrectionDocument({
      correctionId: correction.id,
      documentId,
      processingClaimId: correction.processing_claim_id,
      claimId: correction.fiscal_claim_id!,
      codigoGeneracion: "56565656-5656-4656-8656-565656565656",
      numeroControl: "DTE-15-M001P004-000000000000156",
      plainJson: {
        identificacion: {
          tipoDte: "15",
          codigoGeneracion: "56565656-5656-4656-8656-565656565656",
          numeroControl: "DTE-15-M001P004-000000000000156"
        }
      },
      signedJws: "signed-recoverable-correction",
      donorName: "Donante corregida",
      donorEmail: "corregida@example.org"
    });
    database.prepare(
      "UPDATE fiscal_corrections SET processing_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(correction.id);

    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "correction_processing_recovered_signed",
      staleBefore: "2026-01-01T00:00:00.000Z"
    })).resolves.toMatchObject({
      id: correction.id,
      status: "PROCESSING",
      processing_claim_id: "correction_processing_recovered_signed",
      fiscal_claim_id: correction.fiscal_claim_id
    });
    expect(database.prepare(
      `SELECT status, signed_jws, fiscal_operation_claim_id
         FROM dte_documents WHERE id = ?`
    ).get(documentId)).toEqual({
      status: "SIGNED",
      signed_jws: "signed-recoverable-correction",
      fiscal_operation_claim_id: correction.fiscal_claim_id
    });
    await expect(repository.recoverFiscalCorrectionProcessingClaim({
      id: correction.id,
      currentProcessingClaimId: correction.processing_claim_id,
      nextProcessingClaimId: "must_not_recover_old_signed_owner",
      staleBefore: "2030-01-01T00:00:00.000Z"
    })).resolves.toBeNull();
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

  it("limits ordinary receipt lookup to the materialized document page while preserving latest metadata", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(
      database,
      "doc_ordinary_page_newest",
      "2026-07-18T12:00:00.000Z",
      "newest@example.org",
      "5"
    );
    seedAcceptedDocument(
      database,
      "doc_ordinary_page_lookahead",
      "2026-07-18T11:00:00.000Z",
      "lookahead@example.org",
      "6"
    );
    seedAcceptedDocument(
      database,
      "doc_ordinary_off_page",
      "2026-07-18T10:00:00.000Z",
      "off-page@example.org",
      "7"
    );
    database.prepare(
      "UPDATE dte_documents SET created_at = ?, updated_at = ? WHERE id = ?"
    ).run(
      "2026-07-18T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "doc_ordinary_page_newest"
    );
    database.prepare(
      "UPDATE dte_documents SET created_at = ?, updated_at = ? WHERE id = ?"
    ).run(
      "2026-07-18T11:00:00.000Z",
      "2026-07-18T11:00:00.000Z",
      "doc_ordinary_page_lookahead"
    );
    database.prepare(
      "UPDATE dte_documents SET created_at = ?, updated_at = ? WHERE id = ?"
    ).run(
      "2026-07-18T10:00:00.000Z",
      "2026-07-18T10:00:00.000Z",
      "doc_ordinary_off_page"
    );
    const insertDelivery = database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, provider_response_json,
         email_type, document_status_at_send, outcome_class, failure_code,
         retry_safe, attempt_no, created_at
       ) VALUES (?, ?, ?, ?, '{}', 'dteReceipt', 'ACCEPTED', ?, ?, ?, ?, ?)`
    );
    insertDelivery.run(
      "delivery_ordinary_old",
      "doc_ordinary_page_newest",
      "newest@example.org",
      "FAILED",
      "NOT_SENT",
      "E_HEADER_NOT_ALLOWED",
      1,
      1,
      "2026-07-18T12:01:00.000Z"
    );
    insertDelivery.run(
      "delivery_ordinary_latest",
      "doc_ordinary_page_newest",
      "newest@example.org",
      "FAILED",
      "UNKNOWN",
      "E_INTERNAL_SERVER_ERROR",
      0,
      2,
      "2026-07-18T12:02:00.000Z"
    );
    insertDelivery.run(
      "delivery_ordinary_off_page",
      "doc_ordinary_off_page",
      "off-page@example.org",
      "SENT",
      null,
      null,
      0,
      1,
      "2026-07-18T10:01:00.000Z"
    );
    const repository = new Repository(d1.database);

    await expect(repository.listDteDocuments({ limit: 1 })).resolves.toMatchObject({
      documents: [
        expect.objectContaining({
          id: "doc_ordinary_page_newest",
          receipt_email_status: "FAILED",
          receipt_email_outcome_class: "UNKNOWN",
          receipt_email_failure_code: "E_INTERNAL_SERVER_ERROR",
          receipt_email_retry_safe: 0,
          receipt_email_requires_review: 1
        })
      ],
      hasMore: true
    });

    const listStatement = d1.statements.find((statement) =>
      statement.sql.includes("AS receipt_email_status")
    );
    expect(listStatement?.sql).toContain("page_documents AS MATERIALIZED");
    if (!listStatement) throw new Error("document list statement was not captured");
    const queryPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${listStatement.sql}`)
      .all(...listStatement.args) as Array<{ detail: string }>;
    expect(queryPlan.map((step) => step.detail)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /SEARCH receipt_candidate USING INDEX idx_email_deliveries_latest_receipt \(document_id=\? AND email_type=\?\)/
        )
      ])
    );
    expect(queryPlan.some((step) => /SCAN receipt_candidate/.test(step.detail))).toBe(false);
    database.close();
  });

  it("keeps status, FTS search, and cursor bindings correct on ordinary materialized pages", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    const rows = [
      ["doc_search_4", "2026-07-18T14:00:00.000Z", "Search Smoke Four", "4"],
      ["doc_search_3", "2026-07-18T13:00:00.000Z", "Search Smoke Three", "3"],
      ["doc_search_2", "2026-07-18T12:00:00.000Z", "Search Smoke Two", "2"],
      ["doc_search_1", "2026-07-18T11:00:00.000Z", "Search Smoke One", "1"]
    ] as const;
    for (const [id, createdAt, donorName, suffix] of rows) {
      seedAcceptedDocument(database, id, createdAt, `${id}@example.org`, suffix);
      database.prepare(
        `UPDATE dte_documents
            SET donor_name = ?, created_at = ?, updated_at = ?
          WHERE id = ?`
      ).run(donorName, createdAt, createdAt, id);
      indexDocumentForSearch(database, id);
    }
    seedRejectedDocument(database, "doc_search_rejected");
    database.prepare(
      `UPDATE dte_documents
          SET donor_name = 'Search Smoke Rejected',
              created_at = '2026-07-18T15:00:00.000Z',
              updated_at = '2026-07-18T15:00:00.000Z'
        WHERE id = 'doc_search_rejected'`
    ).run();
    indexDocumentForSearch(database, "doc_search_rejected");
    const repository = new Repository(d1.database);

    const firstPage = await repository.listDteDocuments({
      status: "ACCEPTED",
      q: "Search Smoke",
      limit: 2
    });
    expect(firstPage.documents.map((document) => document.id)).toEqual([
      "doc_search_4",
      "doc_search_3"
    ]);
    expect(firstPage).toMatchObject({ hasMore: true, limit: 2 });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await repository.listDteDocuments({
      status: "ACCEPTED",
      q: "Search Smoke",
      limit: 2,
      cursor: firstPage.nextCursor
    });
    expect(secondPage.documents.map((document) => document.id)).toEqual([
      "doc_search_2",
      "doc_search_1"
    ]);
    expect(secondPage).toMatchObject({
      hasMore: false,
      nextCursor: null,
      limit: 2
    });

    const listStatements = d1.statements.filter((statement) =>
      statement.sql.includes("AS receipt_email_status")
    );
    expect(listStatements).toHaveLength(2);
    expect(listStatements[0].args).toEqual(["ACCEPTED", "search* AND smoke*", 3]);
    expect(listStatements[1].args).toEqual([
      "ACCEPTED",
      "search* AND smoke*",
      "2026-07-18T13:00:00.000Z",
      "2026-07-18T13:00:00.000Z",
      "doc_search_3",
      3
    ]);
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

  it("restores and deletes the real contingency cycle with fiscal corrections in one deferred-FK transaction", () => {
    const database = migratedDatabase();
    const protocol = RETENTION_FOREIGN_KEY_PROTOCOL;
    const restorePhase = (table: string) =>
      protocol.restorePhases.findIndex((phase) => phase.tables.includes(table));
    const deletePhase = (table: string) =>
      protocol.deletePhases.findIndex((phase) => phase.tables.includes(table));

    expect(protocol.wranglerFile).toEqual({
      deferForeignKeys: "PRAGMA defer_foreign_keys = ON",
      verify: "PRAGMA foreign_key_check",
      forbiddenTransactionStatements: ["BEGIN", "COMMIT", "ROLLBACK"]
    });
    expect(protocol.localSqliteTransaction).toEqual({
      begin: "BEGIN IMMEDIATE",
      commit: "COMMIT",
      rollback: "ROLLBACK"
    });
    expect(restorePhase("fiscal_corrections")).toBeGreaterThan(
      restorePhase("dte_documents")
    );
    expect(deletePhase("fiscal_corrections")).toBeLessThan(
      deletePhase("dte_documents")
    );

    const restoreOperations: Record<string, () => void> = {
      wompi_events: () => {
        database.prepare(
          `INSERT INTO wompi_events (
             id, transaction_id, environment, result, amount_cents, raw_body
           ) VALUES ('restore_wompi', 'restore_transaction', '00',
                     'ExitosaAprobada', 100, '{}')`
        ).run();
      },
      contingency_periods: () => {
        database.prepare(
          `INSERT INTO contingency_periods (
             id, environment, status, reason, started_at, event_id
           ) VALUES ('restore_period', '00', 'EVENT_ACCEPTED', 'restore',
                     '2026-07-01T00:00:00.000Z', 'restore_event')`
        ).run();
      },
      dte_documents: () => {
        database.prepare(
          `INSERT INTO dte_documents (
             id, wompi_event_id, environment, codigo_generacion, numero_control,
             status, plain_json, amount_cents, issued_at, contingency_period_id
           ) VALUES ('restore_document', 'restore_wompi', '00',
                     '45454545-4545-4545-8545-454545454545',
                     'DTE-15-M001P004-000000000000145', 'REJECTED', '{}', 100,
                     '2026-07-01T00:00:00.000Z', 'restore_period')`
        ).run();
      },
      dte_events: () => {
        database.prepare(
          `INSERT INTO dte_events (
             id, document_id, event_type, environment, codigo_generacion,
             status, plain_json
           ) VALUES ('restore_event', 'restore_document', 'CONTINGENCIA', '00',
                     '46464646-4646-4646-8646-464646464646', 'ACCEPTED', '{}')`
        ).run();
      },
      fiscal_corrections: () => {
        database.prepare(
          `INSERT INTO fiscal_corrections (
             id, request_id, request_payload_sha256, attempt_number, target_kind,
             document_id, environment, status, before_receptor_json,
             corrected_receptor_json, changed_fields_json,
             source_document_snapshot_json, processing_claim_id, created_by
           ) VALUES (
             'restore_correction', '47474747-4747-4747-8747-474747474747',
             'restore-sha', 1, 'DTE_DOCUMENT', 'restore_document', '00',
             'FAILED', '{}', '{}', '[]', '{}', 'restore-processing',
             'user_operator'
           )`
        ).run();
      }
    };

    // better-sqlite3 supplies the transaction that Wrangler supplies remotely;
    // the simulated restore file begins at deferForeignKeys and contains no
    // nested BEGIN/COMMIT/ROLLBACK statements.
    database.exec(protocol.localSqliteTransaction.begin);
    database.exec(protocol.wranglerFile.deferForeignKeys);
    for (const phase of protocol.restorePhases) {
      for (const table of phase.tables) restoreOperations[table]?.();
    }
    expect(database.prepare(protocol.wranglerFile.verify).all()).toEqual([]);
    database.exec(protocol.localSqliteTransaction.commit);
    expect(database.prepare(protocol.wranglerFile.verify).all()).toEqual([]);

    const deleteOperations: Record<string, () => void> = {
      fiscal_corrections: () => {
        database.prepare("DELETE FROM fiscal_corrections WHERE id = 'restore_correction'").run();
      },
      contingency_periods: () => {
        database.prepare("DELETE FROM contingency_periods WHERE id = 'restore_period'").run();
      },
      dte_documents: () => {
        database.prepare("DELETE FROM dte_documents WHERE id = 'restore_document'").run();
      },
      dte_events: () => {
        database.prepare("DELETE FROM dte_events WHERE id = 'restore_event'").run();
      },
      wompi_events: () => {
        database.prepare("DELETE FROM wompi_events WHERE id = 'restore_wompi'").run();
      }
    };
    database.exec(protocol.localSqliteTransaction.begin);
    database.exec(protocol.wranglerFile.deferForeignKeys);
    for (const phase of protocol.deletePhases) {
      for (const table of phase.tables) deleteOperations[table]?.();
    }
    expect(database.prepare(protocol.wranglerFile.verify).all()).toEqual([]);
    database.exec(protocol.localSqliteTransaction.commit);
    expect(database.prepare(protocol.wranglerFile.verify).all()).toEqual([]);
    expect(database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM fiscal_corrections) AS corrections,
         (SELECT COUNT(*) FROM contingency_periods) AS periods,
         (SELECT COUNT(*) FROM dte_events) AS events,
         (SELECT COUNT(*) FROM dte_documents) AS documents,
         (SELECT COUNT(*) FROM wompi_events) AS wompi`
    ).get()).toEqual({
      corrections: 0,
      periods: 0,
      events: 0,
      documents: 0,
      wompi: 0
    });
    database.close();
  });
});

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

function seedFailedCorrectionOwnedDocument(
  database: DatabaseSync,
  input: {
    suffix: number;
    documentStatus: "PENDING" | "SIGNED" | "FAILED" | "CONTINGENCY_PENDING";
    correctionStatus: "PROCESSING" | "FAILED";
  }
): { documentId: string; correctionId: string } {
  const suffix = String(input.suffix).padStart(2, "0");
  const statusSuffix = input.documentStatus.toLowerCase();
  const eventId = `wompi_failed_correction_${suffix}_${statusSuffix}`;
  const documentId = `doc_failed_correction_${input.suffix}_${statusSuffix}`;
  const correctionId = `fiscal_correction_attention_${suffix}_${statusSuffix}`;
  seedFailedWompiEvent(database, eventId);
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control,
       status, plain_json, signed_jws, sello_recibido, mh_estado,
       mh_observaciones_json, amount_cents, issued_at,
       fiscal_operation_claim_id, fiscal_operation_claimed_at,
       fiscal_operation_kind, fiscal_operation_event_id, created_at, updated_at
     ) VALUES (?, ?, '00', ?, ?, ?, '{}', ?, NULL, NULL, '[]', 2500, ?,
               ?, ?, 'TRANSMISSION', NULL, ?, ?)`
  ).run(
    documentId,
    eventId,
    `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    `DTE-15-M001P004-${suffix.padStart(15, "0")}`,
    input.documentStatus,
    input.documentStatus === "PENDING" ? null : `signed-${suffix}`,
    `2026-07-18T12:${suffix}:00.000Z`,
    `fiscal_correction_${correctionId}`,
    `2026-07-18T12:${suffix}:01.000Z`,
    `2026-07-18T12:${suffix}:00.000Z`,
    `2026-07-18T12:${suffix}:01.000Z`
  );
  database.prepare(
    `INSERT INTO fiscal_corrections (
       id, request_id, request_payload_sha256, attempt_number, target_kind,
       wompi_event_id, document_id, environment, status, before_receptor_json,
       corrected_receptor_json, changed_fields_json, source_document_snapshot_json,
       issuance_attempt_id, fiscal_claim_id, processing_claim_id,
       mh_dispatch_started_at, failure_code, failure_message, created_by,
       processing_started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, 'attention-payload-sha', 1, 'WOMPI_EVENT', ?, NULL, '00',
               ?, '{}', '{}', '[]', NULL, ?, NULL, ?, NULL, ?, ?, 'user_operator',
               ?, ?, ?, ?)`
  ).run(
    correctionId,
    `request_failed_correction_${suffix}_${statusSuffix}`,
    eventId,
    input.correctionStatus,
    `issuance_attempt_${suffix}`,
    `processing_claim_${suffix}`,
    input.correctionStatus === "FAILED"
      ? "FISCAL_CORRECTION_EXISTING_DOCUMENT_MISMATCH"
      : null,
    input.correctionStatus === "FAILED"
      ? "El CDE preexistente no coincide con la corrección fiscal vigente o con la intención Wompi enlazada. Requiere reconciliación manual; no se transmitió a MH."
      : null,
    `2026-07-18T12:${suffix}:01.000Z`,
    input.correctionStatus === "FAILED"
      ? `2026-07-18T12:${suffix}:02.000Z`
      : null,
    `2026-07-18T12:${suffix}:00.000Z`,
    `2026-07-18T12:${suffix}:02.000Z`
  );
  database.prepare(
    `UPDATE wompi_events
        SET created_document_id = ?,
            issuance_status = 'DOCUMENT_CREATED',
            issuance_attempt_id = ?
      WHERE id = ?`
  ).run(documentId, `issuance_attempt_${suffix}`, eventId);
  return { documentId, correctionId };
}

async function observedWompiRetry(
  repository: Repository,
  wompiEventId: string
) {
  const observed = await repository.getWompiIssuanceRetrySnapshotById(wompiEventId);
  if (!observed) throw new Error(`missing Wompi retry snapshot ${wompiEventId}`);
  return observed;
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

function indexDocumentForSearch(database: DatabaseSync, documentId: string): void {
  database.prepare(
    `INSERT INTO dte_document_search (
       document_id,
       codigo_generacion,
       codigo_generacion_compact,
       numero_control,
       numero_control_compact,
       numero_control_serial,
       donor_email,
       donor_name
     )
     SELECT
       id,
       codigo_generacion,
       lower(replace(codigo_generacion, '-', '')),
       numero_control,
       lower(replace(numero_control, '-', '')),
       COALESCE(NULLIF(ltrim(substr(numero_control, -15), '0'), ''), substr(numero_control, -15)),
       donor_email,
       donor_name
       FROM dte_documents
      WHERE id = ?`
  ).run(documentId);
}

async function reserveDocumentCorrectionIdentifiers(
  database: DatabaseSync,
  repository: Repository,
  correction: {
    id: string;
    environment: "00" | "01";
    processing_claim_id: string;
    fiscal_claim_id: string | null;
  },
  documentId: string,
  codigoGeneracion: string,
  numeroControl: string
): Promise<void> {
  const match = /^DTE-15-([A-Z0-9]{8})-(\d{15})$/.exec(numeroControl);
  if (!match || !correction.fiscal_claim_id) {
    throw new Error("invalid test correction reservation");
  }
  const [, controlPrefix, sequenceText] = match;
  database.prepare(
    `INSERT INTO document_sequences (environment, control_prefix, next_value)
     VALUES (?, ?, ?)
     ON CONFLICT(environment, control_prefix)
     DO UPDATE SET next_value = excluded.next_value`
  ).run(correction.environment, controlPrefix, Number(sequenceText));
  await expect(repository.reserveFiscalCorrectionDocumentIdentifiers({
    correctionId: correction.id,
    documentId,
    processingClaimId: correction.processing_claim_id,
    fiscalClaimId: correction.fiscal_claim_id,
    environment: correction.environment,
    controlPrefix,
    codigoGeneracion
  })).resolves.toEqual({
    sequence: Number(sequenceText),
    codigoGeneracion,
    numeroControl
  });
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
