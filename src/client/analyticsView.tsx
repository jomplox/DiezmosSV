import { BarChart3, TrendingUp, Filter } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { formatCents, formatCount } from "../shared/money";
import {
  DAY_LABELS,
  barLabelIndices,
  filterGiftType,
  formatChartCents,
  formatMonthLabel,
  formatWeekLabel,
  funnelStages,
  heatmapMax,
  monthlyChartModel,
  niceScale,
  weeklyStats,
  yoyChartModel,
  type AnalyticsRangePreset,
  type ClientAnalytics,
  type GiftTypeFilter,
  type MonthlyChartModel,
  type ValueScale,
  type YoyChartModel
} from "./analytics";
import type { AnalyticsCohortRow } from "./types";

// Analítica: tendencias del carril Wompi EXCLUSIVAMENTE. Charts are hand-rolled SVG —
// no chart dependency — themed with the existing CSS variables (var(--accent), --ok,
// --danger, etc.). Each chart is drawn at its measured pixel width so axis text stays
// at its real size. Every chart carries an aria-label with a one-sentence Spanish
// summary; no animations (prefers-reduced-motion is respected by having none).

const EMPTY = "Sin donaciones en este período.";

export interface AnalyticsViewProps {
  analytics: ClientAnalytics | null;
  loading: boolean;
  environment: "00" | "01";
  activeEnvironment: "00" | "01" | null;
  presets: AnalyticsRangePreset[];
  presetId: AnalyticsRangePreset["id"];
  from: string;
  to: string;
  giftFilter: GiftTypeFilter;
  onEnvironmentChange: (environment: "00" | "01") => void;
  onPresetChange: (presetId: AnalyticsRangePreset["id"]) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onGiftFilterChange: (filter: GiftTypeFilter) => void;
}

const GIFT_FILTERS: Array<{ id: GiftTypeFilter; label: string }> = [
  { id: "todos", label: "Todos" },
  { id: "diezmo", label: "Diezmo" },
  { id: "ofrenda", label: "Ofrenda" }
];

export function AnalyticsView(props: AnalyticsViewProps) {
  const { analytics } = props;
  return (
    <div className="analytics-view">
      <AnalyticsFilters {...props} />
      {props.loading && !analytics ? (
        <section className="single-panel analytics-panel">
          <p className="analytics-empty">Cargando analítica…</p>
        </section>
      ) : !analytics || !analytics.hasData ? (
        <section className="single-panel analytics-panel">
          <div className="panel-head">
            <div>
              <h2>Analítica</h2>
              <p>Tendencias de las donaciones en línea (carril Wompi).</p>
            </div>
            <BarChart3 size={20} />
          </div>
          <p className="analytics-empty">{EMPTY}</p>
        </section>
      ) : (
        <>
          <GivingTrendsPanel analytics={analytics} giftFilter={props.giftFilter} />
          <FunnelOperationsPanel analytics={analytics} />
          <DeepAnalysisPanel analytics={analytics} />
        </>
      )}
    </div>
  );
}

