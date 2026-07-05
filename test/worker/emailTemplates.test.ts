import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "../../src/worker/services/emailTemplates";

describe("email template defaults", () => {
  it("spells out the tax authority in donor-facing defaults", () => {
    const invalidation = EMAIL_TEMPLATE_DEFINITIONS.find((definition) => definition.type === "dteInvalidation");

    expect(invalidation?.defaultBody).toContain("ante el Ministerio de Hacienda");
    expect(invalidation?.defaultBody).not.toContain("ante MH");
  });
});
