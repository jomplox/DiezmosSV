// Type declarations for d1-migration-preflight.mjs so typechecked tests can
// import the module without allowJs.
export const DUPLICATE_WOMPI_EVENT_IDS_QUERY: string;
export const DTE_DOCUMENTS_TABLE_QUERY: string;
export const D1_MIGRATIONS_TABLE_QUERY: string;
export const EMAIL_DELIVERIES_TABLE_QUERY: string;
export const EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY: string;
export const MIGRATION_0004_LEDGER_QUERY: string;

export interface DuplicateWompiEventId {
  wompiEventId: string;
  documentCount: number;
}

export function parseDuplicateWompiEventIds(stdout: unknown): DuplicateWompiEventId[];

export function hasDteDocumentsTable(stdout: unknown): boolean;

export function hasD1MigrationsTable(stdout: unknown): boolean;

export function hasEmailDeliveriesTable(stdout: unknown): boolean;

export function isMigration0004Recorded(stdout: unknown): boolean;

export function parseEmailDeliveryEvidenceColumns(stdout: unknown): string[];

export function parsePopulatedEmailDeliveryEvidenceCount(stdout: unknown): number;

export type EmailDeliveryEvidenceState = {
  state:
    | "fresh"
    | "legacy-pending"
    | "recorded"
    | "pending-unpopulated"
    | "blocked";
  evidenceColumns: string[];
  populatedEvidenceCount: number | null;
};

export function classifyEmailDeliveryEvidenceState(input: {
  migration0004Recorded: boolean;
  emailDeliveriesExists: boolean;
  evidenceColumns: string[];
  populatedEvidenceCount: number | null;
}): EmailDeliveryEvidenceState;

export function inspectEmailDeliveryEvidenceMigration(
  executeQuery: (query: string) => string
): EmailDeliveryEvidenceState;

export function assertEmailDeliveryEvidenceMigrationSafe(
  state: EmailDeliveryEvidenceState
): void;

export function runPreflightChecks(
  executeQuery: (query: string) => string
): { dteDocumentsTableExists: boolean };

export function assertNoDuplicateWompiEventIds(duplicates: DuplicateWompiEventId[]): void;
