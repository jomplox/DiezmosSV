import { describe, expect, it } from "vitest";
import {
  analyticsRangePresets,
  formatMonthLabel,
  formatWeekLabel,
  monthlyChartModel,
  yoyChartModel,
  filterGiftType,
  heatmapMax,
  funnelStages,
  type ClientAnalytics,
  type GiftTypeFilter
} from "../../src/client/analytics";

describe("month and week labels (usted-form Spanish, El Salvador)", () => {
  it("renders a YYYY-MM key as a Spanish month + year", () => {
    expect(formatMonthLabel("2026-07")).toBe("jul 2026");
    expect(formatMonthLabel("2026-01")).toBe("ene 2026");
  });

  it("renders a Monday week key as a dd/mm label", () => {
    expect(formatWeekLabel("2026-07-06")).toBe("06/07");
  });
});

describe("analyticsRangePresets", () => {
  it("offers the required presets and computes their date bounds", () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const presets = analyticsRangePresets(now);
    const ids = presets.map((preset) => preset.id);
    expect(ids).toEqual(["mes", "trimestre", "anio", "anio_anterior", "personalizado"]);
    const esteMes = presets.find((preset) => preset.id === "mes")!;
    expect(esteMes.from).toBe("2026-07-01");
    expect(esteMes.to).toBe("2026-07-06");
    const anioAnterior = presets.find((preset) => preset.id === "anio_anterior")!;
    expect(anioAnterior.from).toBe("2025-01-01");
    expect(anioAnterior.to).toBe("2025-12-31");
  });
});

describe("monthlyChartModel", () => {
  it("maps a monthly series into normalized bar/point coordinates", () => {
    const model = monthlyChartModel([
      { key: "2026-05", totalCents: 1000, count: 1, averageCents: 1000 },
      { key: "2026-06", totalCents: 3000, count: 2, averageCents: 1500 }
    ]);
    expect(model.points).toHaveLength(2);
    // The max total anchors the vertical scale.
    expect(model.maxCents).toBe(3000);
    // Normalized height in [0,1] for the tallest bar is 1.
    const tallest = model.points.find((point) => point.key === "2026-06")!;
    expect(tallest.ratio).toBeCloseTo(1);
  });

  it("returns an empty model without throwing on no data", () => {
    const model = monthlyChartModel([]);
    expect(model.points).toEqual([]);
    expect(model.maxCents).toBe(0);
  });
});

describe("yoyChartModel", () => {
  it("overlays current vs prior year with a shared scale", () => {
    const model = yoyChartModel([
      { month: "01", currentCents: 1000, priorCents: 500 },
      { month: "02", currentCents: 2000, priorCents: 4000 }
    ]);
    expect(model.maxCents).toBe(4000);
    expect(model.current).toHaveLength(12 > 2 ? 2 : 2);
  });
});

describe("filterGiftType", () => {
  const analytics = {
    giving: {
      monthly: [{ key: "2026-06", totalCents: 5000, count: 2, averageCents: 2500 }],
      giftSplit: [{ key: "2026-06", diezmoCents: 3000, ofrendaCents: 2000, otherCents: 0 }]
    }
  } as unknown as ClientAnalytics;

  it("returns the full monthly series for the Todos filter", () => {
    const series = filterGiftType(analytics, "todos");
    expect(series[0].totalCents).toBe(5000);
  });

  it("returns the diezmo slice of the split for the Diezmo filter", () => {
    const series = filterGiftType(analytics, "diezmo" as GiftTypeFilter);
    expect(series[0].totalCents).toBe(3000);
  });

  it("returns the ofrenda slice for the Ofrenda filter", () => {
    const series = filterGiftType(analytics, "ofrenda" as GiftTypeFilter);
    expect(series[0].totalCents).toBe(2000);
  });
});

describe("funnelStages", () => {
  it("labels each stage in usted-form Spanish with drop-off", () => {
    const stages = funnelStages({
      created: 100,
      datos: 80,
      paid: 60,
      completed: 50,
      datosDropPct: 20,
      paidDropPct: 25,
      completedDropPct: 16.7,
      medianMinutesToPay: 5
    });
    expect(stages.map((stage) => stage.label)).toEqual(["Creadas", "Datos adjuntos", "Pagadas", "Completadas"]);
    expect(stages[0].count).toBe(100);
    // First stage has no drop-off; later stages carry theirs.
    expect(stages[1].dropPct).toBe(20);
  });
});

describe("heatmapMax", () => {
  it("returns the peak cell count for color scaling", () => {
    expect(
      heatmapMax([
        { day: 0, hour: 9, count: 2 },
        { day: 3, hour: 18, count: 7 }
      ])
    ).toBe(7);
    expect(heatmapMax([])).toBe(0);
  });
});
