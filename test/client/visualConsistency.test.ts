import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/exportsPanel.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/documentsView.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("visual consistency pack", () => {
  it("right-aligns MONTO headers alongside their numeric cells", () => {
    const monthHeaderMatches = appSource.match(/<th[^>]*>Monto<\/th>/g) ?? [];
    expect(monthHeaderMatches.length).toBeGreaterThanOrEqual(3);
    for (const match of monthHeaderMatches) {
      expect(match).toBe('<th className="numeric">Monto</th>');
    }
    expect(stylesSource).toMatch(/td\.numeric,\s*th\.numeric\s*\{\s*text-align:\s*right;\s*\}/);
  });

  it("gives table headers tighter letter spacing while keeping uppercase and color", () => {
    const thRuleMatch = stylesSource.match(/^th \{[^}]*\}/m);
    expect(thRuleMatch).not.toBeNull();
    const thRule = thRuleMatch?.[0] ?? "";
    expect(thRule).toContain("font-size: 12px;");
    expect(thRule).toContain("letter-spacing: 0.04em;");
    expect(thRule).toContain("text-transform: uppercase;");
    // The reskin routes the muted table-header ink through the shared neutral gray
    // variable instead of the retired teal-gray literal; the label style is unchanged.
    expect(thRule).toContain("color: var(--ink-muted);");
  });

  it("makes the combined failure and rejection total explicit and filterable", () => {
    expect(appSource).not.toContain("en esta vista");
    expect(appSource).toContain('<p className="stats-caption">Totales de la vista actual.</p>');
    expect(appSource).toContain('<Metric label="Aceptados"');
    expect(appSource).toContain('<Metric label="Fallos y rechazos"');
    expect(appSource).toContain('<option value={FAILURE_VIEW_STATUSES}>Fallos/rechazos</option>');
    expect(appSource).toContain('<option value="REJECTED">Rechazados</option>');
    expect(appSource).toContain('<option value="FAILED">Fallidos</option>');
    // "En trámite" = transmisión diferida (TRANSMISSION_PENDING), replacing the
    // removed contingency metric; matches the status badge wording.
    expect(appSource).toContain('<Metric label="En trámite"');
    expect(appSource).toContain('<Metric label="Invalidados"');
    expect(stylesSource).toContain(".stats-caption");
  });

  it("keeps pre-CDE failures above and separate from legal DTE rows", () => {
    const panelRenderIndex = appSource.indexOf("<PreCdeFailuresPanel");
    const statsRenderIndex = appSource.indexOf("<Stats documents={documents}");
    const tableRenderIndex = appSource.indexOf("<DocumentTable");

    expect(appSource).toContain("isPreCdeRetryInFlight");
    expect(panelRenderIndex).toBeGreaterThan(-1);
    expect(panelRenderIndex).toBeLessThan(statsRenderIndex);
    expect(panelRenderIndex).toBeLessThan(tableRenderIndex);
    expect(appSource).toContain("preCdeFailureCount={visiblePreCdeFailures.length}");
    expect(appSource).toContain("Sin CDE emitidos fallidos o rechazados");
  });

  it("guards async pre-CDE commits and invalidates every clearing path", () => {
    const fetchBlock = appSource.match(/async function fetchPreCdeFailures\(\) \{[\s\S]*?\n  \}\n\n  async function refresh/)?.[0] ?? "";
    const clearBlock = appSource.match(/function clearPreCdeFailures\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const resetBlock = appSource.match(/function resetAccountState\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const changeViewBlock = appSource.match(/function changeView\(nextView: View\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const logoutBlock = appSource.match(/function logout\(\) \{[\s\S]*?\n  \}\n\n  async function retryPreCdeFailure/)?.[0] ?? "";
    const expireBlock = appSource.match(/function expireSession\(\) \{[\s\S]*?\n  \}\n\n  function toggleSidebar/)?.[0] ?? "";

    expect(appSource).toContain("isPreCdeRetryInFlight");
    expect(fetchBlock).toContain("const request = preCdeFailureRequests.current.start();");
    expect(fetchBlock.match(/request\.commit/g)).toHaveLength(3);
    expect(fetchBlock).toContain("setPreCdeFailuresLoading(true);");
    expect(fetchBlock.match(/setPreCdeFailuresLoading\(false\)/g)).toHaveLength(2);
    expect(clearBlock.indexOf("preCdeFailureRequests.current.invalidate();")).toBeGreaterThan(-1);
    expect(clearBlock.indexOf("preCdeFailureRequests.current.invalidate();")).toBeLessThan(clearBlock.indexOf("setPreCdeFailures([]);"));
    expect(clearBlock).toContain("setPreCdeFailuresLoading(false);");
    expect(changeViewBlock).toContain('if (nextView !== "failures")');
    expect(changeViewBlock).toContain("clearPreCdeFailures();");
    expect(changeViewBlock).toContain('if (nextView === "failures" && view !== "failures")');
    expect(changeViewBlock).toContain("setPreCdeFailuresLoading(true);");
    expect(appSource).toContain('onClick={() => changeView(item.id)}');
    expect(resetBlock).toContain("clearPreCdeFailures();");
    expect(logoutBlock).toContain("resetAccountState();");
    expect(expireBlock).toContain("resetAccountState();");
  });

  it("shows an honest pre-CDE loading state before Fallos can say everything is fine", () => {
    const panelBlock = appSource.match(/function PreCdeFailuresPanel\([\s\S]*?\n}\n\nexport function Stats/)?.[0] ?? "";

    expect(appSource).toContain("const [preCdeFailuresLoading, setPreCdeFailuresLoading] = useState(false);");
    expect(appSource).toContain("loading={preCdeFailuresLoading}");
    expect(panelBlock).toContain("loading: boolean;");
    expect(panelBlock).toContain('aria-busy={loading}');
    expect(panelBlock).toContain('role="status"');
    expect(panelBlock).toContain("Revisando pagos sin CDE creado…");
    expect(appSource).toContain('documentListEmptyMessage(view === "failures" ? "failures" : "documents", query, preCdeFailuresLoading)');
  });

  it("renders exact pre-CDE evidence with guarded correction and safe retry states", () => {
    const panelBlock = appSource.match(/function PreCdeFailuresPanel\([\s\S]*?\n}\n\nexport function Stats/)?.[0] ?? "";

    expect(panelBlock).toContain('<span className="status pre-cde">CDE NO CREADO</span>');
    expect(panelBlock).toContain('<strong>{item.donor_name ?? "Donante sin nombre"}</strong>');
    expect(panelBlock).toContain('<span>${(item.amount_cents / 100).toFixed(2)}</span>');
    expect(panelBlock).toContain('<span>Intentos: {item.issuance_attempt_count}</span>');
    expect(panelBlock).toContain('<p>{item.issuance_error_message}</p>');
    expect(panelBlock).toContain('`Número reservado: ${item.reserved_numero_control}`');
    expect(panelBlock).toContain('"Número aún no asignado"');
    expect(panelBlock).toContain("isPreCdeRetryInFlight(item)");
    expect(panelBlock).toContain("{canRetry && (");
    expect(panelBlock).toContain("isCorrectablePreCdeFailure(item)");
    expect(panelBlock).toContain("preCdeActionLabel(item, correctable, reviewRequired)");
    expect(panelBlock).toContain("disabled={reviewRequired || retryQueued || actionBusy}");

    for (const forbiddenAction of ["PDF", "JSON", "Sello", "Invalidar", "DetailPanel", "onDownload", "documentAction"]) {
      expect(panelBlock).not.toContain(forbiddenAction);
    }
  });

  it("renders donor email and payment-received time on pre-CDE cards", () => {
    const panelBlock = appSource.match(/function PreCdeFailuresPanel\([\s\S]*?\n}\n\nexport function Stats/)?.[0] ?? "";

    expect(panelBlock).toContain('<span>{item.donor_email ?? "Correo no disponible"}</span>');
    expect(panelBlock).toContain('<span>Pago recibido: {formatDateTime(item.received_at)}</span>');
  });

  it("uses a responsive dashed danger boundary for pre-CDE cards", () => {
    const panelRule = stylesSource.match(/\.pre-cde-failures \{[^}]*\}/)?.[0] ?? "";
    const gridRule = stylesSource.match(/\.pre-cde-failure-grid \{[^}]*\}/)?.[0] ?? "";
    const cardRule = stylesSource.match(/\.pre-cde-failure-card \{[^}]*\}/)?.[0] ?? "";
    const mobileGridRule = stylesSource.match(/@media \(max-width: 720px\) \{[\s\S]*?\.pre-cde-failure-grid \{[^}]*\}/)?.[0] ?? "";

    expect(panelRule).toContain("border: 1px dashed var(--danger-border);");
    expect(panelRule).toContain("background: var(--danger-tint);");
    expect(gridRule).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(cardRule).toContain("overflow-wrap: anywhere;");
    expect(mobileGridRule).toContain("grid-template-columns: 1fr;");
  });

  it("collapses the JSON DTE preview into a closed-by-default details element", () => {
    expect(appSource).toContain('<details className="json-details">');
    expect(appSource).toContain("<summary>Ver JSON completo</summary>");
    expect(appSource).not.toMatch(/<details className="json-details" open/);
    const detailsMatch = appSource.match(/<details className="json-details">([\s\S]*?)<\/details>/);
    expect(detailsMatch).not.toBeNull();
    const detailsBlock = detailsMatch?.[0] ?? "";
    expect(detailsBlock).toContain("<summary>Ver JSON completo</summary>");
    expect(detailsBlock).toContain("JSON DTE");
    expect(detailsBlock).toContain("<pre>{JSON.stringify(plain, null, 2)}</pre>");
  });

  it("places readable rejection evidence immediately above the JSON disclosure", () => {
    expect(appSource).toContain('import { rejectionDetailForDocument } from "./rejectionDetail";');
    expect(appSource).toContain('className="rejection-detail"');
    expect(appSource).toContain("Detalle del rechazo");
    expect(appSource).toContain("Motivo");
    expect(appSource).toContain("Fecha y hora");
    expect(appSource.indexOf('className="rejection-detail"')).toBeLessThan(appSource.indexOf('<details className="json-details">'));
    expect(stylesSource).toMatch(/\.rejection-detail \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?\}/);
    expect(stylesSource).toContain("background: var(--danger-tint);");
    expect(stylesSource).toContain("border: 1px solid var(--danger-border);");
  });

  it("keeps the document detail email row compact and aligned", () => {
    expect(appSource).toContain('<dt className="detail-email-label">Correo de envío</dt>');
    expect(appSource).toContain('<dd className="detail-email-value">');
    expect(stylesSource).toContain("margin: 12px 0 10px;");
    expect(stylesSource).toMatch(/\.detail-email-label,\s*\.detail-email-value\s*\{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 1\.35;[\s\S]*?\}/);
    expect(stylesSource).toMatch(/\.detail-email-value \.editable-readonly > span \{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 1\.35;[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
  });

  it("renames the credentials nav label to Configuración while keeping the subtitle and id", () => {
    expect(appSource).toContain('{ id: "credentials", label: "Configuración", icon: Settings, minRole: "OWNER" }');
    expect(appSource).not.toMatch(/label: "Credenciales", icon: Settings/);
    expect(appSource).toContain('credentials: "Credenciales del Ministerio de Hacienda, Wompi y correo."');
  });

  it("uses distinct document icons for Contingencia and Auditoría", () => {
    expect(appSource).toContain("Unplug,");
    expect(appSource).toContain("ScrollText,");
    expect(appSource).toContain('{ id: "contingency", label: "Contingencia", icon: Unplug }');
    expect(appSource).toContain('{ id: "audit", label: "Auditoría", icon: ScrollText }');
    expect(appSource).not.toContain('{ id: "contingency", label: "Contingencia", icon: FileArchive }');
    expect(appSource).not.toContain('{ id: "contingency", label: "Contingencia", icon: Clock }');
    expect(appSource).not.toContain('{ id: "audit", label: "Auditoría", icon: History }');
  });

  it("sizes the app shell grid row to the viewport so short views keep a full-height sidebar", () => {
    const shellRule = stylesSource.match(/\.app-shell \{[^}]*\}/)?.[0] ?? "";
    const stackedShellRule = stylesSource.match(/@media \(max-width: 1020px\) \{[\s\S]*?\.app-shell,[\s\S]*?\.app-shell\.sidebar-collapsed \{[^}]*\}/)?.[0] ?? "";

    expect(shellRule).toContain("grid-template-columns: 272px minmax(0, 1fr);");
    expect(shellRule).toContain("grid-template-rows: minmax(100vh, auto);");
    expect(stackedShellRule).toContain("grid-template-rows: auto minmax(0, 1fr);");
  });

  it("gives the expanded desktop sidebar breathing room without changing mobile", () => {
    const expandedSidebarRule = stylesSource.match(/\.app-shell:not\(\.sidebar-collapsed\) \.sidebar \{[^}]*\}/)?.[0] ?? "";
    const mobileExpandedSidebarRule = stylesSource.match(
      /@media \(max-width: 1020px\) \{[\s\S]*?\.app-shell:not\(\.sidebar-collapsed\) \.sidebar \{[^}]*\}/
    )?.[0] ?? "";

    expect(expandedSidebarRule).toContain("margin-right: 35px;");
    expect(mobileExpandedSidebarRule).toContain("margin-right: 0;");
  });

  it("uses symmetrical fade cues on the mobile sidebar nav overflow", () => {
    const mobileSidebarNavRule = stylesSource.match(/@media \(max-width: 1020px\) \{[\s\S]*?\.sidebar nav \{[^}]*\}/)?.[0] ?? "";

    expect(mobileSidebarNavRule).toContain("linear-gradient(to right, transparent, black 8%, black 92%, transparent)");
  });

  it("uses semantic green and yellow accents for shared admin metrics", () => {
    const okMetricRule = stylesSource.match(/\.metric\.ok \{[^}]*\}/)?.[0] ?? "";
    const warnMetricRule = stylesSource.match(/\.metric\.warn \{[^}]*\}/)?.[0] ?? "";
    const warnAnalyticsBarRule = stylesSource.match(/\.analytics-bar-warn \{[^}]*\}/)?.[0] ?? "";

    expect(okMetricRule).toContain("border-left-color: var(--ok);");
    expect(okMetricRule).not.toContain("var(--accent");
    expect(warnMetricRule).toContain("border-left-color: var(--warn-accent);");
    expect(warnAnalyticsBarRule).toContain("fill: var(--warn-accent);");
  });

  it("keeps the detail-panel status badge compact and visually distinct", () => {
    const detailStatusRule = stylesSource.match(/\.detail-head \.status \{[^}]*\}/)?.[0] ?? "";
    const detailStatusDotRule = stylesSource.match(/\.detail-head \.status::before \{[^}]*\}/)?.[0] ?? "";
    const detailAcceptedRule = stylesSource.match(/\.detail-head \.status\.accepted,[\s\S]*?\.detail-head \.status\.event_accepted \{[^}]*\}/)?.[0] ?? "";

    expect(detailStatusRule).toContain("justify-self: start;");
    expect(detailStatusRule).toContain("width: fit-content;");
    expect(detailStatusRule).toContain("border: 1px solid var(--line-strong);");
    expect(detailStatusRule).toContain("border-radius: 6px;");
    expect(detailStatusDotRule).toContain('content: ""');
    expect(detailStatusDotRule).toContain("background: currentColor;");
    expect(detailAcceptedRule).toContain("border-color: var(--ok-border);");
  });

  it("keeps Contingencia focused on the current 15-minute retry rule instead of an empty archive", () => {
    expect(appSource).toContain("<h2>El CDE no usa modo de contingencia</h2>");
    expect(appSource).toContain("queda");
    expect(appSource).toContain("«En trámite»");
    expect(appSource).toContain("Correo transitorio inmediato");
    expect(appSource).toContain("Reintento cada 15 minutos");
    expect(appSource).toContain("Sello de Recepción");
    expect(appSource).toContain("Use <b>Documentos</b> con el filtro <b>En trámite</b>");
    expect(stylesSource).toContain(".contingency-flow");
    expect(stylesSource).toContain("repeat(auto-fit, minmax(220px, 1fr))");
    expect(appSource).not.toContain("/api/contingency");
    expect(appSource).not.toContain("contingency-stats");
    expect(appSource).not.toContain("CDE históricos sin sello");
    expect(appSource).not.toContain("Lotes históricos del Ministerio de Hacienda");
    expect(appSource).not.toContain("Eventos históricos del Ministerio de Hacienda");
    expect(appSource).not.toContain("Auditoría histórica");
    expect(stylesSource).not.toContain(".contingency-stats");
    expect(stylesSource).not.toContain(".contingency-audit-list");
    expect(stylesSource).not.toContain(".batch-line-list");
    expect(appSource).toContain('<option value="CONTINGENCY_PENDING">Histórico sin sello</option>');
    expect(appSource).not.toContain("bajo el modelo anterior");
    expect(appSource).not.toContain("No hay CDE pendientes de contingencia.");
    expect(appSource).not.toContain("periodo activo");
  });
});
