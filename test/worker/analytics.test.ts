import { describe, expect, it } from "vitest";
import {
  buildAnalytics,
  elSalvadorDayKey,
  elSalvadorMonthKey,
  elSalvadorWeekKey,
  elSalvadorHourOfWeek,
  type AnalyticsDocumentRow,
  type AnalyticsIntentRow,
  type AnalyticsEmailRow,
  type AnalyticsRange
} from "../../src/worker/services/analytics";

// A fixed reference "now" so run-rate / lapsed windows are deterministic.
const NOW = new Date("2026-07-06T12:00:00.000Z");

function doc(overrides: Partial<AnalyticsDocumentRow>): AnalyticsDocumentRow {
  // Nullable fields use the `in` check so an explicit `null` override is honored.
  return {
    id: overrides.id ?? "dte_1",
    wompi_event_id: "wompi_event_id" in overrides ? overrides.wompi_event_id! : "wompi_1",
    environment: overrides.environment ?? "01",
    status: overrides.status ?? "ACCEPTED",
    donor_email: "donor_email" in overrides ? overrides.donor_email! : "donor@example.org",
    donor_name: "donor_name" in overrides ? overrides.donor_name! : "Donante Uno",
    amount_cents: overrides.amount_cents ?? 1000,
    issued_at: overrides.issued_at ?? "2026-05-04T18:00:00.000Z",
    accepted_at: "accepted_at" in overrides ? overrides.accepted_at! : "2026-05-04T18:00:30.000Z",
    transmission_deferred_at: "transmission_deferred_at" in overrides ? overrides.transmission_deferred_at! : null,
    direccion_departamento: "direccion_departamento" in overrides ? overrides.direccion_departamento! : "06",
    donor_pais: "donor_pais" in overrides ? overrides.donor_pais! : null,
    gift_type: "gift_type" in overrides ? overrides.gift_type! : "DIEZMO"
  };
}

function intent(overrides: Partial<AnalyticsIntentRow>): AnalyticsIntentRow {
  // Nullable fields use the `in` check so an explicit `null` override is honored
  // (a `?? default` would silently restore the default on null).
  return {
    id: overrides.id ?? "di_1",
    status: overrides.status ?? "COMPLETED",
    document_id: "document_id" in overrides ? overrides.document_id! : "dte_1",
    donor_document: "donor_document" in overrides ? overrides.donor_document! : "RECIBO-1",
    gift_type: "gift_type" in overrides ? overrides.gift_type! : "DIEZMO",
    created_at: overrides.created_at ?? "2026-05-04T17:50:00.000Z",
    paid_at: "paid_at" in overrides ? overrides.paid_at! : "2026-05-04T17:55:00.000Z"
  };
}

const FULL_RANGE: AnalyticsRange = { from: "2020-01-01", to: "2030-12-31" };

describe("El Salvador bucketing helpers (fixed UTC-6)", () => {
  it("assigns an instant to the El Salvador local calendar month", () => {
    // 2026-05-01T05:00Z is 2026-04-30 23:00 in El Salvador (UTC-6) -> April.
    expect(elSalvadorMonthKey("2026-05-01T05:00:00.000Z")).toBe("2026-04");
    // 2026-05-01T06:00Z is 2026-05-01 00:00 local -> May.
    expect(elSalvadorMonthKey("2026-05-01T06:00:00.000Z")).toBe("2026-05");
  });

  it("assigns an instant to the El Salvador local day", () => {
    expect(elSalvadorDayKey("2026-05-01T05:00:00.000Z")).toBe("2026-04-30");
    expect(elSalvadorDayKey("2026-05-01T06:00:00.000Z")).toBe("2026-05-01");
  });

  it("keys weeks to the Monday of the El Salvador local week", () => {
    // 2026-07-06 is a Monday in El Salvador local time.
    expect(elSalvadorWeekKey("2026-07-06T18:00:00.000Z")).toBe("2026-07-06");
    // 2026-07-08 (Wed) still keys to Monday 2026-07-06.
    expect(elSalvadorWeekKey("2026-07-08T18:00:00.000Z")).toBe("2026-07-06");
    // 2026-07-05 (Sun) keys to the prior Monday 2026-06-29.
    expect(elSalvadorWeekKey("2026-07-05T18:00:00.000Z")).toBe("2026-06-29");
  });

  it("computes day-of-week (0=Mon..6=Sun) and hour in El Salvador local time", () => {
    // Monday 12:00 local == 18:00Z.
    expect(elSalvadorHourOfWeek("2026-07-06T18:00:00.000Z")).toEqual({ day: 0, hour: 12 });
    // Sunday 23:00 local == Monday 05:00Z.
    expect(elSalvadorHourOfWeek("2026-07-06T05:00:00.000Z")).toEqual({ day: 6, hour: 23 });
  });
});

