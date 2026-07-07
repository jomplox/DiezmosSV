import { BarChart3, TrendingUp, Filter } from "lucide-react";
import type { ReactNode } from "react";
import {
  analyticsRangePresets,
  DAY_LABELS,
  filterGiftType,
  formatCentsUsd,
  formatMonthLabel,
  formatWeekLabel,
  funnelStages,
  heatmapMax,
  monthlyChartModel,
  yoyChartModel,
  type AnalyticsRangePreset,
  type ClientAnalytics,
  type GiftTypeFilter
} from "./analytics";
import type { AnalyticsCohortRow } from "./types";

// Analítica: tendencias del carril Wompi EXCLUSIVAMENTE. Charts are hand-rolled SVG —
// no chart dependency — themed with the existing CSS variables (var(--accent), --ok,
// --danger, etc.). Every chart carries an aria-label with a one-sentence Spanish
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
          <h2>Analítica</h2>
          <p>Tendencias de las donaciones en línea (carril Wompi). Los CDE emitidos a mano no se incluyen.</p>
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
          <p>Totales aceptados por mes, promedio por donante y comparativo interanual.</p>
        </div>
        <BarChart3 size={20} />
      </div>
      <div className="analytics-grid">
        <ChartCard title="Total mensual (US$)" summary={`Total mensual de ${giftLabel} aceptadas en el período.`}>
          {monthly.points.length === 0 ? <Empty /> : <AreaLineChart model={monthly} />}
        </ChartCard>
        <ChartCard title="Nuevos vs. recurrentes" summary="Donantes nuevos y recurrentes por mes.">
          {analytics.giving.donorMix.length === 0 ? <Empty /> : <DonorMixChart data={analytics.giving.donorMix} />}
        </ChartCard>
        <ChartCard title="Interanual (US$)" summary="Comparativo del año en curso contra el año anterior, mes a mes.">
          {yoy.maxCents === 0 ? <Empty /> : <YoyChart model={yoy} />}
        </ChartCard>
        <ChartCard title="Diezmo vs. Ofrenda (US$)" summary="Reparto mensual entre diezmos y ofrendas.">
          {analytics.giving.giftSplit.length === 0 ? <Empty /> : <GiftSplitChart data={analytics.giving.giftSplit} />}
        </ChartCard>
        <ChartCard title="Recaudo semanal (US$)" summary="Total aceptado por semana.">
          {analytics.giving.weekly.length === 0 ? <Empty /> : <WeeklyBars data={analytics.giving.weekly.map((point) => ({ key: point.key, value: point.totalCents }))} formatValue={formatCentsUsd} />}
        </ChartCard>
        <ChartCard title="Top 10 donantes recurrentes" summary="Donantes con más donaciones aceptadas; solo nombre y correo.">
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
                      <td className="numeric">{donor.count}</td>
                      <td className="numeric">{formatCentsUsd(donor.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Distribución geográfica" summary="Donaciones por departamento (CAT-012) y por país para el extranjero.">
          <GeographyLists analytics={analytics} />
        </ChartCard>
      </div>
    </section>
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
        <ChartCard title="Embudo de conversión" summary="Intenciones creadas, con datos, pagadas y completadas, con su caída por etapa.">
          {analytics.funnel.created === 0 ? (
            <Empty />
          ) : (
            <div className="analytics-funnel" role="img" aria-label="Embudo de conversión del checkout de donación.">
              {stages.map((stage) => (
                <div key={stage.label} className="analytics-funnel-row">
                  <div className="analytics-funnel-label">{stage.label}</div>
                  <div className="analytics-funnel-track">
                    <div className="analytics-funnel-bar" style={{ width: `${maxCount > 0 ? (stage.count / maxCount) * 100 : 0}%` }} />
                    <span className="analytics-funnel-count">{stage.count}</span>
                  </div>
                  <div className="analytics-funnel-drop">{stage.dropPct > 0 ? `−${stage.dropPct}%` : ""}</div>
                </div>
              ))}
              <p className="analytics-stat">
                Mediana de creada a pagada: <strong>{analytics.funnel.medianMinutesToPay} min</strong>
              </p>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Salud del Ministerio de Hacienda" summary="Latencia de aceptación, rechazos y transmisiones diferidas.">
          <div className="analytics-stats-block">
            <p className="analytics-stat">
              Latencia mediana emisión→aceptación: <strong>{analytics.mhHealth.medianLatencySeconds} s</strong>
            </p>
            <p className="analytics-stat">
              Percentil 90: <strong>{analytics.mhHealth.p90LatencySeconds} s</strong>
            </p>
            {analytics.mhHealth.weeklyRejections.length > 0 ? (
              <WeeklyBars
                data={analytics.mhHealth.weeklyRejections.map((point) => ({ key: point.key, value: point.count }))}
                formatValue={(value) => String(value)}
                tone="danger"
                ariaLabel="Rechazos por semana."
              />
            ) : (
              <p className="analytics-stat analytics-muted">Sin rechazos en el período.</p>
            )}
            {analytics.mhHealth.weeklyDeferred.length > 0 && (
              <WeeklyBars
                data={analytics.mhHealth.weeklyDeferred.map((point) => ({ key: point.key, value: point.count }))}
                formatValue={(value) => String(value)}
                tone="warn"
                ariaLabel="Transmisiones diferidas por semana."
              />
            )}
          </div>
        </ChartCard>
        <ChartCard title="Entregabilidad de correo" summary="Correos enviados y fallidos por semana.">
          {analytics.email.weekly.length === 0 ? <Empty /> : <EmailDeliverabilityChart data={analytics.email.weekly} />}
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
          <p>Retención por cohortes, donantes inactivos, mapa de calor y proyección.</p>
        </div>
        <TrendingUp size={20} />
      </div>
      <div className="analytics-grid">
        <ChartCard title="Retención por cohortes" summary="Porcentaje de cada cohorte de primer mes que vuelve a donar en meses posteriores." wide>
          {analytics.cohorts.length === 0 ? <Empty /> : <CohortGrid cohorts={analytics.cohorts} />}
        </ChartCard>
        <ChartCard title="Donantes inactivos" summary="Donaron en los 90 días previos pero no en los últimos 30.">
          {analytics.lapsed.count === 0 ? (
            <p className="analytics-stat analytics-muted">Sin donantes inactivos en el período.</p>
          ) : (
            <div className="analytics-table-scroll">
              <p className="analytics-stat">
                Inactivos: <strong>{analytics.lapsed.count}</strong>
              </p>
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
                      <td className="numeric">{formatCentsUsd(donor.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
        <ChartCard title="Mapa de calor (día × hora)" summary="Donaciones aceptadas por día de la semana y hora, en hora de El Salvador." wide>
          {analytics.heatmap.length === 0 ? <Empty /> : <Heatmap cells={analytics.heatmap} />}
        </ChartCard>
        <ChartCard title="Proyección" summary="Ritmo del mes en curso, promedio móvil de 3 meses y proyección simple.">
          <div className="analytics-stats-block">
            <p className="analytics-stat">
              Mes en curso: <strong>{formatCentsUsd(analytics.projection.currentMonthCents)}</strong>
            </p>
            <p className="analytics-stat">
              Promedio móvil (3 meses): <strong>{formatCentsUsd(analytics.projection.movingAverageCents)}</strong>
            </p>
            <p className="analytics-stat analytics-projection">
              Proyección simple del mes: <strong>{formatCentsUsd(analytics.projection.runRateCents)}</strong>
            </p>
            <p className="analytics-note">Proyección simple basada en el ritmo diario; no es un pronóstico.</p>
          </div>
        </ChartCard>
      </div>
    </section>
  );
}

// ----- Chart primitives (hand-rolled SVG) -----

function ChartCard({ title, summary, wide, children }: { title: string; summary: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`analytics-card${wide ? " analytics-card-wide" : ""}`}>
      <h3 className="analytics-card-title" title={summary}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="analytics-empty-small">{EMPTY}</p>;
}

const CHART_W = 320;
const CHART_H = 140;
const PAD = 24;

function AreaLineChart({ model }: { model: ReturnType<typeof monthlyChartModel> }) {
  const points = model.points;
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const coords = points.map((point, index) => ({
    x: PAD + (points.length > 1 ? index * step : innerW / 2),
    y: PAD + innerH * (1 - point.ratio),
    point
  }));
  const linePath = coords.map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(PAD + innerH).toFixed(1)} L${coords[0].x.toFixed(1)},${(PAD + innerH).toFixed(1)} Z`;
  const summary = `Total mensual, máximo ${formatCentsUsd(model.maxCents)}.`;
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="analytics-svg" role="img" aria-label={summary}>
      <title>{summary}</title>
      <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} className="analytics-axis" />
      <path d={areaPath} className="analytics-area" />
      <path d={linePath} className="analytics-line" fill="none" />
      {coords.map((coord) => (
        <circle key={coord.point.key} cx={coord.x} cy={coord.y} r={2.5} className="analytics-dot">
          <title>{`${coord.point.label}: ${formatCentsUsd(coord.point.totalCents)} (${coord.point.count} donaciones)`}</title>
        </circle>
      ))}
      {coords.map((coord, index) =>
        index % Math.ceil(coords.length / 6 || 1) === 0 ? (
          <text key={`l-${coord.point.key}`} x={coord.x} y={CHART_H - 6} className="analytics-axis-label" textAnchor="middle">
            {coord.point.label}
          </text>
        ) : null
      )}
    </svg>
  );
}

function YoyChart({ model }: { model: ReturnType<typeof yoyChartModel> }) {
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const step = innerW / 11;
  const line = (values: number[]) =>
    values
      .map((value, index) => {
        const x = PAD + index * step;
        const y = PAD + innerH * (1 - (model.maxCents > 0 ? value / model.maxCents : 0));
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const summary = `Comparativo interanual; máximo ${formatCentsUsd(model.maxCents)}.`;
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="analytics-svg" role="img" aria-label={summary}>
      <title>{summary}</title>
      <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} className="analytics-axis" />
      <path d={line(model.prior)} className="analytics-line analytics-line-prior" fill="none" />
      <path d={line(model.current)} className="analytics-line" fill="none" />
      <text x={PAD} y={12} className="analytics-legend analytics-legend-current">Año en curso</text>
      <text x={PAD + 90} y={12} className="analytics-legend analytics-legend-prior">Año anterior</text>
    </svg>
  );
}

function WeeklyBars({
  data,
  formatValue,
  tone,
  ariaLabel
}: {
  data: Array<{ key: string; value: number }>;
  formatValue: (value: number) => string;
  tone?: "danger" | "warn";
  ariaLabel?: string;
}) {
  const max = data.reduce((peak, point) => Math.max(peak, point.value), 0);
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const barW = data.length > 0 ? Math.min(innerW / data.length - 3, 26) : 0;
  const summary = ariaLabel ?? `Serie semanal; máximo ${formatValue(max)}.`;
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="analytics-svg" role="img" aria-label={summary}>
      <title>{summary}</title>
      <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} className="analytics-axis" />
      {data.map((point, index) => {
        const height = max > 0 ? innerH * (point.value / max) : 0;
        const x = PAD + index * (innerW / data.length) + 1;
        const y = PAD + innerH - height;
        return (
          <g key={point.key}>
            <rect x={x} y={y} width={Math.max(barW, 2)} height={height} className={`analytics-bar${tone ? ` analytics-bar-${tone}` : ""}`}>
              <title>{`${formatWeekLabel(point.key)}: ${formatValue(point.value)}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function DonorMixChart({ data }: { data: ClientAnalytics["giving"]["donorMix"] }) {
  const max = data.reduce((peak, point) => Math.max(peak, point.newDonors + point.returningDonors), 0);
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const summary = "Donantes nuevos y recurrentes por mes (barras apiladas).";
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="analytics-svg" role="img" aria-label={summary}>
      <title>{summary}</title>
      <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} className="analytics-axis" />
      {data.map((point, index) => {
        const total = point.newDonors + point.returningDonors;
        const totalHeight = max > 0 ? innerH * (total / max) : 0;
        const returningHeight = total > 0 ? totalHeight * (point.returningDonors / total) : 0;
        const newHeight = totalHeight - returningHeight;
        const x = PAD + index * (innerW / data.length) + 1;
        const barW = Math.max(Math.min(innerW / data.length - 3, 26), 2);
        const returningY = PAD + innerH - returningHeight;
        const newY = returningY - newHeight;
        return (
          <g key={point.key}>
            <rect x={x} y={returningY} width={barW} height={returningHeight} className="analytics-bar analytics-bar-returning">
              <title>{`${formatMonthLabel(point.key)}: ${point.returningDonors} recurrentes`}</title>
            </rect>
            <rect x={x} y={newY} width={barW} height={newHeight} className="analytics-bar analytics-bar-new">
              <title>{`${formatMonthLabel(point.key)}: ${point.newDonors} nuevos`}</title>
            </rect>
          </g>
        );
      })}
      <text x={PAD} y={12} className="analytics-legend analytics-legend-current">Nuevos</text>
      <text x={PAD + 60} y={12} className="analytics-legend analytics-legend-prior">Recurrentes</text>
    </svg>
  );
}

function GiftSplitChart({ data }: { data: ClientAnalytics["giving"]["giftSplit"] }) {
  const max = data.reduce((peak, point) => Math.max(peak, point.diezmoCents + point.ofrendaCents + point.otherCents), 0);
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const summary = "Reparto mensual entre diezmos y ofrendas (barras apiladas).";
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="analytics-svg" role="img" aria-label={summary}>
      <title>{summary}</title>
      <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} className="analytics-axis" />
      {data.map((point, index) => {
        const total = point.diezmoCents + point.ofrendaCents + point.otherCents;
        const totalHeight = max > 0 ? innerH * (total / max) : 0;
        const diezmoHeight = total > 0 ? totalHeight * (point.diezmoCents / total) : 0;
        const ofrendaHeight = total > 0 ? totalHeight * (point.ofrendaCents / total) : 0;
        const x = PAD + index * (innerW / data.length) + 1;
        const barW = Math.max(Math.min(innerW / data.length - 3, 26), 2);
        const diezmoY = PAD + innerH - diezmoHeight;
        const ofrendaY = diezmoY - ofrendaHeight;
        return (
          <g key={point.key}>
            <rect x={x} y={diezmoY} width={barW} height={diezmoHeight} className="analytics-bar analytics-bar-diezmo">
              <title>{`${formatMonthLabel(point.key)}: diezmo ${formatCentsUsd(point.diezmoCents)}`}</title>
            </rect>
            <rect x={x} y={ofrendaY} width={barW} height={ofrendaHeight} className="analytics-bar analytics-bar-ofrenda">
              <title>{`${formatMonthLabel(point.key)}: ofrenda ${formatCentsUsd(point.ofrendaCents)}`}</title>
            </rect>
          </g>
        );
      })}
      <text x={PAD} y={12} className="analytics-legend analytics-legend-current">Diezmo</text>
      <text x={PAD + 55} y={12} className="analytics-legend analytics-legend-prior">Ofrenda</text>
    </svg>
  );
}

function EmailDeliverabilityChart({ data }: { data: ClientAnalytics["email"]["weekly"] }) {
  const max = data.reduce((peak, point) => Math.max(peak, point.sent + point.failed), 0);
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const summary = "Correos enviados y fallidos por semana.";
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="analytics-svg" role="img" aria-label={summary}>
      <title>{summary}</title>
      <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} className="analytics-axis" />
      {data.map((point, index) => {
        const total = point.sent + point.failed;
        const totalHeight = max > 0 ? innerH * (total / max) : 0;
        const sentHeight = total > 0 ? totalHeight * (point.sent / total) : 0;
        const failedHeight = totalHeight - sentHeight;
        const x = PAD + index * (innerW / data.length) + 1;
        const barW = Math.max(Math.min(innerW / data.length - 3, 26), 2);
        const sentY = PAD + innerH - sentHeight;
        const failedY = sentY - failedHeight;
        return (
          <g key={point.key}>
            <rect x={x} y={sentY} width={barW} height={sentHeight} className="analytics-bar analytics-bar-ok">
              <title>{`${formatWeekLabel(point.key)}: ${point.sent} enviados`}</title>
            </rect>
            <rect x={x} y={failedY} width={barW} height={failedHeight} className="analytics-bar analytics-bar-danger">
              <title>{`${formatWeekLabel(point.key)}: ${point.failed} fallidos`}</title>
            </rect>
          </g>
        );
      })}
      <text x={PAD} y={12} className="analytics-legend analytics-legend-ok">Enviados</text>
      <text x={PAD + 60} y={12} className="analytics-legend analytics-legend-danger">Fallidos</text>
    </svg>
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
      {analytics.geography.foreign.length > 0 && <GeoBucketBars title="Extranjero" buckets={analytics.geography.foreign} />}
    </div>
  );
}

