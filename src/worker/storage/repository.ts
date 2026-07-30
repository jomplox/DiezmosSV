import type { Ambiente, ContingencyBatchLineRecord, ContingencyBatchRecord, DonationIntentListItem, DonationIntentRecord, DteDocumentRecord, FiscalCorrectionRecord, WompiDocumentIdentifiers, WompiEventRecord, WompiIssuanceFailureItem, WompiIssuanceRetrySnapshot, WompiPaymentLink, WompiWebhook } from "../types";
import type { AuditRequestContext } from "../services/requestContext";
import type { ContactSourceRow } from "../services/contacts";
import {
  createAudit as createAuditRepository,
  createAuditIfAbsent as createAuditIfAbsentRepository,
  ensurePostAcceptAudit as ensurePostAcceptAuditRepository,
  listAudit as listAuditRepository,
  listAuditPage as listAuditPageRepository
} from "./repository/audit";
import {
  getOpenContingency as getOpenContingencyRepository,
  listContingencyBatchLines as listContingencyBatchLinesRepository,
  listContingencyBatches as listContingencyBatchesRepository,
  listContingencyDocuments as listContingencyDocumentsRepository,
  listContingencyPeriods as listContingencyPeriodsRepository,
  listDteEventsByType as listDteEventsByTypeRepository
} from "./repository/contingency";
import {
  countUsers as countUsersRepository,
  createInitialOwner as createInitialOwnerRepository,
  createPasswordResetToken as createPasswordResetTokenRepository,
  createSessionIfCredentialsCurrent as createSessionIfCredentialsCurrentRepository,
  createUser as createUserRepository,
  getActivePasswordResetUser as getActivePasswordResetUserRepository,
  getSessionUser as getSessionUserRepository,
  getUserForLogin as getUserForLoginRepository,
  getUserRole as getUserRoleRepository,
  invalidatePasswordResetToken as invalidatePasswordResetTokenRepository,
  listUsers as listUsersRepository,
  resetPasswordWithToken as resetPasswordWithTokenRepository,
  revokeSession as revokeSessionRepository,
  setUserPassword as setUserPasswordRepository,
  updateUser as updateUserRepository,
  updateUserPasswordHashIfCurrent as updateUserPasswordHashIfCurrentRepository
} from "./repository/identity";
import {
  claimDonationDatosRateLimit as claimDonationDatosRateLimitRepository,
  claimDonationIntentRateLimit as claimDonationIntentRateLimitRepository,
  claimLoginAttempt as claimLoginAttemptRepository,
  claimPasswordResetBudgets as claimPasswordResetBudgetsRepository,
  deleteExpiredLoginRateLimits as deleteExpiredLoginRateLimitsRepository,
  deleteExpiredSecurityRateLimitClaims as deleteExpiredSecurityRateLimitClaimsRepository
} from "./repository/rateLimits";
import {
  INTENT_EXPIRY_SWEEP_LIMIT as DONATION_INTENT_EXPIRY_SWEEP_LIMIT,
  INTENT_RECONCILIATION_SWEEP_LIMIT as DONATION_INTENT_RECONCILIATION_SWEEP_LIMIT,
  applyIntentDatosWithCapability as applyIntentDatosWithCapabilityRepository,
  attachIntentLink as attachIntentLinkRepository,
  completeIntentForPostAcceptOwner as completeIntentForPostAcceptOwnerRepository,
  createDonationIntent as createDonationIntentRepository,
  expireDonationIntentsByIds as expireDonationIntentsByIdsRepository,
  getCompletedIntentForDocument as getCompletedIntentForDocumentRepository,
  getDonationIntent as getDonationIntentRepository,
  hasAuditAction as hasAuditActionRepository,
  listIntentsForWompiReconciliation as listIntentsForWompiReconciliationRepository,
  listIntentsExpiringBefore as listIntentsExpiringBeforeRepository,
  listRecentDonationIntents as listRecentDonationIntentsRepository,
  markIntentCompleted as markIntentCompletedRepository,
  markIntentPaid as markIntentPaidRepository,
  touchIntentWompiReconciliationCheck as touchIntentWompiReconciliationCheckRepository,
  type CreateDonationIntentInput,
  type IntentDatosInput
} from "./repository/donationIntents";
import {
  claimEmailDelivery as claimEmailDeliveryRepository,
  claimManualEmailDelivery as claimManualEmailDeliveryRepository,
  claimOperationalAlertDelivery as claimOperationalAlertDeliveryRepository,
  finalizeEmailDeliveryClaim as finalizeEmailDeliveryClaimRepository,
  finalizeOperationalAlertDelivery as finalizeOperationalAlertDeliveryRepository,
  getLatestReceiptEmailDelivery as getLatestReceiptEmailDeliveryRepository,
  markEmailDeliveryDispatchStarted as markEmailDeliveryDispatchStartedRepository,
  markOperationalAlertDispatchStarted as markOperationalAlertDispatchStartedRepository,
  recordEmailDelivery as recordEmailDeliveryRepository,
  type EmailDeliveryOutcomeClass,
  type ManualEmailDeliveryClaim,
  type OperationalAlertDeliveryClaim,
  type ReceiptEmailDeliveryState
} from "./repository/deliveries";
import { getSetting, setSetting } from "./repository/settings";
import {
  earliestDteDocumentCreatedAt as earliestDteDocumentCreatedAtRepository,
  listDonationIntentsForAnalytics as listDonationIntentsForAnalyticsRepository,
  listEmailDeliveriesForAnalytics as listEmailDeliveriesForAnalyticsRepository,
  listWompiLaneDocumentsForAnalytics as listWompiLaneDocumentsForAnalyticsRepository
} from "./repository/analyticsReads";
import {
  RETENTION_PAGE_SIZE,
  countAuditEntries as countAuditEntriesRepository,
  countAuditEntriesSince as countAuditEntriesSinceRepository,
  countAuditEntriesSinceForIp as countAuditEntriesSinceForIpRepository,
  listAcceptedDocumentsInYear as listAcceptedDocumentsInYearRepository,
  listAcceptedDteDocumentsForExport as listAcceptedDteDocumentsForExportRepository,
  listAcceptedWompiContactRows as listAcceptedWompiContactRowsRepository,
  listAllRowsPaged as listAllRowsPagedRepository,
  listDocumentSequencesPaged as listDocumentSequencesPagedRepository,
  listRowsCreatedBetween as listRowsCreatedBetweenRepository,
  listStalledApprovedWompiEvents as listStalledApprovedWompiEventsRepository,
  type DocumentSequenceRetentionCursor,
  type RetentionCursor,
  type RetentionSnapshotTable,
  type RetentionTable
} from "./repository/retentionReads";
import {
  listDonors as listDonorsRepository,
  type DonorExplorerFilters,
  type DonorExplorerPage
} from "./repository/donors";
import {
  claimCorrectedWompiEventIssuance as claimCorrectedWompiEventIssuanceRepository,
  claimInitialWompiIssuanceAttempt as claimInitialWompiIssuanceAttemptRepository,
  claimStalledWompiIssuanceAttempt as claimStalledWompiIssuanceAttemptRepository,
  claimWompiEventIssuance as claimWompiEventIssuanceRepository,
  claimWompiIssuanceRetry as claimWompiIssuanceRetryRepository,
  createWompiAttemptAudit as createWompiAttemptAuditRepository,
  getWompiEventById as getWompiEventByIdRepository,
  getWompiEventByPaymentLinkId as getWompiEventByPaymentLinkIdRepository,
  getWompiEventByTransaction as getWompiEventByTransactionRepository,
  getWompiIssuanceFailureById as getWompiIssuanceFailureByIdRepository,
  getWompiIssuanceRetrySnapshotById as getWompiIssuanceRetrySnapshotByIdRepository,
  insertWompiEvent as insertWompiEventRepository,
  listWompiIssuanceFailures as listWompiIssuanceFailuresRepository,
  markWompiIssuanceDeadLettered as markWompiIssuanceDeadLetteredRepository,
  markWompiIssuanceIgnored as markWompiIssuanceIgnoredRepository,
  markWompiIssuanceProcessing as markWompiIssuanceProcessingRepository,
  recordWompiIssuanceFailure as recordWompiIssuanceFailureRepository,
  releaseWompiEventIssuance as releaseWompiEventIssuanceRepository,
  reserveWompiDocumentIdentifiers as reserveWompiDocumentIdentifiersRepository
} from "./repository/wompiIssuance";
import {
  claimDocumentInvalidation as claimDocumentInvalidationRepository,
  claimDocumentPostAcceptFinalization as claimDocumentPostAcceptFinalizationRepository,
  claimDocumentTransmission as claimDocumentTransmissionRepository,
  completeDocumentInvalidation as completeDocumentInvalidationRepository,
  completeDocumentTransmission as completeDocumentTransmissionRepository,
  createAndAttachDocumentInvalidationEvent as createAndAttachDocumentInvalidationEventRepository,
  createClaimedWompiDteDocument as createClaimedWompiDteDocumentRepository,
  createDteDocument as createDteDocumentRepository,
  getDteDocument as getDteDocumentRepository,
  getDteDocumentByWompiEvent as getDteDocumentByWompiEventRepository,
  hasHandledEmail as hasHandledEmailRepository,
  hasSentEmail as hasSentEmailRepository,
  indexDteDocument as indexDteDocumentRepository,
  indexDteDocumentById as indexDteDocumentByIdRepository,
  listAcceptedWompiDocumentsMissingFinalization as listAcceptedWompiDocumentsMissingFinalizationRepository,
  listDeferredTransmissionDocuments as listDeferredTransmissionDocumentsRepository,
  listDteDocuments as listDteDocumentsRepository,
  listPendingPostAcceptFinalizations as listPendingPostAcceptFinalizationsRepository,
  markDocumentFailed as markDocumentFailedRepository,
  markDocumentPostAcceptEmailDispatchStarted as markDocumentPostAcceptEmailDispatchStartedRepository,
  markDocumentPostAcceptFinalized as markDocumentPostAcceptFinalizedRepository,
  markDocumentTransmissionDeferred as markDocumentTransmissionDeferredRepository,
  markWompiDocumentCreated as markWompiDocumentCreatedRepository,
  markWompiEventProcessed as markWompiEventProcessedRepository,
  nextControlSequence as nextControlSequenceRepository,
  quarantineWompiIntentBinding as quarantineWompiIntentBindingRepository,
  releaseDocumentFiscalOperation as releaseDocumentFiscalOperationRepository,
  releaseDocumentInvalidationBeforeDispatch as releaseDocumentInvalidationBeforeDispatchRepository,
  releaseDocumentPostAcceptFinalization as releaseDocumentPostAcceptFinalizationRepository,
  updateClaimedDocumentSigned as updateClaimedDocumentSignedRepository,
  updateDocumentDonorEmail as updateDocumentDonorEmailRepository,
  updateDocumentSigned as updateDocumentSignedRepository,
  type DteDocumentHost,
  type DteDocumentListPage
} from "./repository/dteDocuments";

