/**
 * Explicitly trusted projection for evidence shown to issuance operators.
 *
 * Callers must supply fixed, developer-authored text only. Raw exception messages,
 * provider bodies, URLs, credentials, and donor/payment values must never be copied
 * into this type.
 */
export class OperatorSafeIssuanceError extends Error {
  readonly evidenceCode: string;
  readonly evidenceMessage: string;

  constructor(evidenceCode: string, evidenceMessage: string) {
    super(evidenceMessage);
    this.name = "OperatorSafeIssuanceError";
    this.evidenceCode = evidenceCode;
    this.evidenceMessage = evidenceMessage;
  }
}
