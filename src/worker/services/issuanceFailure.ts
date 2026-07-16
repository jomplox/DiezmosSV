const DEFAULT_CODE = "ISSUANCE_ERROR";
const DEFAULT_MESSAGE = "Fallo de emisión sin detalle";
const SAFE_CODE = /^[A-Z0-9_:-]{1,64}$/;
const MAX_MESSAGE_LENGTH = 1000;

export interface IssuanceFailureEvidence {
  code: string;
  message: string;
}

export function issuanceFailureEvidence(error: unknown): IssuanceFailureEvidence {
  if (!(error instanceof OperatorSafeIssuanceError)) {
    return { code: DEFAULT_CODE, message: DEFAULT_MESSAGE };
  }

  if (!SAFE_CODE.test(error.evidenceCode)) {
    return { code: DEFAULT_CODE, message: DEFAULT_MESSAGE };
  }
  const message = error.evidenceMessage.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);

  return message
    ? { code: error.evidenceCode, message }
    : { code: DEFAULT_CODE, message: DEFAULT_MESSAGE };
}
import { OperatorSafeIssuanceError } from "../domain/operatorSafeIssuanceError";

export { OperatorSafeIssuanceError } from "../domain/operatorSafeIssuanceError";
