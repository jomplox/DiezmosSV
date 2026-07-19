import worker from "../../../src/worker/index";
import type { Env } from "../../../src/worker/types";
import { makeDocument as testDocument } from "../fixtures";
import { InMemoryD1 } from "./inMemoryD1";

export function emailResendDb(): InMemoryD1 {
  const db = new InMemoryD1();
  db.sessionUser = {
    id: "user_operator",
    email: "operator@example.org",
    name: "Operator",
    role: "OPERATOR"
  };
  db.documents.push(testDocument());
  return db;
}

export const TEST_RESEND_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

export function resendDocument(
  runtime: Env,
  resendRequestId = TEST_RESEND_REQUEST_ID
): Promise<Response> {
  return worker.fetch(
    new Request("https://example.org/api/documents/doc_1/resend", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ resendRequestId })
    }),
    runtime
  );
}