describe("buildAnalytics — Wompi-lane scoping", () => {
  it("counts only ACCEPTED documents in giving totals", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", status: "ACCEPTED", amount_cents: 1000, issued_at: "2026-05-04T18:00:00.000Z" }),
        doc({ id: "b", status: "REJECTED", amount_cents: 5000, issued_at: "2026-05-04T18:00:00.000Z" }),
        doc({ id: "c", status: "SIGNED", amount_cents: 9000, issued_at: "2026-05-04T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const may = analytics.giving.monthly.find((point) => point.key === "2026-05");
    expect(may?.totalCents).toBe(1000);
    expect(may?.count).toBe(1);
  });

  it("computes the average gift per month in cents", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", amount_cents: 1000, issued_at: "2026-05-04T18:00:00.000Z" }),
        doc({ id: "b", amount_cents: 3000, issued_at: "2026-05-10T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const may = analytics.giving.monthly.find((point) => point.key === "2026-05");
    expect(may?.averageCents).toBe(2000);
  });
});

describe("buildAnalytics — Diezmo vs Ofrenda split", () => {
  it("splits monthly totals by gift type via the correlated intent", () => {
    const analytics = buildAnalytics({
      documents: [
        // gift_type null on the doc row so the correlated-intent lookup is exercised.
        doc({ id: "dte_d", amount_cents: 1000, issued_at: "2026-05-04T18:00:00.000Z", gift_type: null }),
        doc({ id: "dte_o", amount_cents: 4000, issued_at: "2026-05-06T18:00:00.000Z", gift_type: null })
      ],
      intents: [
        intent({ id: "di_d", document_id: "dte_d", gift_type: "DIEZMO" }),
        intent({ id: "di_o", document_id: "dte_o", gift_type: "OFRENDA" })
      ],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const may = analytics.giving.giftSplit.find((point) => point.key === "2026-05");
    expect(may?.diezmoCents).toBe(1000);
    expect(may?.ofrendaCents).toBe(4000);
  });
});

describe("buildAnalytics — new vs returning donors", () => {
  it("classifies a donor as new on their first-ever gift month and returning thereafter", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", donor_email: "legacy-email-106@example.com", issued_at: "2026-04-04T18:00:00.000Z" }),
        doc({ id: "b", donor_email: "legacy-email-106@example.com", issued_at: "2026-05-04T18:00:00.000Z" }),
        doc({ id: "c", donor_email: "legacy-email-113@example.com", issued_at: "2026-05-06T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const april = analytics.giving.donorMix.find((point) => point.key === "2026-04");
    const may = analytics.giving.donorMix.find((point) => point.key === "2026-05");
    expect(april).toMatchObject({ newDonors: 1, returningDonors: 0 });
    expect(may).toMatchObject({ newDonors: 1, returningDonors: 1 });
  });
});

describe("buildAnalytics — top recurring donors", () => {
  it("ranks donors by count then total and never exposes document numbers", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", donor_email: "legacy-email-103@example.com", donor_name: "Big", amount_cents: 5000, issued_at: "2026-05-01T18:00:00.000Z" }),
        doc({ id: "b", donor_email: "legacy-email-103@example.com", donor_name: "Big", amount_cents: 5000, issued_at: "2026-05-02T18:00:00.000Z" }),
        doc({ id: "c", donor_email: "legacy-email-118@example.com", donor_name: "Small", amount_cents: 9000, issued_at: "2026-05-03T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const top = analytics.giving.topDonors;
    expect(top[0]).toMatchObject({ donorName: "Big", count: 2, totalCents: 10000 });
    expect(top[1]).toMatchObject({ donorName: "Small", count: 1, totalCents: 9000 });
    // No numero_control / codigo_generacion leaks into the donor rows.
    expect(JSON.stringify(top)).not.toContain("numero_control");
  });
});

describe("buildAnalytics — geographic distribution", () => {
  it("buckets domestic donors by CAT-012 department and foreign by donor_pais", () => {
    const analytics = buildAnalytics({
      documents: [
        // Domestic: department 06, no país.
        doc({ id: "a", amount_cents: 1000, issued_at: "2026-05-01T18:00:00.000Z", direccion_departamento: "06", donor_pais: null }),
        // Foreign: department 00 + donor_pais US.
        doc({ id: "b", amount_cents: 2000, issued_at: "2026-05-02T18:00:00.000Z", direccion_departamento: "00", donor_pais: "US" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW,
      labels: { department: (code) => `Dep ${code}`, country: (code) => `País ${code}` }
    });
    const domestic = analytics.geography.departments.find((row) => row.code === "06");
    expect(domestic).toMatchObject({ count: 1, totalCents: 1000, label: "Dep 06" });
    const abroad = analytics.geography.foreign.find((row) => row.code === "US");
    expect(abroad).toMatchObject({ count: 1, totalCents: 2000, label: "País US" });
  });
});

describe("buildAnalytics — conversion funnel", () => {
  it("counts created -> datos -> paid -> completed with drop-off", () => {
    const analytics = buildAnalytics({
      documents: [],
      intents: [
        // created only (no datos, no paid)
        intent({ id: "i1", status: "PENDING", document_id: null, donor_document: "", paid_at: null }),
        // datos attached (donor_document present) but not paid
        intent({ id: "i2", status: "LINK_CREATED", document_id: null, donor_document: "DUI", paid_at: null }),
        // paid but not completed
        intent({ id: "i3", status: "LINK_CREATED", document_id: null, donor_document: "DUI", paid_at: "2026-05-04T18:00:00.000Z" }),
        // completed
        intent({ id: "i4", status: "COMPLETED", donor_document: "DUI", paid_at: "2026-05-04T18:00:00.000Z" })
      ],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const funnel = analytics.funnel;
    expect(funnel.created).toBe(4);
    expect(funnel.datos).toBe(3);
    expect(funnel.paid).toBe(2);
    expect(funnel.completed).toBe(1);
  });

  it("reports median minutes from created to paid", () => {
    const analytics = buildAnalytics({
      documents: [],
      intents: [
        intent({ id: "a", created_at: "2026-05-04T18:00:00.000Z", paid_at: "2026-05-04T18:10:00.000Z" }),
        intent({ id: "b", created_at: "2026-05-04T18:00:00.000Z", paid_at: "2026-05-04T18:20:00.000Z" }),
        intent({ id: "c", created_at: "2026-05-04T18:00:00.000Z", paid_at: "2026-05-04T18:30:00.000Z" })
      ],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    expect(analytics.funnel.medianMinutesToPay).toBe(20);
  });
});

describe("buildAnalytics — MH health", () => {
  it("computes median latency issued->accepted in seconds and weekly rejections", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", status: "ACCEPTED", issued_at: "2026-07-06T18:00:00.000Z", accepted_at: "2026-07-06T18:00:10.000Z" }),
        doc({ id: "b", status: "ACCEPTED", issued_at: "2026-07-06T18:00:00.000Z", accepted_at: "2026-07-06T18:00:30.000Z" }),
        doc({ id: "r", status: "REJECTED", issued_at: "2026-07-06T18:00:00.000Z", accepted_at: null })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    expect(analytics.mhHealth.medianLatencySeconds).toBe(20);
    const week = analytics.mhHealth.weeklyRejections.find((point) => point.key === "2026-07-06");
    expect(week?.count).toBe(1);
  });

  it("counts deferred-transmission incidents over time", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", status: "ACCEPTED", transmission_deferred_at: "2026-07-06T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const week = analytics.mhHealth.weeklyDeferred.find((point) => point.key === "2026-07-06");
    expect(week?.count).toBe(1);
  });
});

describe("buildAnalytics — email deliverability", () => {
  it("counts weekly SENT vs FAILED joined to Wompi-lane documents", () => {
    const analytics = buildAnalytics({
      documents: [doc({ id: "a" })],
      intents: [],
      emails: [
        { document_id: "a", status: "SENT", created_at: "2026-07-06T18:00:00.000Z" },
        { document_id: "a", status: "SENT", created_at: "2026-07-06T19:00:00.000Z" },
        { document_id: "a", status: "FAILED", created_at: "2026-07-06T20:00:00.000Z" }
      ],
      range: FULL_RANGE,
      now: NOW
    });
    const week = analytics.email.weekly.find((point) => point.key === "2026-07-06");
    expect(week).toMatchObject({ sent: 2, failed: 1 });
  });
});

describe("buildAnalytics — lapsed donors", () => {
  it("flags donors who gave in the prior 90 days but not the last 30", () => {
    // now = 2026-07-06. Last-30 window starts 2026-06-06; prior-90 starts 2026-04-07.
    const analytics = buildAnalytics({
      documents: [
        // Lapsed: gave 2026-05-15 (within prior 90, outside last 30), nothing since.
        doc({ id: "a", donor_email: "legacy-email-111@example.com", donor_name: "Lapsed", amount_cents: 5000, issued_at: "2026-05-15T18:00:00.000Z" }),
        // Active: gave inside the last 30 days.
        doc({ id: "b", donor_email: "legacy-email-102@example.com", issued_at: "2026-06-20T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    expect(analytics.lapsed.count).toBe(1);
    expect(analytics.lapsed.donors[0]).toMatchObject({ donorName: "Lapsed", totalCents: 5000 });
  });
});

describe("buildAnalytics — giving heatmap", () => {
  it("bins accepted gifts by El Salvador day-of-week and hour", () => {
    const analytics = buildAnalytics({
      documents: [
        // Monday 12:00 local (18:00Z).
        doc({ id: "a", issued_at: "2026-07-06T18:00:00.000Z" }),
        doc({ id: "b", issued_at: "2026-07-06T18:30:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    const cell = analytics.heatmap.find((row) => row.day === 0 && row.hour === 12);
    expect(cell?.count).toBe(2);
  });
});

describe("buildAnalytics — projection", () => {
  it("exposes a 3-month moving average and a simple projection for the current month", () => {
    const analytics = buildAnalytics({
      documents: [
        doc({ id: "a", amount_cents: 3000, issued_at: "2026-04-10T18:00:00.000Z" }),
        doc({ id: "b", amount_cents: 6000, issued_at: "2026-05-10T18:00:00.000Z" }),
        doc({ id: "c", amount_cents: 9000, issued_at: "2026-06-10T18:00:00.000Z" }),
        // current month (July) partial
        doc({ id: "d", amount_cents: 1000, issued_at: "2026-07-02T18:00:00.000Z" })
      ],
      intents: [],
      emails: [],
      range: FULL_RANGE,
      now: NOW
    });
    // 3-month moving average of Apr/May/Jun = (3000+6000+9000)/3 = 6000.
    expect(analytics.projection.movingAverageCents).toBe(6000);
    // Current-month run rate: 1000 cents over ~5.5 days of July projected to 31 days.
    expect(analytics.projection.currentMonthKey).toBe("2026-07");
    expect(analytics.projection.runRateCents).toBeGreaterThan(1000);
  });
});

describe("buildAnalytics — empty range", () => {
  it("returns zeroed sections with empty series when there is no data", () => {
    const analytics = buildAnalytics({ documents: [], intents: [], emails: [], range: FULL_RANGE, now: NOW });
    expect(analytics.giving.monthly).toEqual([]);
    expect(analytics.giving.topDonors).toEqual([]);
    expect(analytics.funnel.created).toBe(0);
    expect(analytics.hasData).toBe(false);
  });
});