import {
  claimDocumentFiscalCorrection as claimDocumentFiscalCorrectionRepository,
  claimFiscalCorrectionProcessing as claimFiscalCorrectionProcessingRepository,
  claimWompiFiscalCorrection as claimWompiFiscalCorrectionRepository,
  claimWompiFiscalCorrectionDocument as claimWompiFiscalCorrectionDocumentRepository,
  clearFiscalCorrectionMhDispatchStarted as clearFiscalCorrectionMhDispatchStartedRepository,
  createFiscalCorrectionAudit as createFiscalCorrectionAuditRepository,
  finalizeDirectFiscalCorrectionGenerationDisabled as finalizeDirectFiscalCorrectionGenerationDisabledRepository,
  finalizeFiscalCorrection as finalizeFiscalCorrectionRepository,
  finalizeWompiFiscalCorrectionFailure as finalizeWompiFiscalCorrectionFailureRepository,
  getActiveFiscalCorrectionForTarget as getActiveFiscalCorrectionForTargetRepository,
  getFailedWompiFiscalCorrectionForDocument as getFailedWompiFiscalCorrectionForDocumentRepository,
  getFiscalCorrection as getFiscalCorrectionRepository,
  getFiscalCorrectionByRequestId as getFiscalCorrectionByRequestIdRepository,
  listRecoverableFiscalCorrections as listRecoverableFiscalCorrectionsRepository,
  markFiscalCorrectionMhDispatchStarted as markFiscalCorrectionMhDispatchStartedRepository,
  prepareClaimedFiscalCorrectionDocument as prepareClaimedFiscalCorrectionDocumentRepository,
  reconcileFiscalCorrectionAudits as reconcileFiscalCorrectionAuditsRepository,
  recoverFiscalCorrectionProcessingClaim as recoverFiscalCorrectionProcessingClaimRepository,
  renewFiscalCorrectionDocumentSigningLease as renewFiscalCorrectionDocumentSigningLeaseRepository,
  reserveFiscalCorrectionDocumentIdentifiers as reserveFiscalCorrectionDocumentIdentifiersRepository,
  type DocumentFiscalCorrectionClaimInput,
  type FailedWompiFiscalCorrectionSummary,
  type FiscalCorrectionAuditTransition,
  type FiscalCorrectionClaimResult,
  type FiscalCorrectionMhDispatchInput,
  type FiscalCorrectionOutcome,
  type WompiFiscalCorrectionClaimInput
} from "./repository/fiscalCorrections";