function GeoBucketBars({ title, buckets }: { title: string; buckets: ClientAnalytics["geography"]["departments"] }) {
  const max = buckets.reduce((peak, bucket) => Math.max(peak, bucket.totalCents), 0);
  return (
    <div className="analytics-geo-block">
      <h4 className="analytics-geo-title">{title}</h4>
      <ul className="analytics-geo-list" aria-label={`Distribución por ${title.toLowerCase()}.`}>
        {buckets.slice(0, 10).map((bucket) => (
          <li key={bucket.code}>
            <span className="analytics-geo-label" title={bucket.label}>
              {bucket.label}
            </span>
            <span className="analytics-geo-track">
              <span className="analytics-geo-bar" style={{ width: `${max > 0 ? (bucket.totalCents / max) * 100 : 0}%` }} />
            </span>
            <span className="analytics-geo-value">{formatCentsUsd(bucket.totalCents)}</span>
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
              <td className="numeric">{cohort.size}</td>
              {offsets.map((offset) => {
                const value = cohort.retention[offset] ?? 0;
                return (
                  <td
                    key={offset}
                    className="numeric analytics-cohort-cell"
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
                return (
                  <td
                    key={hour}
                    className="analytics-heatmap-cell"
                    style={{ backgroundColor: count > 0 ? `color-mix(in srgb, var(--accent) ${intensity}%, var(--surface))` : undefined }}
                    title={`${label} ${hour}:00 — ${count} donaciones`}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
