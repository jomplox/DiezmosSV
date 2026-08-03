// Type declarations for d1-migration-preflight.mjs so typechecked tests can
// import the module without allowJs.
export const DUPLICATE_WOMPI_EVENT_IDS_QUERY: string;
export const DTE_DOCUMENTS_TABLE_QUERY: string;

export interface DuplicateWompiEventId {
  wompiEventId: string;
  documentCount: number;
}

export function parseDuplicateWompiEventIds(stdout: unknown): DuplicateWompiEventId[];

export function hasDteDocumentsTable(stdout: unknown): boolean;

export function assertNoDuplicateWompiEventIds(duplicates: DuplicateWompiEventId[]): void;