export type {
  DocumentFiscalCorrectionClaimInput,
  FailedWompiFiscalCorrectionSummary,
  FiscalCorrectionAuditTransition,
  FiscalCorrectionClaimResult,
  FiscalCorrectionDocumentEvidence,
  FiscalCorrectionMhDispatchInput,
  FiscalCorrectionOutcome,
  WompiFiscalCorrectionClaimInput
} from "./repository/fiscalCorrections";

export { legacyIssuanceAttemptId } from "./repository/wompiIssuance";
export { INTENT_EXPIRY_SWEEP_LIMIT } from "./repository/donationIntents";
export { INTENT_RECONCILIATION_SWEEP_LIMIT } from "./repository/donationIntents";
export {
  OwnerTargetProtectedError,
  UserMutationConflictError
} from "./repository/identity";
export type {
  EmailDeliveryOutcomeClass,
  ManualEmailDeliveryClaim,
  OperationalAlertDeliveryClaim,
  ReceiptEmailDeliveryState
} from "./repository/deliveries";
export type { DteDocumentListPage } from "./repository/dteDocuments";
export {
  RETENTION_PAGE_SIZE,
  RETENTION_SNAPSHOT_TABLES,
  RETENTION_WINDOWED_TABLES
} from "./repository/retentionReads";
export type {
  DocumentSequenceRetentionCursor,
  RetentionCursor,
  RetentionSnapshotTable,
  RetentionTable
} from "./repository/retentionReads";
export type {
  DonorExplorerFilters,
  DonorExplorerPage,
  DonorExplorerRow
} from "./repository/donors";

export class Repository {
  // Optional per-request actor context. When handleApi/webhook build the Repository
  // with a request, every createAudit call inherits the caller's IP and cf context
  // without touching a single call site. Cron/queue handlers omit it, so their
  // SYSTEM audits stay NULL — which is exactly what we want (no request => no actor).
  constructor(
    private readonly db: D1Database,
    private readonly auditContext?: AuditRequestContext
  ) {}

  async getSetting(key: string): Promise<string | null> {
    return getSetting(this.db, key);
  }

  async setSetting(key: string, value: string, updatedBy?: string | null): Promise<void> {
    return setSetting(this.db, key, value, updatedBy);
  }

  async insertWompiEvent(payload: WompiWebhook, rawBody: string, headers: Record<string, string>, environment: Ambiente): Promise<{ record: WompiEventRecord; inserted: boolean }> {
    return insertWompiEventRepository(this.db, this, payload, rawBody, headers, environment);
  }

  async getWompiEventById(id: string): Promise<WompiEventRecord | null> {
    return getWompiEventByIdRepository(this.db, id);
  }

  async getWompiEventByTransaction(transactionId: string): Promise<WompiEventRecord | null> {
    return getWompiEventByTransactionRepository(this.db, transactionId);
  }

  async getWompiEventByPaymentLinkId(paymentLinkId: number): Promise<WompiEventRecord | null> {
    return getWompiEventByPaymentLinkIdRepository(this.db, paymentLinkId);
  }

  async claimWompiFiscalCorrection(
    input: WompiFiscalCorrectionClaimInput
  ): Promise<FiscalCorrectionClaimResult> {
    return claimWompiFiscalCorrectionRepository(
      this.db,
      this.auditContext,
      this,
      input
    );
  }

  // dte_documents.wompi_event_id is a unique foreign key when present, so matching
  // it to a WOMPI_EVENT correction identifies the exact durable event/document pair.
  async claimDocumentFiscalCorrection(
    input: DocumentFiscalCorrectionClaimInput
  ): Promise<FiscalCorrectionClaimResult> {
    return claimDocumentFiscalCorrectionRepository(
      this.db,
      this.auditContext,
      this,
      input
    );
  }

  async getFiscalCorrection(id: string): Promise<FiscalCorrectionRecord | null> {
    return getFiscalCorrectionRepository(this.db, id);
  }

  async getFiscalCorrectionByRequestId(
    requestId: string
  ): Promise<FiscalCorrectionRecord | null> {
    return getFiscalCorrectionByRequestIdRepository(this.db, requestId);
  }





  async createFiscalCorrectionAudit(
    correction: FiscalCorrectionRecord,
    transition: FiscalCorrectionAuditTransition,
    actor?: { type: "SYSTEM" | "USER"; id?: string | null }
  ): Promise<boolean> {
    return createFiscalCorrectionAuditRepository(
      this.db,
      this.auditContext,
      correction,
      transition,
      actor
    );
  }

  async reconcileFiscalCorrectionAudits(
    correction: FiscalCorrectionRecord
  ): Promise<void> {
    return reconcileFiscalCorrectionAuditsRepository(
      this.db,
      this.auditContext,
      correction
    );
  }

  async getActiveFiscalCorrectionForTarget(
    targetKind: FiscalCorrectionRecord["target_kind"],
    targetId: string
  ): Promise<Pick<FiscalCorrectionRecord, "id" | "status"> | null> {
    return getActiveFiscalCorrectionForTargetRepository(
      this.db,
      targetKind,
      targetId
    );
  }

  async claimFiscalCorrectionProcessing(input: {
    id: string;
    processingClaimId: string;
    issuanceAttemptId?: string;
    fiscalClaimId?: string;
  }): Promise<"claimed" | "busy" | "terminal"> {
    return claimFiscalCorrectionProcessingRepository(
      this.db,
      this.auditContext,
      this,
      input
    );
  }

  async markFiscalCorrectionMhDispatchStarted(
    input: FiscalCorrectionMhDispatchInput
  ): Promise<boolean> {
    return markFiscalCorrectionMhDispatchStartedRepository(this.db, input);
  }

  async clearFiscalCorrectionMhDispatchStarted(id: string, claimId: string): Promise<boolean> {
    return clearFiscalCorrectionMhDispatchStartedRepository(
      this.db,
      id,
      claimId
    );
  }

  async reserveFiscalCorrectionDocumentIdentifiers(input: {
    correctionId: string;
    documentId: string;
    processingClaimId: string;
    fiscalClaimId: string;
    environment: Ambiente;
    controlPrefix: string;
    codigoGeneracion: string;
  }): Promise<WompiDocumentIdentifiers | null> {
    return reserveFiscalCorrectionDocumentIdentifiersRepository(this.db, input);
  }

  async renewFiscalCorrectionDocumentSigningLease(input: {
    correctionId: string;
    documentId: string;
    processingClaimId: string;
    fiscalClaimId: string;
    codigoGeneracion: string;
    numeroControl: string;
  }): Promise<boolean> {
    return renewFiscalCorrectionDocumentSigningLeaseRepository(this.db, input);
  }

