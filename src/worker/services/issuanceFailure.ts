const DEFAULT_CODE = "ISSUANCE_ERROR";
const DEFAULT_MESSAGE = "Fallo de emisión sin detalle";
const SAFE_CODE = /^[A-Z0-9_:-]{1,64}$/;
const MAX_MESSAGE_LENGTH = 1000;

export interface IssuanceFailureEvidence {
  code: string;
  message: string;
}

export function issuanceFailureEvidence(error: unknown): IssuanceFailureEvidence {
  if (!(error instanceof Error)) {
    return { code: DEFAULT_CODE, message: DEFAULT_MESSAGE };
  }

  const candidateCode = (error as Error & { code?: unknown }).code;
  const code = typeof candidateCode === "string" && SAFE_CODE.test(candidateCode)
    ? candidateCode
    : DEFAULT_CODE;
  const message = error.message.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);

  return { code, message: message || DEFAULT_MESSAGE };
}