function AnalyticsFilters(props: AnalyticsViewProps) {
  const showCustom = props.presetId === "personalizado";
  return (
    <section className="single-panel analytics-filters">
      <div className="panel-head">
        <div>
          <h2>Filtros</h2>
          <p>Solo donaciones en línea (carril Wompi); los CDE emitidos a mano no se incluyen.</p>
        </div>
        <TrendingUp size={20} />
      </div>
      <div className="analytics-filter-row">
        <label className="analytics-field">
          <span>Ambiente</span>
          <select value={props.environment} onChange={(event) => props.onEnvironmentChange(event.target.value as "00" | "01")}>
            <option value="00">Pruebas (00)</option>
            <option value="01">Producción (01)</option>
          </select>
        </label>
        <label className="analytics-field">
          <span>Período</span>
          <select value={props.presetId} onChange={(event) => props.onPresetChange(event.target.value as AnalyticsRangePreset["id"])}>
            {props.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        {showCustom && (
          <>
            <label className="analytics-field">
              <span>Desde</span>
              <input type="date" value={props.from} max={props.to} onChange={(event) => props.onFromChange(event.target.value)} />
            </label>
            <label className="analytics-field">
              <span>Hasta</span>
              <input type="date" value={props.to} min={props.from} onChange={(event) => props.onToChange(event.target.value)} />
            </label>
          </>
        )}
        <div className="analytics-field">
          <span>
            <Filter size={13} /> Tipo
          </span>
          <div className="analytics-segmented" role="group" aria-label="Filtrar por tipo de donación">
            {GIFT_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={props.giftFilter === filter.id ? "active" : ""}
                aria-pressed={props.giftFilter === filter.id}
                onClick={() => props.onGiftFilterChange(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {props.activeEnvironment && props.environment !== props.activeEnvironment && (
        <p className="analytics-note">
          Está viendo el ambiente {props.environment === "01" ? "Producción" : "Pruebas"}; el ambiente de emisión activo es{" "}
          {props.activeEnvironment === "01" ? "Producción" : "Pruebas"}.
        </p>
      )}
    </section>
  );
}

// ----- Giving trends -----

function GivingTrendsPanel({ analytics, giftFilter }: { analytics: ClientAnalytics; giftFilter: GiftTypeFilter }) {
  const series = filterGiftType(analytics, giftFilter);
  const monthly = monthlyChartModel(series);
  const yoy = yoyChartModel(analytics.giving.yoy);
  const giftLabel = giftFilter === "todos" ? "todas las donaciones" : giftFilter === "diezmo" ? "los diezmos" : "las ofrendas";
  return (
    <section className="single-panel analytics-panel">
      <div className="panel-head">
        <div>
          <h2>Tendencias de donación</h2>
          <p>Totales aceptados por mes y por semana, comparativo interanual y donantes.</p>
        </div>
        <BarChart3 size={20} />
      </div>
      <div className="analytics-grid">
        <ChartCard title="Total mensual" summary={`Total mensual de ${giftLabel} aceptadas en el período.`} span={4}>
          {monthly.points.length === 0 ? <Empty /> : <MonthlyLineChart model={monthly} />}
        </ChartCard>
        <ChartCard
          title="Interanual"
          summary="Año en curso contra el año anterior, mes a mes."
          span={2}
          legend={<Legend items={[{ label: "Año en curso", tone: "line" }, { label: "Año anterior", tone: "prior" }]} />}
        >
          {yoy.maxCents === 0 ? <Empty /> : <YoyChart model={yoy} />}
        </ChartCard>
        <ChartCard title="Recaudo semanal" summary="Total aceptado por semana, de lunes a domingo." span={6}>
          {analytics.giving.weekly.length === 0 ? <Empty /> : <WeeklyGiving weekly={analytics.giving.weekly} />}
        </ChartCard>
        <ChartCard
          title="Diezmo vs. Ofrenda"
          summary="Reparto mensual entre diezmos y ofrendas."
          span={3}
          legend={<Legend items={[{ label: "Diezmo", tone: "accent" }, { label: "Ofrenda", tone: "soft" }]} />}
        >
          {analytics.giving.giftSplit.length === 0 ? (
            <Empty />
          ) : (
            <BarChart
              data={analytics.giving.giftSplit.map((point) => ({ key: point.key, values: [point.diezmoCents, point.ofrendaCents] }))}
              axis={monthAxis(analytics.giving.giftSplit.map((point) => point.key))}
              series={[{ label: "diezmo" }, { label: "ofrenda", tone: "soft" }]}
              formatAxis={formatChartCents}
              describe={(key, values) => `${formatMonthLabel(key)}: diezmo ${formatCents(values[0])}, ofrenda ${formatCents(values[1])}`}
              ariaLabel="Reparto mensual entre diezmos y ofrendas (barras apiladas)."
            />
          )}
        </ChartCard>
        <ChartCard title="Top 10 donantes recurrentes" summary="Donantes con más donaciones aceptadas; solo nombre y correo." span={3} tall>
          {analytics.giving.topDonors.length === 0 ? (
            <Empty />
          ) : (
            <div className="analytics-table-scroll">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Donante</th>
                    <th className="numeric">Donaciones</th>
                    <th className="numeric">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.giving.topDonors.map((donor) => (
                    <tr key={`${donor.donorName}:${donor.donorEmail ?? ""}`}>
                      <td>
                        <div className="analytics-donor-name">{donor.donorName}</div>
                        {donor.donorEmail && <div className="analytics-donor-email">{donor.donorEmail}</div>}
                      </td>
                      <td className="numeric">{formatCount(donor.count)}</td>
                      <td className="numeric">{formatCents(donor.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
        <ChartCard
          title="Nuevos vs. recurrentes"
          summary="Donantes nuevos y recurrentes por mes."
          span={3}
          legend={<Legend items={[{ label: "Nuevos", tone: "accent" }, { label: "Recurrentes", tone: "soft" }]} />}
        >
          {analytics.giving.donorMix.length === 0 ? (
            <Empty />
          ) : (
            <BarChart
              data={analytics.giving.donorMix.map((point) => ({ key: point.key, values: [point.returningDonors, point.newDonors] }))}
              axis={monthAxis(analytics.giving.donorMix.map((point) => point.key))}
              series={[{ label: "recurrentes", tone: "soft" }, { label: "nuevos" }]}
              formatAxis={formatCount}
              integer
              describe={(key, values) => `${formatMonthLabel(key)}: ${formatCount(values[1])} nuevos, ${formatCount(values[0])} recurrentes`}
              ariaLabel="Donantes nuevos y recurrentes por mes (barras apiladas)."
            />
          )}
        </ChartCard>
        <ChartCard
          title="Distribución geográfica"
          summary="Donaciones por departamento (CAT-012), municipio (CAT-013) y país para el extranjero."
          span={6}
        >
          <GeographyLists analytics={analytics} />
        </ChartCard>
      </div>
    </section>
  );
}

function WeeklyGiving({ weekly }: { weekly: ClientAnalytics["giving"]["weekly"] }) {
  const stats = weeklyStats(weekly.map((point) => ({ key: point.key, value: point.totalCents })));
  return (
    <>
      <dl className="analytics-figures">
        <div>
          <dt>Total del período</dt>
          <dd>{formatCents(stats.total)}</dd>
        </div>
        <div>
          <dt>Promedio semanal</dt>
          <dd>{formatCents(stats.average)}</dd>
        </div>
        {stats.peak && (
          <div>
            <dt>Mejor semana</dt>
            <dd>
              {formatCents(stats.peak.value)} <small>semana del {formatWeekLabel(stats.peak.key)}</small>
            </dd>
          </div>
        )}
      </dl>
      <BarChart
        data={weekly.map((point) => ({ key: point.key, values: [point.totalCents] }))}
        axis={weekAxis(weekly.map((point) => point.key))}
        series={[{ label: "total" }]}
        formatAxis={formatChartCents}
        describe={(key, values) => {
          const count = weekly.find((point) => point.key === key)?.count ?? 0;
          return `Semana del ${formatWeekLabel(key)}: ${formatCents(values[0])} (${formatCount(count)} ${count === 1 ? "donación" : "donaciones"})`;
        }}
        ariaLabel={`Recaudo semanal; promedio ${formatCents(stats.average)} por semana.`}
      />
    </>
  );
}

// ----- Funnel & operations -----

function FunnelOperationsPanel({ analytics }: { analytics: ClientAnalytics }) {
  const stages = funnelStages(analytics.funnel);
  const maxCount = stages.reduce((max, stage) => Math.max(max, stage.count), 0);
  return (
    <section className="single-panel analytics-panel">
      <div className="panel-head">
        <div>
          <h2>Embudo y operación</h2>
          <p>Conversión del checkout, salud del Ministerio de Hacienda y entregabilidad de correo.</p>
        </div>
        <Filter size={20} />
      </div>
      <div className="analytics-grid">
        <ChartCard title="Embudo de conversión" summary="Intenciones creadas, con datos, pagadas y completadas, con su caída por etapa." span={2}>
          {analytics.funnel.created === 0 ? (
            <Empty />
          ) : (
            <div className="analytics-funnel" role="img" aria-label="Embudo de conversión del checkout de donación.">
              {stages.map((stage) => (
                <div key={stage.label} className="analytics-funnel-row">
                  <div className="analytics-funnel-label">{stage.label}</div>
                  <div className="analytics-funnel-track">
                    <div className="analytics-funnel-bar" style={{ width: `${maxCount > 0 ? (stage.count / maxCount) * 100 : 0}%` }} />
                    <span className="analytics-funnel-count">{formatCount(stage.count)}</span>
                  </div>
                  <div className="analytics-funnel-drop">{stage.dropPct > 0 ? `−${stage.dropPct}%` : ""}</div>
                </div>
              ))}
              <p className="analytics-stat">
                Mediana de creada a pagada: <strong>{formatCount(analytics.funnel.medianMinutesToPay)} min</strong>
              </p>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Salud del Ministerio de Hacienda" summary="Tiempo de emisión a aceptación, rechazos y transmisiones diferidas." span={2}>
          <dl className="analytics-figures">
            <div>
              <dt>Latencia mediana</dt>
              <dd>{formatCount(analytics.mhHealth.medianLatencySeconds)} s</dd>
            </div>
            <div>
              <dt>Percentil 90</dt>
              <dd>{formatCount(analytics.mhHealth.p90LatencySeconds)} s</dd>
            </div>
          </dl>
          <h4 className="analytics-subtitle">Rechazos por semana</h4>
          {analytics.mhHealth.weeklyRejections.length > 0 ? (
            <BarChart
              data={analytics.mhHealth.weeklyRejections.map((point) => ({ key: point.key, values: [point.count] }))}
              axis={weekAxis(analytics.mhHealth.weeklyRejections.map((point) => point.key))}
              series={[{ label: "rechazos", tone: "danger" }]}
              formatAxis={formatCount}
              integer
              height={COMPACT_CHART_HEIGHT}
              describe={(key, values) => `Semana del ${formatWeekLabel(key)}: ${formatCount(values[0])} rechazos`}
              ariaLabel="Rechazos por semana."
            />
          ) : (
            <p className="analytics-stat analytics-muted">Sin rechazos en el período.</p>
          )}
          {analytics.mhHealth.weeklyDeferred.length > 0 && (
            <>
              <h4 className="analytics-subtitle">Transmisiones diferidas por semana</h4>
              <BarChart
                data={analytics.mhHealth.weeklyDeferred.map((point) => ({ key: point.key, values: [point.count] }))}
                axis={weekAxis(analytics.mhHealth.weeklyDeferred.map((point) => point.key))}
                series={[{ label: "diferidas", tone: "warn" }]}
                formatAxis={formatCount}
                integer
                height={COMPACT_CHART_HEIGHT}
                describe={(key, values) => `Semana del ${formatWeekLabel(key)}: ${formatCount(values[0])} diferidas`}
                ariaLabel="Transmisiones diferidas por semana."
              />
            </>
          )}
        </ChartCard>
        <ChartCard
          title="Entregabilidad de correo"
          summary="Correos enviados y fallidos por semana."
          span={2}
          legend={<Legend items={[{ label: "Enviados", tone: "ok" }, { label: "Fallidos", tone: "danger" }]} />}
        >
          {analytics.email.weekly.length === 0 ? (
            <p className="analytics-empty-small">Sin correos en este período.</p>
          ) : (
            <BarChart
              data={analytics.email.weekly.map((point) => ({ key: point.key, values: [point.sent, point.failed] }))}
              axis={weekAxis(analytics.email.weekly.map((point) => point.key))}
              series={[{ label: "enviados", tone: "ok" }, { label: "fallidos", tone: "danger" }]}
              formatAxis={formatCount}
              integer
              describe={(key, values) => `Semana del ${formatWeekLabel(key)}: ${formatCount(values[0])} enviados, ${formatCount(values[1])} fallidos`}
              ariaLabel="Correos enviados y fallidos por semana."
            />
          )}
        </ChartCard>
      </div>
    </section>
  );
}

// ----- Deep analysis -----

function DeepAnalysisPanel({ analytics }: { analytics: ClientAnalytics }) {
  return (
    <section className="single-panel analytics-panel">
      <div className="panel-head">
        <div>
          <h2>Análisis profundo</h2>
          <p>Retención por cohortes, mapa de calor, donantes inactivos y proyección.</p>
        </div>
        <TrendingUp size={20} />
      </div>
      <div className="analytics-grid">
        <ChartCard title="Retención por cohortes" summary="Porcentaje de cada cohorte de primer mes que vuelve a donar en meses posteriores." span={6}>
          {analytics.cohorts.length === 0 ? <Empty /> : <CohortGrid cohorts={analytics.cohorts} />}
        </ChartCard>
        <ChartCard title="Mapa de calor (día × hora)" summary="Donaciones aceptadas por día de la semana y hora, en hora de El Salvador." span={6}>
          {analytics.heatmap.length === 0 ? <Empty /> : <Heatmap cells={analytics.heatmap} />}
        </ChartCard>
        <ChartCard title="Donantes inactivos" summary="Donaron en los 90 días previos pero no en los últimos 30." span={3}>
          {analytics.lapsed.count === 0 ? (
            <p className="analytics-stat analytics-muted">Sin donantes inactivos en el período.</p>
          ) : (
            <>
              <dl className="analytics-figures">
                <div>
                  <dt>Inactivos</dt>
                  <dd>{formatCount(analytics.lapsed.count)}</dd>
                </div>
              </dl>
              <div className="analytics-table-scroll">
                <table className="analytics-table">
                  <thead>
                    <tr>
                      <th>Donante</th>
                      <th className="numeric">Total histórico</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.lapsed.donors.map((donor) => (
                      <tr key={`${donor.donorName}:${donor.donorEmail ?? ""}`}>
                        <td>
                          <div className="analytics-donor-name">{donor.donorName}</div>
                          {donor.donorEmail && <div className="analytics-donor-email">{donor.donorEmail}</div>}
                        </td>
                        <td className="numeric">{formatCents(donor.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </ChartCard>
        <ChartCard title="Proyección" summary="Ritmo del mes en curso, promedio móvil de 3 meses y proyección simple." span={3}>
          <dl className="analytics-figures analytics-figures-stacked">
            <div>
              <dt>Mes en curso</dt>
              <dd>{formatCents(analytics.projection.currentMonthCents)}</dd>
            </div>
            <div>
              <dt>Promedio móvil (3 meses)</dt>
              <dd>{formatCents(analytics.projection.movingAverageCents)}</dd>
            </div>
            <div className="analytics-projection">
              <dt>Proyección simple del mes</dt>
              <dd>{formatCents(analytics.projection.runRateCents)}</dd>
            </div>
          </dl>
          <p className="analytics-note">Proyección simple basada en el ritmo diario; no es un pronóstico.</p>
        </ChartCard>
      </div>
    </section>
  );
}

// ----- Card chrome -----

function ChartCard({
  title,
  summary,
  span,
  tall,
  legend,
  children
}: {
  title: string;
  summary: string;
  span: 2 | 3 | 4 | 6;
  tall?: boolean;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`analytics-card analytics-span-${span}${tall ? " analytics-card-tall" : ""}`}>
      <div className="analytics-card-head">
        <div>
          <h3 className="analytics-card-title">{title}</h3>
          <p className="analytics-card-summary">{summary}</p>
        </div>
        {legend}
      </div>
      {children}
    </div>
  );
}

function Legend({ items }: { items: Array<{ label: string; tone: "accent" | "soft" | "line" | "prior" | "ok" | "danger" }> }) {
  return (
    <ul className="analytics-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className={`analytics-swatch analytics-swatch-${item.tone}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Empty() {
  return <p className="analytics-empty-small">{EMPTY}</p>;
}

// ----- Chart primitives (hand-rolled SVG) -----

const CHART_HEIGHT = 220;
const COMPACT_CHART_HEIGHT = 130;
// Approximate advance of one 11px tabular figure; used to keep labels from colliding.
const LABEL_CHAR_PX = 6.6;
const textWidth = (text: string) => text.length * LABEL_CHAR_PX;

interface AxisLabel {
  text: string;
  // Second line, shown where the year starts or changes.
  year?: string;
}

function monthAxis(keys: string[]): AxisLabel[] {
  return keys.map((key, index) => ({
    text: formatMonthLabel(key).split(" ")[0],
    year: index === 0 || key.endsWith("-01") ? key.slice(0, 4) : undefined
  }));
}

function weekAxis(keys: string[]): AxisLabel[] {
  return keys.map((key, index) => ({
    text: formatWeekLabel(key),
    year: index === 0 || key.slice(0, 4) !== keys[index - 1].slice(0, 4) ? key.slice(0, 4) : undefined
  }));
}

interface Plot {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function plotArea(width: number, height: number, scale: ValueScale, formatAxis: (value: number) => string, axis: AxisLabel[]): Plot {
  const widestTick = Math.max(...scale.ticks.map((tick) => textWidth(formatAxis(tick))));
  const twoLineAxis = axis.some((label) => label.year);
  return { width, height, left: Math.ceil(widestTick) + 10, right: width - 4, top: 18, bottom: height - (twoLineAxis ? 36 : 22) };
}

const yAt = (plot: Plot, scale: ValueScale, value: number) => plot.bottom - ((plot.bottom - plot.top) * value) / scale.max;

// Equal category bands; bars and points sit at band centers.
function bands(plot: Plot, count: number) {
  const slot = (plot.right - plot.left) / Math.max(count, 1);
  return { slot, center: (index: number) => plot.left + slot * (index + 0.5) };
}

// Measures the chart container so the SVG is drawn at 1:1 pixels.
function useElementWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) {
      return;
    }
    setWidth(Math.floor(node.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    observer.current = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}

function ChartFrame({ height, children }: { height: number; children: (width: number) => ReactNode }) {
  const [ref, width] = useElementWidth();
  return (
    <div ref={ref} className="analytics-chart" style={{ height }}>
      {width > 0 ? children(width) : null}
    </div>
  );
}

function ValueAxis({ plot, scale, format }: { plot: Plot; scale: ValueScale; format: (value: number) => string }) {
  return (
    <g aria-hidden="true">
      {scale.ticks.map((tick) => {
        const y = yAt(plot, scale, tick);
        return (
          <g key={tick}>
            <line x1={plot.left} x2={plot.right} y1={y} y2={y} className={tick === 0 ? "analytics-axis" : "analytics-gridline"} />
            <text x={plot.left - 8} y={y} dy="0.32em" textAnchor="end" className="analytics-axis-label">
              {format(tick)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// Category labels under the plot, thinned so they never overlap; the latest one and any
// label that opens a new year always show.
function CategoryAxis({ plot, labels }: { plot: Plot; labels: AxisLabel[] }) {
  const { slot, center } = bands(plot, labels.length);
  const every = Math.max(1, Math.ceil((Math.max(0, ...labels.map((label) => textWidth(label.text))) + 12) / slot));
  // A year start too close to the next one (a first week that ends in December) yields
  // to the newer year.
  const yearStarts = labels
    .flatMap((label, index) => (label.year ? [index] : []))
    .filter((start, position, starts) => position === starts.length - 1 || starts[position + 1] - start >= every);
  return (
    <g aria-hidden="true">
      {labels.map((label, index) => {
        const isYearStart = yearStarts.includes(index);
        const show = isYearStart || ((labels.length - 1 - index) % every === 0 && yearStarts.every((start) => Math.abs(start - index) >= every));
        if (!show) {
          return null;
        }
        const half = Math.max(textWidth(label.text), isYearStart ? textWidth(label.year ?? "") : 0) / 2;
        const x = Math.min(Math.max(center(index), half), plot.width - half);
        return (
          <text key={index} x={x} y={plot.bottom + 16} textAnchor="middle" className="analytics-axis-label">
            {label.text}
            {isYearStart && (
              <tspan x={x} dy={14} className="analytics-axis-year">
                {label.year}
              </tspan>
            )}
          </text>
        );
      })}
    </g>
  );
}

function MonthlyLineChart({ model }: { model: MonthlyChartModel }) {
  const summary = `Total mensual; el mes más alto suma ${formatCents(model.maxCents)}.`;
  const axis = monthAxis(model.points.map((point) => point.key));
  return (
    <ChartFrame height={CHART_HEIGHT}>
      {(width) => {
        const scale = niceScale(model.maxCents);
        const plot = plotArea(width, CHART_HEIGHT, scale, formatChartCents, axis);
        const { slot, center } = bands(plot, model.points.length);
        const coords = model.points.map((point, index) => ({ point, x: center(index), y: yAt(plot, scale, point.totalCents) }));
        const line = coords.map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`).join(" ");
        const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${plot.bottom} L${coords[0].x.toFixed(1)},${plot.bottom} Z`;
        const labelled = barLabelIndices(
          model.points.map((point) => point.totalCents),
          slot,
          (index) => textWidth(formatChartCents(model.points[index].totalCents))
        );
        return (
          <svg width={width} height={CHART_HEIGHT} viewBox={`0 0 ${width} ${CHART_HEIGHT}`} className="analytics-svg" role="img" aria-label={summary}>
            <title>{summary}</title>
            <ValueAxis plot={plot} scale={scale} format={formatChartCents} />
            <path d={area} className="analytics-area" />
            <path d={line} className="analytics-line" fill="none" />
            {coords.map((coord, index) => (
              <g key={coord.point.key}>
                <circle cx={coord.x} cy={coord.y} r={3.5} className="analytics-dot">
                  <title>
                    {`${coord.point.label}: ${formatCents(coord.point.totalCents)}${coord.point.count > 0 ? ` (${formatCount(coord.point.count)} donaciones)` : ""}`}
                  </title>
                </circle>
                {labelled.has(index) && (
                  <text x={coord.x} y={valueLabelY(coords, index, plot)} textAnchor="middle" className="analytics-bar-value">
                    {formatChartCents(coord.point.totalCents)}
                  </text>
                )}
              </g>
            ))}
            <CategoryAxis plot={plot} labels={axis} />
          </svg>
        );
      }}
    </ChartFrame>
  );
}

// A point lower than its neighbours takes its label underneath, away from the segments
// that rise out of it; every other point is labelled above.
function valueLabelY(coords: Array<{ y: number }>, index: number, plot: Plot): number {
  const neighbours = [coords[index - 1], coords[index + 1]].filter((coord) => coord !== undefined);
  const isLow = neighbours.length > 0 && neighbours.every((coord) => coord.y < coords[index].y);
  return isLow && coords[index].y + 22 <= plot.bottom ? coords[index].y + 19 : coords[index].y - 10;
}

function YoyChart({ model }: { model: YoyChartModel }) {
  // The current year is drawn only across its months with gifts, instead of sitting at
  // zero for months outside the range or not yet reached.
  const filled = model.current.flatMap((value, index) => (value > 0 ? [index] : []));
  const firstMonth = filled[0] ?? 0;
  const lastMonth = filled[filled.length - 1] ?? -1;
  const axis = model.months.map((month) => ({ text: formatMonthLabel(`2000-${month}`).split(" ")[0] }));
  const summary = `Comparativo interanual; el mes más alto suma ${formatCents(model.maxCents)}.`;
  return (
    <ChartFrame height={CHART_HEIGHT}>
      {(width) => {
        const scale = niceScale(model.maxCents);
        const plot = plotArea(width, CHART_HEIGHT, scale, formatChartCents, axis);
        const { center } = bands(plot, axis.length);
        const path = (values: number[], from = 0, to = values.length - 1) =>
          values
            .slice(from, to + 1)
            .map((value, offset) => `${offset === 0 ? "M" : "L"}${center(from + offset).toFixed(1)},${yAt(plot, scale, value).toFixed(1)}`)
            .join(" ");
        return (
          <svg width={width} height={CHART_HEIGHT} viewBox={`0 0 ${width} ${CHART_HEIGHT}`} className="analytics-svg" role="img" aria-label={summary}>
            <title>{summary}</title>
            <ValueAxis plot={plot} scale={scale} format={formatChartCents} />
            <path d={path(model.prior)} className="analytics-line analytics-line-prior" fill="none" />
            {lastMonth >= firstMonth && <path d={path(model.current, firstMonth, lastMonth)} className="analytics-line" fill="none" />}
            {model.current.map((value, index) =>
              index >= firstMonth && index <= lastMonth ? (
                <circle key={model.months[index]} cx={center(index)} cy={yAt(plot, scale, value)} r={3} className="analytics-dot">
                  <title>{`${axis[index].text}: año en curso ${formatCents(value)}, año anterior ${formatCents(model.prior[index] ?? 0)}`}</title>
                </circle>
              ) : null
            )}
            <CategoryAxis plot={plot} labels={axis} />
          </svg>
        );
      }}
    </ChartFrame>
  );
}

// Vertical bars, stacked when there is more than one series (first series at the
// base). Totals are printed above the bars wherever the label fits.
function BarChart({
  data,
  axis,
  series,
  formatAxis,
  integer,
  height = CHART_HEIGHT,
  describe,
  ariaLabel
}: {
  data: Array<{ key: string; values: number[] }>;
  axis: AxisLabel[];
  series: Array<{ label: string; tone?: "soft" | "ok" | "danger" | "warn" }>;
  formatAxis: (value: number) => string;
  integer?: boolean;
  height?: number;
  describe: (key: string, values: number[]) => string;
  ariaLabel: string;
}) {
  return (
    <ChartFrame height={height}>
      {(width) => {
        const totals = data.map((datum) => datum.values.reduce((sum, value) => sum + value, 0));
        const scale = niceScale(Math.max(0, ...totals), { integer });
        const plot = plotArea(width, height, scale, formatAxis, axis);
        const { slot, center } = bands(plot, data.length);
        const barWidth = Math.max(2, Math.min(slot * 0.68, 44));
        const labelled = barLabelIndices(totals, slot, (index) => textWidth(formatAxis(totals[index])));
        return (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="analytics-svg" role="img" aria-label={ariaLabel}>
            <title>{ariaLabel}</title>
            <ValueAxis plot={plot} scale={scale} format={formatAxis} />
            {data.map((datum, index) => {
              let stacked = 0;
              const description = describe(datum.key, datum.values);
              return (
                <g key={datum.key}>
                  {datum.values.map((value, seriesIndex) => {
                    if (value <= 0) {
                      return null;
                    }
                    const base = yAt(plot, scale, stacked);
                    stacked += value;
                    const top = yAt(plot, scale, stacked);
                    const tone = series[seriesIndex]?.tone;
                    return (
                      <rect
                        key={series[seriesIndex]?.label ?? seriesIndex}
                        x={center(index) - barWidth / 2}
                        y={top}
                        width={barWidth}
                        height={Math.max(base - top, 1)}
                        className={`analytics-bar${tone ? ` analytics-bar-${tone}` : ""}`}
                      >
                        <title>{description}</title>
                      </rect>
                    );
                  })}
                  {labelled.has(index) && (
                    <text x={center(index)} y={yAt(plot, scale, totals[index]) - 6} textAnchor="middle" className="analytics-bar-value">
                      {formatAxis(totals[index])}
                    </text>
                  )}
                </g>
              );
            })}
            <CategoryAxis plot={plot} labels={axis} />
          </svg>
        );
      }}
    </ChartFrame>
  );
}

function GeographyLists({ analytics }: { analytics: ClientAnalytics }) {
  if (analytics.geography.departments.length === 0 && analytics.geography.foreign.length === 0) {
    return <Empty />;
  }
  return (
    <div className="analytics-geo">
      {analytics.geography.departments.length > 0 && (
        <GeoBucketBars title="Departamentos" buckets={analytics.geography.departments} />
      )}
      {analytics.geography.municipalities.length > 0 && (
        <GeoBucketBars title="Municipios" buckets={analytics.geography.municipalities} />
      )}
      {analytics.geography.foreign.length > 0 && <GeoBucketBars title="Extranjero" buckets={analytics.geography.foreign} />}
    </div>
  );
}

function GeoBucketBars({ title, buckets }: { title: string; buckets: ClientAnalytics["geography"]["departments"] }) {
  const max = buckets.reduce((peak, bucket) => Math.max(peak, bucket.totalCents), 0);
  return (
    <div className="analytics-geo-block">
      <h4 className="analytics-subtitle">{title}</h4>
      <ul className="analytics-geo-list" aria-label={`Distribución por ${title.toLowerCase()}.`}>
        {buckets.slice(0, 10).map((bucket) => (
          <li key={bucket.code} title={`${bucket.label}: ${formatCents(bucket.totalCents)} en ${formatCount(bucket.count)} ${bucket.count === 1 ? "donación" : "donaciones"}`}>
            <span className="analytics-geo-label">{bucket.label}</span>
            <span className="analytics-geo-track">
              <span className="analytics-geo-bar" style={{ width: `${max > 0 ? (bucket.totalCents / max) * 100 : 0}%` }} />
            </span>
            <span className="analytics-geo-value">{formatCents(bucket.totalCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CohortGrid({ cohorts }: { cohorts: AnalyticsCohortRow[] }) {
  const maxOffset = cohorts.reduce((max, cohort) => Math.max(max, cohort.retention.length - 1), 0);
  const offsets = Array.from({ length: Math.min(maxOffset, 12) + 1 }, (_, index) => index);
  return (
    <div className="analytics-table-scroll">
      <table className="analytics-cohort" aria-label="Rejilla de retención por cohorte de primer mes.">
        <thead>
          <tr>
            <th>Cohorte</th>
            <th className="numeric">Tamaño</th>
            {offsets.map((offset) => (
              <th key={offset} className="numeric">
                +{offset}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.cohort}>
              <td>{formatMonthLabel(cohort.cohort)}</td>
              <td className="numeric">{formatCount(cohort.size)}</td>
              {offsets.map((offset) => {
                const value = cohort.retention[offset] ?? 0;
                return (
                  <td
                    key={offset}
                    // Past ~60% accent the fill is dark enough that the figure needs light text.
                    className={`numeric analytics-cohort-cell${value >= 60 ? " analytics-cohort-cell-strong" : ""}`}
                    style={{ backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(value)}%, var(--surface))` }}
                    title={`${formatMonthLabel(cohort.cohort)}, mes +${offset}: ${value}% volvió a donar`}
                  >
                    {value > 0 ? `${value}%` : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heatmap({ cells }: { cells: ClientAnalytics["heatmap"] }) {
  const max = heatmapMax(cells);
  const byCell = new Map(cells.map((cell) => [`${cell.day}:${cell.hour}`, cell.count]));
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <>
      <p className="analytics-heatmap-help">
        Cada celda cruza un día con una hora en horario de El Salvador; cuanto más oscuro el color, más donaciones aceptadas hubo en ese bloque.
        Pase el cursor o toque una celda para ver el total exacto.
      </p>
      <div className="analytics-table-scroll">
        <table className="analytics-heatmap" aria-label="Mapa de calor de donaciones por día de la semana y hora, en hora de El Salvador.">
          <thead>
            <tr>
              <th />
              {hours.map((hour) => (
                <th key={hour} className="analytics-heatmap-hour">
                  {hour}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((label, day) => (
              <tr key={label}>
                <th className="analytics-heatmap-day">{label}</th>
                {hours.map((hour) => {
                  const count = byCell.get(`${day}:${hour}`) ?? 0;
                  const intensity = max > 0 ? Math.round((count / max) * 100) : 0;
                  const heatmapLabel = `${label} ${hour}:00 - ${count} ${count === 1 ? "donación aceptada" : "donaciones aceptadas"}`;
                  return (
                    <td
                      key={hour}
                      className="analytics-heatmap-cell"
                      style={{ backgroundColor: count > 0 ? `color-mix(in srgb, var(--accent) ${intensity}%, var(--surface))` : undefined }}
                    >
                      <button type="button" className="analytics-heatmap-button" aria-label={heatmapLabel} title={heatmapLabel}>
                        <span className="analytics-heatmap-value" aria-hidden="true">
                          {count}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