  async prepareClaimedFiscalCorrectionDocument(input: {
    correctionId: string;
    documentId: string;
    processingClaimId: string;
    claimId: string;
    codigoGeneracion: string;
    numeroControl: string;
    plainJson: Record<string, unknown>;
    signedJws: string;
    donorName: string | null;
    donorEmail: string | null;
  }): Promise<boolean> {
    return prepareClaimedFiscalCorrectionDocumentRepository(
      this.db,
      this,
      input
    );
  }

  async finalizeDirectFiscalCorrectionGenerationDisabled(
    id: string,
    processingClaimId: string
  ): Promise<boolean> {
    return finalizeDirectFiscalCorrectionGenerationDisabledRepository(
      this.db,
      this.auditContext,
      this,
      id,
      processingClaimId
    );
  }

  async finalizeFiscalCorrection(
    id: string,
    claimId: string,
    outcome: FiscalCorrectionOutcome
  ): Promise<boolean> {
    return finalizeFiscalCorrectionRepository(
      this.db,
      this.auditContext,
      this,
      id,
      claimId,
      outcome
    );
  }

  async claimWompiFiscalCorrectionDocument(input: {
    correctionId: string;
    processingClaimId: string;
    issuanceAttemptId: string;
    documentId: string;
  }): Promise<boolean> {
    return claimWompiFiscalCorrectionDocumentRepository(this.db, input);
  }

  async finalizeWompiFiscalCorrectionFailure(
    id: string,
    claimId: string,
    outcome: Pick<FiscalCorrectionOutcome, "failureCode" | "failureMessage">
  ): Promise<boolean> {
    return finalizeWompiFiscalCorrectionFailureRepository(
      this.db,
      this.auditContext,
      this,
      id,
      claimId,
      outcome
    );
  }

  async listRecoverableFiscalCorrections(
    staleBefore: string,
    limit = 100
  ): Promise<FiscalCorrectionRecord[]> {
    return listRecoverableFiscalCorrectionsRepository(
      this.db,
      staleBefore,
      limit
    );
  }

  async recoverFiscalCorrectionProcessingClaim(input: {
    id: string;
    currentProcessingClaimId: string;
    nextProcessingClaimId: string;
    staleBefore: string;
  }): Promise<FiscalCorrectionRecord | null> {
    return recoverFiscalCorrectionProcessingClaimRepository(
      this.db,
      this.auditContext,
      this,
      input
    );
  }



  async claimWompiEventIssuance(id: string, claimId: string): Promise<boolean> {
    return claimWompiEventIssuanceRepository(this.db, id, claimId);
  }

  async claimCorrectedWompiEventIssuance(input: {
    id: string;
    claimId: string;
    correctionId: string;
    processingClaimId: string;
    issuanceAttemptId: string;
  }): Promise<boolean> {
    return claimCorrectedWompiEventIssuanceRepository(this.db, input);
  }

  async releaseWompiEventIssuance(id: string, claimId: string): Promise<boolean> {
    return releaseWompiEventIssuanceRepository(this.db, id, claimId);
  }

  async listWompiIssuanceFailures(limit = 100): Promise<WompiIssuanceFailureItem[]> {
    return listWompiIssuanceFailuresRepository(this.db, limit);
  }

  async getWompiIssuanceFailureById(wompiEventId: string): Promise<WompiIssuanceFailureItem | null> {
    return getWompiIssuanceFailureByIdRepository(this.db, wompiEventId);
  }

  async getWompiIssuanceRetrySnapshotById(
    wompiEventId: string
  ): Promise<WompiIssuanceRetrySnapshot | null> {
    return getWompiIssuanceRetrySnapshotByIdRepository(this.db, wompiEventId);
  }

  async claimInitialWompiIssuanceAttempt(wompiEventId: string): Promise<string | null> {
    return claimInitialWompiIssuanceAttemptRepository(this.db, wompiEventId);
  }

  async claimWompiIssuanceRetry(
    wompiEventId: string,
    actorId: string,
    observed: WompiIssuanceRetrySnapshot
  ): Promise<string | null> {
    return claimWompiIssuanceRetryRepository(
      this.db,
      this.auditContext,
      wompiEventId,
      actorId,
      observed
    );
  }

  async claimStalledWompiIssuanceAttempt(
    wompiEventId: string,
    currentAttemptId: string | null,
    staleBefore: string
  ): Promise<string | null> {
    return claimStalledWompiIssuanceAttemptRepository(
      this.db,
      wompiEventId,
      currentAttemptId,
      staleBefore
    );
  }

  async createWompiAttemptAudit(input: {
    wompiEventId: string;
    attemptId: string;
    action: string;
    summary: string;
    metadata?: unknown;
  }): Promise<boolean> {
    return createWompiAttemptAuditRepository(this.db, input);
  }

  async reserveWompiDocumentIdentifiers(
    wompiEventId: string,
    environment: Ambiente,
    controlPrefix: string
  ): Promise<WompiDocumentIdentifiers> {
    return reserveWompiDocumentIdentifiersRepository(
      this.db,
      this,
      wompiEventId,
      environment,
      controlPrefix
    );
  }

  async markWompiIssuanceProcessing(
    wompiEventId: string,
    attemptId: string,
    legacyMessage = false
  ): Promise<boolean> {
    return markWompiIssuanceProcessingRepository(
      this.db,
      wompiEventId,
      attemptId,
      legacyMessage
    );
  }

  async recordWompiIssuanceFailure(
    wompiEventId: string,
    attemptId: string,
    evidence: { code: string; message: string }
  ): Promise<boolean> {
    return recordWompiIssuanceFailureRepository(
      this.db,
      wompiEventId,
      attemptId,
      evidence
    );
  }

  async markWompiIssuanceDeadLettered(
    wompiEventId: string,
    attemptId: string,
    legacyMessage = false
  ): Promise<boolean> {
    return markWompiIssuanceDeadLetteredRepository(
      this.db,
      wompiEventId,
      attemptId,
      legacyMessage
    );
  }

  async markWompiIssuanceIgnored(wompiEventId: string): Promise<void> {
    return markWompiIssuanceIgnoredRepository(this.db, wompiEventId);
  }

  async createDonationIntent(input: CreateDonationIntentInput): Promise<DonationIntentRecord> {
    return createDonationIntentRepository(this.db, this, input);
  }

  async getDonationIntent(id: string): Promise<DonationIntentRecord | null> {
    return getDonationIntentRepository(this.db, id);
  }

  async attachIntentLink(id: string, link: WompiPaymentLink): Promise<void> {
    return attachIntentLinkRepository(this.db, id, link);
  }

  async applyIntentDatosWithCapability(
    id: string,
    datosTokenHash: string,
    data: IntentDatosInput
  ): Promise<{ id: string; urlEnlace: string; urlEnlaceLargo: string } | null> {
    return applyIntentDatosWithCapabilityRepository(this.db, id, datosTokenHash, data);
  }

  async markIntentCompleted(id: string, documentId: string): Promise<boolean> {
    return markIntentCompletedRepository(this.db, id, documentId);
  }

