import { describe, expect, it } from "vitest";
import { invalidationWindowInfo } from "../../src/client/invalidationWindow";
import type { DteDocument } from "../../src/client/types";
import { makeDocument } from "../worker/fixtures";

describe("invalidation window presentation", () => {
  it("shows the remaining legal window for accepted stamped CDEs", () => {
    const info = invalidationWindowInfo(testDocument(), new Date("2026-06-29T02:59:59.000Z"));

    expect(info.canInvalidate).toBe(true);
    expect(info.deadlineIso).toBe("2026-07-15T05:59:59.000Z");
    expect(info.deadlineLabel).toBe("14/07/2026, 23:59");
    expect(info.remainingLabel).toBe("Quedan 16 días y 3 horas para invalidar este CDE.");
    expect(info.tone).toBe("ok");
  });

  it("marks the window as closed after the legal deadline", () => {
    const info = invalidationWindowInfo(testDocument(), new Date("2026-07-15T06:00:00.000Z"));

    expect(info.canInvalidate).toBe(false);
    expect(info.remainingLabel).toBe("La ventana legal de invalidación ya cerró.");
    expect(info.tone).toBe("expired");
  });

  it("keeps invalidation unavailable until a document is accepted with sello", () => {
    const info = invalidationWindowInfo({ ...testDocument(), status: "PENDING", sello_recibido: null }, new Date("2026-07-13T20:59:59.000Z"));

    expect(info.canInvalidate).toBe(false);
    expect(info.deadlineIso).toBeNull();
    expect(info.remainingLabel).toBe("Disponible cuando el CDE tenga sello recibido.");
    expect(info.tone).toBe("pending");
  });

  it("does not show invalidation-window guidance for already invalidated CDEs", () => {
    const info = invalidationWindowInfo({ ...testDocument(), status: "INVALIDATED" }, new Date("2026-06-29T02:59:59.000Z"));

    expect(info.canInvalidate).toBe(false);
    expect(info.deadlineIso).toBeNull();
    expect(info.title).toBe("CDE invalidado");
    expect(info.remainingLabel).toBe("Este CDE ya fue invalidado ante el Ministerio de Hacienda.");
    expect(info.tone).toBe("pending");
  });
});

function testDocument(): DteDocument {
  return makeDocument({
    id: "doc-1",
    wompi_event_id: "event-1",
    plain_json: "{}",
    donor_email: "donante@example.org",
    donor_name: "Donante",
    amount_cents: 100,
    post_accept_finalized_at: null
  });
}