  async completeIntentForPostAcceptOwner(
    id: string,
    documentId: string,
    claimId: string
  ): Promise<boolean> {
    return completeIntentForPostAcceptOwnerRepository(this.db, id, documentId, claimId);
  }

  async markIntentPaid(
    id: string,
    expectedLinkId: number,
    donorPhone: string | null = null,
    direccionComplemento: string | null = null
  ): Promise<void> {
    return markIntentPaidRepository(this.db, id, expectedLinkId, donorPhone, direccionComplemento);
  }

  async listIntentsForWompiReconciliation(
    createdAfter: string,
    checkedBefore: string,
    limit = DONATION_INTENT_RECONCILIATION_SWEEP_LIMIT
  ): Promise<Array<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type" | "updated_at">>> {
    return listIntentsForWompiReconciliationRepository(
      this.db,
      createdAfter,
      checkedBefore,
      limit
    );
  }

  async touchIntentWompiReconciliationCheck(
    id: string,
    expectedLinkId: number,
    observedUpdatedAt: string,
    checkedAt: string
  ): Promise<boolean> {
    return touchIntentWompiReconciliationCheckRepository(
      this.db,
      id,
      expectedLinkId,
      observedUpdatedAt,
      checkedAt
    );
  }

  async listIntentsExpiringBefore(
    nowIso: string,
    limit = DONATION_INTENT_EXPIRY_SWEEP_LIMIT
  ): Promise<Array<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type">>> {
    return listIntentsExpiringBeforeRepository(this.db, nowIso, limit);
  }

  async expireDonationIntentsByIds(ids: string[], updatedAt: string): Promise<void> {
    return expireDonationIntentsByIdsRepository(this.db, ids, updatedAt);
  }

  async listRecentDonationIntents(
    limit = 50
  ): Promise<DonationIntentListItem[]> {
    return listRecentDonationIntentsRepository(this.db, limit);
  }

  async getCompletedIntentForDocument(documentId: string): Promise<{ id: string } | null> {
    return getCompletedIntentForDocumentRepository(this.db, documentId);
  }

  async hasAuditAction(action: string, entityType: string, entityId: string): Promise<boolean> {
    return hasAuditActionRepository(this.db, action, entityType, entityId);
  }

  async nextControlSequence(environment: Ambiente, controlPrefix: string): Promise<number> {
    return nextControlSequenceRepository(this.db, environment, controlPrefix);
  }

  async createDteDocument(input: {
    wompiEventId?: string | null;
    environment: Ambiente;
    codigoGeneracion: string;
    numeroControl: string;
    plainJson: Record<string, unknown>;
    donorEmail: string | null;
    donorName: string | null;
    amountCents: number;
    issuedAt: string;
    status?: string;
    contingencyPeriodId?: string | null;
  }): Promise<DteDocumentRecord> {
    return createDteDocumentRepository(this.db, this as unknown as DteDocumentHost, input);
  }

  async createClaimedWompiDteDocument(input: {
    wompiEventId: string;
    issuanceClaimId: string;
    environment: Ambiente;
    codigoGeneracion: string;
    numeroControl: string;
    plainJson: Record<string, unknown>;
    donorEmail: string | null;
    donorName: string | null;
    amountCents: number;
    issuedAt: string;
  }): Promise<DteDocumentRecord | null> {
    return createClaimedWompiDteDocumentRepository(
      this.db,
      this as unknown as DteDocumentHost,
      input
    );
  }

  async markWompiDocumentCreated(wompiEventId: string, documentId: string): Promise<void> {
    return markWompiDocumentCreatedRepository(this.db, wompiEventId, documentId);
  }

  async markWompiEventProcessed(id: string): Promise<void> {
    return markWompiEventProcessedRepository(this.db, id);
  }

  async quarantineWompiIntentBinding(input: {
    wompiEventId: string;
    intentId: string;
    reason: string;
    expectedLinkId: number | null;
    payloadLinkId: number | null;
  }): Promise<void> {
    return quarantineWompiIntentBindingRepository(this.db, input);
  }

  async getDteDocument(id: string): Promise<DteDocumentRecord | null> {
    return getDteDocumentRepository(this.db, id);
  }

  async getDteDocumentByWompiEvent(id: string): Promise<DteDocumentRecord | null> {
    return getDteDocumentByWompiEventRepository(this.db, id);
  }

  async getLatestReceiptEmailDelivery(documentId: string): Promise<ReceiptEmailDeliveryState | null> {
    return getLatestReceiptEmailDeliveryRepository(this.db, documentId);
  }

  async getFailedWompiFiscalCorrectionForDocument(
    documentId: string
  ): Promise<FailedWompiFiscalCorrectionSummary | null> {
    return getFailedWompiFiscalCorrectionForDocumentRepository(this.db, documentId);
  }

  async listDteDocuments(params: {
    status?: string | null;
    attention?: "failures" | null;
    q?: string | null;
    limit?: number;
    cursor?: string | null;
  } = {}): Promise<DteDocumentListPage> {
    return listDteDocumentsRepository(this.db, params);
  }

  async listDonors(filters: DonorExplorerFilters): Promise<DonorExplorerPage> {
    return listDonorsRepository(this.db, filters);
  }

  // Earliest issued document's created_at, used by the backups panel to bound the
  // expected month range when the archive predates (or is emptier than) the DB.
  // Returns null when there are no documents at all.
  async earliestDteDocumentCreatedAt(): Promise<string | null> {
    return earliestDteDocumentCreatedAtRepository(this.db);
  }

  async listAcceptedDteDocumentsForExport(): Promise<DteDocumentRecord[]> {
    return listAcceptedDteDocumentsForExportRepository(this.db);
  }

  async listAcceptedDocumentsInYear(
    range: { startIso: string; endIso: string },
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<DteDocumentRecord[]> {
    return listAcceptedDocumentsInYearRepository(this.db, range, cursor, limit);
  }

  async listAcceptedWompiContactRows(
    environment: Ambiente,
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE,
    window?: { startIso: string; endIso: string }
  ): Promise<ContactSourceRow[]> {
    return listAcceptedWompiContactRowsRepository(
      this.db,
      environment,
      cursor,
      limit,
      window
    );
  }

  // ----- Analítica (carril Wompi) -----
  //
  // Lectores paginados por keyset (mismo estilo que aggregateAnnualDonors) que
  // alimentan las funciones puras de src/worker/services/analytics.ts. TODOS filtran
  // por environment y por el rango [startIso, endIso), y el carril Wompi se restringe
  // con wompi_event_id IS NOT NULL: los CDE emitidos a mano (rápido/avanzado) quedan
  // fuera POR DISEÑO porque nunca llevan wompi_event_id.

  // Documentos del carril Wompi emitidos en el rango, con la geografía y el tipo de
  // regalo del intent correlacionado (LEFT JOIN por document_id) proyectados a cada
  // fila para que la función pura no tenga que unir en memoria. Filtra por issued_at
  // y pagina por (issued_at, id).
  async listWompiLaneDocumentsForAnalytics(
    range: { startIso: string; endIso: string },
    environment: Ambiente,
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<
    Array<
      Pick<
        DteDocumentRecord,
        "id" | "wompi_event_id" | "environment" | "status" | "donor_email" | "donor_name" | "amount_cents" | "issued_at" | "accepted_at" | "transmission_deferred_at"
      > & { direccion_departamento: string | null; donor_pais: string | null; gift_type: string | null }
    >
  > {
    return listWompiLaneDocumentsForAnalyticsRepository(this.db, range, environment, cursor, limit);
  }

  // Intents del carril Wompi creados en el rango, correlacionados a su ambiente vía el
  // documento emitido (intents COMPLETED) o, para los no completados, por el ambiente
  // activo (los intents no guardan environment). Aquí filtramos por environment del
  // documento cuando existe; los intents sin documento se atribuyen a `environment`
  // pasado por el endpoint (el ambiente activo de emisión). Pagina por (created_at, id).
  async listDonationIntentsForAnalytics(
    range: { startIso: string; endIso: string },
    environment: Ambiente,
    cursor: { createdAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<
    Array<
      Pick<DonationIntentRecord, "id" | "status" | "document_id" | "donor_document" | "gift_type" | "created_at" | "paid_at"> & { direccion_departamento: string | null; donor_pais: string | null }
    >
  > {
    return listDonationIntentsForAnalyticsRepository(this.db, range, environment, cursor, limit);
  }

  // Entregas de correo del carril Wompi en el rango: solo las adjuntas a documentos con
  // wompi_event_id en el ambiente pedido. Pagina por (created_at, id).
  async listEmailDeliveriesForAnalytics(
    range: { startIso: string; endIso: string },
    environment: Ambiente,
    cursor: { createdAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<{ id: string; document_id: string; status: string; created_at: string }>> {
    return listEmailDeliveriesForAnalyticsRepository(this.db, range, environment, cursor, limit);
  }

  async updateDocumentSigned(id: string, signedJws: string, expectedStatus: string): Promise<boolean> {
    return updateDocumentSignedRepository(this.db, id, signedJws, expectedStatus);
  }

  async updateClaimedDocumentSigned(
    id: string,
    signedJws: string,
    expectedStatus: string,
    claimId: string
  ): Promise<boolean> {
    return updateClaimedDocumentSignedRepository(
      this.db,
      id,
      signedJws,
      expectedStatus,
      claimId
    );
  }

  async claimDocumentTransmission(id: string, expectedStatus: string, signedJws: string, claimId: string): Promise<boolean> {
    return claimDocumentTransmissionRepository(
      this.db,
      id,
      expectedStatus,
      signedJws,
      claimId
    );
  }

  async claimDocumentInvalidation(id: string, claimId: string): Promise<boolean> {
    return claimDocumentInvalidationRepository(this.db, id, claimId);
  }

  async createAndAttachDocumentInvalidationEvent(input: {
    documentId: string;
    claimId: string;
    environment: Ambiente;
    codigoGeneracion: string;
    plainJson: Record<string, unknown>;
    signedJws: string;
    legalDeadlineAt: string;
    createdBy: string;
  }): Promise<string> {
    return createAndAttachDocumentInvalidationEventRepository(this.db, input);
  }

  async releaseDocumentInvalidationBeforeDispatch(
    documentId: string,
    claimId: string,
    eventId: string,
    reason: string
  ): Promise<boolean> {
    return releaseDocumentInvalidationBeforeDispatchRepository(
      this.db,
      documentId,
      claimId,
      eventId,
      reason
    );
  }

  async completeDocumentInvalidation(input: {
    documentId: string;
    claimId: string;
    eventId: string;
    accepted: boolean;
    sello: string | null;
    mhEstado: string;
    observaciones: string[];
    acceptedAt: string | null;
    actorId: string;
    raw: unknown;
  }): Promise<boolean> {
    return completeDocumentInvalidationRepository(this.db, input);
  }

  async completeDocumentTransmission(
    id: string,
    claimId: string,
    result: { status: "ACCEPTED" | "REJECTED"; sello: string | null; mhEstado: string; observaciones: string[]; acceptedAt: string | null }
  ): Promise<boolean> {
    return completeDocumentTransmissionRepository(this.db, id, claimId, result);
  }

  async markDocumentFailed(
    id: string,
    claimId: string | null,
    result: { mhEstado: string; observaciones: string[] }
  ): Promise<boolean> {
    return markDocumentFailedRepository(this.db, id, claimId, result);
  }

  async releaseDocumentFiscalOperation(id: string, claimId: string): Promise<boolean> {
    return releaseDocumentFiscalOperationRepository(this.db, id, claimId);
  }

  async markDocumentTransmissionDeferred(id: string, claimId: string, reason: string): Promise<boolean> {
    return markDocumentTransmissionDeferredRepository(this.db, id, claimId, reason);
  }

  async listDeferredTransmissionDocuments(limit = 100): Promise<DteDocumentRecord[]> {
    return listDeferredTransmissionDocumentsRepository(this.db, limit);
  }

  async listAcceptedWompiDocumentsMissingFinalization(limit = 100): Promise<DteDocumentRecord[]> {
    return listAcceptedWompiDocumentsMissingFinalizationRepository(this.db, limit);
  }

  async listPendingPostAcceptFinalizations(limit = 100): Promise<DteDocumentRecord[]> {
    return listPendingPostAcceptFinalizationsRepository(this.db, limit);
  }

  async claimDocumentPostAcceptFinalization(id: string, claimId: string): Promise<boolean> {
    return claimDocumentPostAcceptFinalizationRepository(this.db, id, claimId);
  }

  async markDocumentPostAcceptEmailDispatchStarted(id: string, claimId: string): Promise<boolean> {
    return markDocumentPostAcceptEmailDispatchStartedRepository(this.db, id, claimId);
  }

  async releaseDocumentPostAcceptFinalization(id: string, claimId: string): Promise<boolean> {
    return releaseDocumentPostAcceptFinalizationRepository(this.db, id, claimId);
  }

  async markDocumentPostAcceptFinalized(id: string, claimId: string): Promise<boolean> {
    return markDocumentPostAcceptFinalizedRepository(this.db, id, claimId);
  }

  async hasSentEmail(documentId: string, emailType: string): Promise<boolean> {
    return hasSentEmailRepository(this.db, documentId, emailType);
  }

  async hasHandledEmail(documentId: string, emailType: string, documentStatusAtSend: string): Promise<boolean> {
    return hasHandledEmailRepository(this.db, documentId, emailType, documentStatusAtSend);
  }

  async updateDocumentDonorEmail(id: string, email: string): Promise<boolean> {
    void this.indexDteDocumentById;
    return updateDocumentDonorEmailRepository(
      this.db,
      this as unknown as DteDocumentHost,
      id,
      email
    );
  }

  private async indexDteDocumentById(id: string): Promise<void> {
    void this.indexDteDocument;
    return indexDteDocumentByIdRepository(this as unknown as DteDocumentHost, id);
  }

  private async indexDteDocument(record: DteDocumentRecord): Promise<void> {
    return indexDteDocumentRepository(this.db, record);
  }
  async createAudit(input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
    // Explicit overrides win over the request-scoped context injected at construction;
    // callers rarely need them since handleApi/webhook inject the context once.
    actorIp?: string | null;
    actorContext?: unknown;
    rateLimitClaimId?: string | null;
  }): Promise<void> {
    return createAuditRepository(this.db, this.auditContext, input);
  }

  async ensurePostAcceptAudit(input: {
    auditId: string;
    documentId: string;
    claimId: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
  }): Promise<boolean> {
    return ensurePostAcceptAuditRepository(
      this.db,
      this.auditContext,
      input
    );
  }

  async createAuditIfAbsent(input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
    actorIp?: string | null;
    actorContext?: unknown;
  }): Promise<boolean> {
    return createAuditIfAbsentRepository(
      this.db,
      this.auditContext,
      input
    );
  }

  async listAudit(entityType?: string, entityId?: string): Promise<Array<Record<string, unknown>>> {
    return listAuditRepository(this.db, entityType, entityId);
  }

  async listAuditPage(cursor: { createdAt: string; id: string } | null, limit: number): Promise<Array<Record<string, unknown>>> {
    return listAuditPageRepository(this.db, cursor, limit);
  }

  // Lectura histórica: la emisión en contingencia se eliminó (el Anexo del evento
  // de contingencia, campo 35, excluye el tipo 15/CDE), y la migración 0014 cierra
  // los periodos que quedaron abiertos — esto existe para la vista de historial.
  async getOpenContingency(environment?: Ambiente): Promise<Record<string, unknown> | null> {
    return getOpenContingencyRepository(this.db, environment);
  }

  async listContingencyPeriods(limit = 20): Promise<Array<Record<string, unknown>>> {
    return listContingencyPeriodsRepository(this.db, limit);
  }

  async listContingencyDocuments(periodId: string): Promise<DteDocumentRecord[]> {
    return listContingencyDocumentsRepository(this.db, periodId);
  }

  async listContingencyBatches(periodId?: string): Promise<ContingencyBatchRecord[]> {
    return listContingencyBatchesRepository(this.db, periodId);
  }

  async listContingencyBatchLines(input: { periodId?: string; batchId?: string } = {}): Promise<ContingencyBatchLineRecord[]> {
    return listContingencyBatchLinesRepository(this.db, input);
  }

  async listDteEventsByType(eventType: "INVALIDACION" | "CONTINGENCIA", limit = 20): Promise<Array<Record<string, unknown>>> {
    return listDteEventsByTypeRepository(this.db, eventType, limit);
  }

  async recordEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    status: "SENT" | "FAILED";
    providerResponse?: unknown;
    emailType?: string | null;
    documentStatusAtSend?: string | null;
    templateVersion?: string | null;
    pdfRendererVersion?: string | null;
    pdfSha256?: string | null;
    dteJsonSha256?: string | null;
    providerDeliveryId?: string | null;
  }): Promise<void> {
    return recordEmailDeliveryRepository(this.db, input);
  }

  // Claim one receipt type before contacting the external provider. A current
  // PENDING claim and SENT evidence both block a competing delivery. Only a FAILED
  // outcome explicitly proven retry-safe, or a stale pre-dispatch PENDING claim,
  // reuses the same row and provider identity. Legacy and post-dispatch PENDING rows
  // remain blocked for manual review because provider acceptance is unknown.
  async claimEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    emailType: string;
    documentStatusAtSend: string;
  }): Promise<{ id: string; idempotencyKey: string; claimToken: string } | null> {
    return claimEmailDeliveryRepository(this.db, input);
  }

  // One resendRequestId represents one deliberate operator action. Repeated HTTP
  // requests reuse its row and provider identity; a new operator action uses a new
  // request ID. Only proven NOT_SENT failures or stale pre-dispatch work can reclaim
  // the row. SENT is a successful duplicate, while ambiguous work requires review.
  async claimManualEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    emailType: string;
    documentStatusAtSend: string;
    resendRequestId: string;
  }): Promise<ManualEmailDeliveryClaim> {
    return claimManualEmailDeliveryRepository(this.db, input);
  }

  async markEmailDeliveryDispatchStarted(id: string, claimToken: string): Promise<boolean> {
    return markEmailDeliveryDispatchStartedRepository(this.db, id, claimToken);
  }

  // Finalize the exact PENDING row won above. This deliberately updates instead of
  // appending a second delivery row, keeping the claim and its outcome one evidence
  // record even when the provider fails.
  async finalizeEmailDeliveryClaim(
    id: string,
    claimToken: string,
    input: {
      status: "SENT" | "FAILED";
      providerResponse?: unknown;
      emailType: string;
      documentStatusAtSend: string;
      templateVersion?: string | null;
      pdfRendererVersion?: string | null;
      pdfSha256?: string | null;
      dteJsonSha256?: string | null;
      providerDeliveryId?: string | null;
      outcomeClass?: EmailDeliveryOutcomeClass | null;
      failureCode?: string | null;
      retrySafe?: boolean;
    }
  ): Promise<void> {
    return finalizeEmailDeliveryClaimRepository(this.db, id, claimToken, input);
  }

  // Rol del usuario objetivo para los guards de gestión de usuarios (un ADMIN nunca
  // toca a un OWNER). Null cuando el usuario no existe.
  async getUserRole(id: string): Promise<string | null> {
    return getUserRoleRepository(this.db, id);
  }

  async listUsers(): Promise<Array<Record<string, unknown>>> {
    return listUsersRepository(this.db);
  }

  async countUsers(): Promise<number> {
    return countUsersRepository(this.db);
  }

  async createInitialOwner(input: { email: string; name: string; passwordHash: string; passwordSalt: string }): Promise<Record<string, unknown> | null> {
    return createInitialOwnerRepository(this.db, input);
  }

  async createUser(input: { email: string; name: string; role: string; passwordHash: string; passwordSalt: string }): Promise<Record<string, unknown>> {
    return createUserRepository(this.db, input);
  }

  async getUserForLogin(email: string): Promise<Record<string, string> | null> {
    return getUserForLoginRepository(this.db, email);
  }

  async claimDonationIntentRateLimit(
    keyHash: string,
    clientIp: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    limit: number
  ): Promise<string | null> {
    return claimDonationIntentRateLimitRepository(
      this.db,
      keyHash,
      clientIp,
      now,
      cutoff,
      expiresAt,
      limit
    );
  }

  async claimDonationDatosRateLimit(
    keyHash: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    limit: number
  ): Promise<string | null> {
    return claimDonationDatosRateLimitRepository(
      this.db,
      keyHash,
      now,
      cutoff,
      expiresAt,
      limit
    );
  }

  async claimPasswordResetBudgets(
    pairKeyHash: string,
    accountKeyHash: string,
    accountId: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    pairLimit: number,
    accountLimit: number
  ): Promise<string | null> {
    return claimPasswordResetBudgetsRepository(
      this.db,
      pairKeyHash,
      accountKeyHash,
      accountId,
      now,
      cutoff,
      expiresAt,
      pairLimit,
      accountLimit
    );
  }

  async claimLoginAttempt(
    keyHash: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    limit: number
  ): Promise<boolean> {
    return claimLoginAttemptRepository(
      this.db,
      keyHash,
      now,
      cutoff,
      expiresAt,
      limit
    );
  }

  async deleteExpiredLoginRateLimits(now: string): Promise<void> {
    return deleteExpiredLoginRateLimitsRepository(this.db, now);
  }

  async deleteExpiredSecurityRateLimitClaims(now: string): Promise<void> {
    return deleteExpiredSecurityRateLimitClaimsRepository(this.db, now);
  }

  async createSessionIfCredentialsCurrent(input: {
    userId: string;
    expectedPasswordHash: string;
    expectedPasswordSalt: string;
    expectedEmail: string;
    expectedAuthGeneration: number;
    tokenHash: string;
    expiresAt: string;
  }): Promise<boolean> {
    return createSessionIfCredentialsCurrentRepository(this.db, input);
  }

  async getSessionUser(tokenHash: string): Promise<Record<string, string> | null> {
    return getSessionUserRepository(this.db, tokenHash);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    return revokeSessionRepository(this.db, tokenHash);
  }

  async updateUser(
    id: string,
    input: { role?: string; disabled?: boolean; name?: string; email?: string },
    allowOwnerTarget = false
  ): Promise<Record<string, unknown>> {
    return updateUserRepository(this.db, this, id, input, allowOwnerTarget);
  }

  async listStalledApprovedWompiEvents(cutoffIso: string): Promise<Array<Record<string, unknown>>> {
    return listStalledApprovedWompiEventsRepository(this.db, cutoffIso);
  }

  async countAuditEntries(action: string, entityId: string): Promise<number> {
    return countAuditEntriesRepository(this.db, action, entityId);
  }

  async claimOperationalAlertDelivery(input: {
    kind: string;
    entityType: string;
    entityId: string;
    incidentId: string;
    channel: "email";
    targetKey: string;
  }): Promise<OperationalAlertDeliveryClaim> {
    return claimOperationalAlertDeliveryRepository(this.db, input);
  }

  async markOperationalAlertDispatchStarted(
    id: string,
    claimToken: string
  ): Promise<boolean> {
    return markOperationalAlertDispatchStartedRepository(this.db, id, claimToken);
  }

  async finalizeOperationalAlertDelivery(
    id: string,
    claimToken: string,
    input: {
      status: "SENT" | "FAILED";
      outcomeClass?: EmailDeliveryOutcomeClass | null;
      failureCode?: string | null;
      retrySafe?: boolean;
    }
  ): Promise<void> {
    return finalizeOperationalAlertDeliveryRepository(this.db, id, claimToken, input);
  }

  async countAuditEntriesSince(action: string, entityId: string, sinceIso: string): Promise<number> {
    return countAuditEntriesSinceRepository(this.db, action, entityId, sinceIso);
  }

  async countAuditEntriesSinceForIp(action: string, entityId: string, actorIp: string | null, sinceIso: string): Promise<number> {
    return countAuditEntriesSinceForIpRepository(
      this.db,
      action,
      entityId,
      actorIp,
      sinceIso
    );
  }

  async listRowsCreatedBetween(
    table: RetentionTable,
    range: { startIso: string; endIso: string },
    cursor: RetentionCursor | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<Record<string, unknown>>> {
    return listRowsCreatedBetweenRepository(this.db, table, range, cursor, limit);
  }

  async listAllRowsPaged(table: RetentionSnapshotTable, cursor: RetentionCursor | null, limit = RETENTION_PAGE_SIZE): Promise<Array<Record<string, unknown>>> {
    return listAllRowsPagedRepository(this.db, table, cursor, limit);
  }

  async listDocumentSequencesPaged(
    cursor: DocumentSequenceRetentionCursor | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<Record<string, unknown>>> {
    return listDocumentSequencesPagedRepository(this.db, cursor, limit);
  }

  async createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
    expectedEmail: string,
    expectedAuthGeneration: number,
    expectedPasswordHash: string,
    expectedPasswordSalt: string
  ): Promise<string | null> {
    return createPasswordResetTokenRepository(
      this.db,
      userId,
      tokenHash,
      expiresAt,
      expectedEmail,
      expectedAuthGeneration,
      expectedPasswordHash,
      expectedPasswordSalt
    );
  }

  async invalidatePasswordResetToken(id: string): Promise<void> {
    return invalidatePasswordResetTokenRepository(this.db, id);
  }

  async getActivePasswordResetUser(tokenHash: string): Promise<Record<string, string> | null> {
    return getActivePasswordResetUserRepository(this.db, tokenHash);
  }

  async resetPasswordWithToken(
    userId: string,
    tokenHash: string,
    passwordHash: string,
    passwordSalt: string
  ): Promise<boolean> {
    return resetPasswordWithTokenRepository(
      this.db,
      userId,
      tokenHash,
      passwordHash,
      passwordSalt
    );
  }

  async setUserPassword(
    userId: string,
    passwordHash: string,
    passwordSalt: string,
    allowOwnerTarget = false
  ): Promise<boolean> {
    return setUserPasswordRepository(
      this.db,
      this,
      userId,
      passwordHash,
      passwordSalt,
      allowOwnerTarget
    );
  }

  // Opportunistic PBKDF2 rehash on successful login. Unlike setUserPassword this does
  // NOT revoke sessions — the credential is unchanged, only its stored encoding. The
  // update is compare-and-swap guarded so a stale login cannot overwrite a concurrent
  // password reset/change that landed after verification.
  async updateUserPasswordHashIfCurrent(
    userId: string,
    currentPasswordHash: string,
    currentPasswordSalt: string,
    passwordHash: string,
    passwordSalt: string
  ): Promise<boolean> {
    return updateUserPasswordHashIfCurrentRepository(
      this.db,
      userId,
      currentPasswordHash,
      currentPasswordSalt,
      passwordHash,
      passwordSalt
    );
  }
}
