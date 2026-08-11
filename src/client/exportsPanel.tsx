import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  FileSpreadsheet,
  ShieldCheck,
  Upload,
  Users
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BackupMonth,
  BackupVerifyResult,
  DonationIntentListItem,
  EmissionEnvironmentState
} from "./types";
import { openNativeDatePicker } from "./datePicker";
import { donationIntentStatusLabel, environmentLabel } from "./displayText";
import { formatCents } from "../shared/money";
import {
  addMonths,
  type AnnualCertificatePreview,
  type AnnualCertificatePreviewDonor,
  calendarDays,
  type F960Preview,
  type F960PreviewRow,
  formatDateTime,
  formatDateValue,
  monthLabel,
  monthStart,
  shortCode
} from "./App";
import { StackedCell } from "./documentsView";

export function ExportPanel({
  startDate,
  endDate,
  preview,
  busy,
  onStartDateChange,
  onEndDateChange,
  onDownload
}: {
  startDate: string;
  endDate: string;
  preview: F960Preview;
  busy: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onDownload: (format: "csv" | "xlsx") => Promise<void>;
}) {
  const startDateInput = useRef<HTMLInputElement>(null);
  const endDateInput = useRef<HTMLInputElement>(null);
  const [openPicker, setOpenPicker] = useState<"start" | "end" | null>(null);

  function openDateField(input: HTMLInputElement | null, field: "start" | "end"): void {
    if (!openNativeDatePicker(input)) {
      setOpenPicker(field);
    }
  }

  return (
    <section className="single-panel export-panel">
      <div className="panel-head">
        <div>
          <h2>F960</h2>
          <p>Documentos aceptados del periodo.</p>
        </div>
        <FileSpreadsheet size={20} />
      </div>
      <div className="export-controls">
        <label className="date-field" onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            setOpenPicker(null);
          }
        }}>
          <span>Desde</span>
          <input
            ref={startDateInput}
            value={startDate}
            onChange={(event) => onStartDateChange(event.target.value)}
            onClick={() => openDateField(startDateInput.current, "start")}
            type="date"
          />
          {openPicker === "start" && (
            <DatePickerCalendar
              value={startDate}
              onSelect={onStartDateChange}
              onClose={() => setOpenPicker(null)}
            />
          )}
        </label>
        <label className="date-field" onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            setOpenPicker(null);
          }
        }}>
          <span>Hasta</span>
          <input
            ref={endDateInput}
            value={endDate}
            onChange={(event) => onEndDateChange(event.target.value)}
            onClick={() => openDateField(endDateInput.current, "end")}
            type="date"
          />
          {openPicker === "end" && (
            <DatePickerCalendar
              value={endDate}
              onSelect={onEndDateChange}
              onClose={() => setOpenPicker(null)}
            />
          )}
        </label>
        <button className="primary" disabled={busy === "export-csv"} onClick={() => void onDownload("csv")}>
          <Download size={16} />
          {busy === "export-csv" ? "Preparando" : "Descargar CSV"}
        </button>
        <button disabled={busy === "export-xlsx"} onClick={() => void onDownload("xlsx")}>
          <FileSpreadsheet size={16} />
          {busy === "export-xlsx" ? "Preparando" : "XLSX de inspección"}
        </button>
      </div>
      <div className="export-summary">
        <strong>{preview.rowCount}</strong>
        <span>registros</span>
        <strong>${preview.amountTotal}</strong>
        <span>total</span>
      </div>
      <F960PreviewTable rows={preview.rows} />
    </section>
  );
}

function DatePickerCalendar({
  value,
  onSelect,
  onClose
}: {
  value: string;
  onSelect: (date: string) => void;
  onClose: () => void;
}) {
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(value));
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);

  useEffect(() => {
    setVisibleMonth(monthStart(value));
  }, [value]);

  return (
    <div className="date-popover" role="dialog" aria-label="Seleccionar fecha" onMouseDown={(event) => event.preventDefault()}>
      <div className="date-popover-head">
        <button type="button" className="icon-button" onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))} title="Mes anterior">
          <ChevronLeft size={16} />
        </button>
        <strong>{monthLabel(visibleMonth)}</strong>
        <button type="button" className="icon-button" onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))} title="Mes siguiente">
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="date-grid date-weekdays">
        {["D", "L", "M", "M", "J", "V", "S"].map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div className="date-grid">
        {days.map((day, index) =>
          day ? (
            <button
              key={formatDateValue(day)}
              type="button"
              className={formatDateValue(day) === value ? "selected" : ""}
              onClick={() => {
                onSelect(formatDateValue(day));
                onClose();
              }}
            >
              {day.getUTCDate()}
            </button>
          ) : (
            <span key={`empty-${index}`} />
          )
        )}
      </div>
    </div>
  );
}

function F960PreviewTable({ rows }: { rows: F960PreviewRow[] }) {
  return (
    <div className="table-scroll export-table">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Donante</th>
            <th>Documento</th>
            <th className="numeric">Monto</th>
            <th>Periodo</th>
            <th>Código de generación</th>
            <th>Sello</th>
            <th>Control</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.codigoGeneracion}>
              <td className="numeric">{row.fechaEmision}</td>
              <td><StackedCell primary={row.nombre} secondary={row.correo} /></td>
              <td className="mono">{row.nit || row.dui || "—"}</td>
              <td className="numeric">${row.monto}</td>
              <td className="mono">{row.periodo}</td>
              <td className="mono">{shortCode(row.codigoGeneracion)}</td>
              <td className="mono">{shortCode(row.sello)}</td>
              <td className="mono">{row.numeroControl}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8}>Sin datos para este rango.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function certificateYearOptions(): number[] {
  const current = new Date().getFullYear();
  return [current, current - 1, current - 2, current - 3];
}

// CRM contacts export columns: the server's 11 snake_case headers with Spanish UI
// labels. `key` is what the endpoint's `columns` param expects; the checkbox group
// renders `label`. Order matches the CSV header order.
export const CONTACT_EXPORT_COLUMNS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "nombre", label: "Nombre" },
  { key: "correo", label: "Correo" },
  { key: "telefono", label: "Teléfono" },
  { key: "direccion", label: "Dirección" },
  { key: "departamento", label: "Departamento" },
  { key: "pais", label: "País" },
  { key: "primera_donacion", label: "Primera donación" },
  { key: "ultima_donacion", label: "Última donación" },
  { key: "total_donado_usd", label: "Total donado (US$)" },
  { key: "numero_donaciones", label: "Número de donaciones" },
  { key: "tipo_preferido", label: "Tipo preferido" }
];

export type ContactsPeriod = "todo" | "esteAno" | "anioAnterior" | "personalizado";

// Resolves a period preset into an optional {from, to} YYYY-MM-DD range. "todo" means no
// range (export everything). "Este año" / "Año anterior" are full calendar years; the
// custom preset uses the two date inputs verbatim.
export function contactsPeriodRange(period: ContactsPeriod, from: string, to: string): { from: string; to: string } | null {
  const year = new Date().getFullYear();
  if (period === "esteAno") {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  if (period === "anioAnterior") {
    return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
  if (period === "personalizado") {
    return { from, to };
  }
  return null;
}

// Preview endpoint path for a bounded recipient page. Search and continuation are
// independent inputs; changing the search starts again without `after`.
export function certificatePreviewPath(year: string, search: string, after?: string | null): string {
  const trimmed = search.trim();
  const searchParam = trimmed ? `&q=${encodeURIComponent(trimmed)}` : "";
  const afterParam = after ? `&after=${encodeURIComponent(after)}` : "";
  return `/api/certificates/annual?year=${year}${searchParam}${afterParam}`;
}

export function AnnualCertificatePanel({
  year,
  yearOptions,
  preview,
  search,
  busy,
  rowBusy,
  bulkTraversalStarted,
  bulkHasMore,
  onYearChange,
  onSearchChange,
  onSend,
  onSendDonor,
  onLoadMore,
  onResetBulk
}: {
  year: string;
  yearOptions: number[];
  preview: AnnualCertificatePreview | null;
  search: string;
  busy: boolean;
  // The raw busy key so a single row can show its own spinner (certificates-send-<groupKey>).
  rowBusy: string;
  bulkTraversalStarted: boolean;
  bulkHasMore: boolean;
  onYearChange: (year: string) => void;
  onSearchChange: (value: string) => void;
  onSend: () => Promise<void>;
  onSendDonor: (donor: AnnualCertificatePreviewDonor) => Promise<void>;
  onLoadMore: () => Promise<void>;
  onResetBulk: () => void;
}) {
  const donors = preview?.donors ?? [];
  // Certificate actions are serialized so a preview append cannot race a send refresh.
  const anySending = busy || rowBusy.startsWith("certificates-send") || rowBusy === "certificates-preview-more";
  const bulkComplete = bulkTraversalStarted && !bulkHasMore;
  return (
    <section className="single-panel export-panel">
      <div className="panel-head">
        <div>
          <h2>Constancia anual de donaciones</h2>
          <p>Envíe a cada donante el resumen de sus donaciones aceptadas del año.</p>
        </div>
        <FileSpreadsheet size={20} />
      </div>
      <div className="export-controls">
        <label className="date-field">
          <span>Año</span>
          <select value={year} onChange={(event) => onYearChange(event.target.value)}>
            {yearOptions.map((option) => (
              <option key={option} value={String(option)}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={anySending || bulkComplete} onClick={() => void onSend()}>
          <Download size={16} />
          {busy ? "Enviando" : bulkTraversalStarted ? "Enviar siguiente tanda" : "Enviar primera tanda"}
        </button>
        {bulkTraversalStarted && (
          <button className="ghost" disabled={anySending} onClick={onResetBulk}>
            Iniciar nuevo recorrido
          </button>
        )}
      </div>
      <p className="hint">
        Se enviará a los donantes con correo. Los donantes sin correo aparecen en la vista previa pero se omiten al enviar.
      </p>
      {bulkTraversalStarted && bulkHasMore && <p className="hint">Quedan donantes por procesar.</p>}
      <div className="certificate-search">
        <input
          type="search"
          value={search}
          placeholder="Buscar donante o correo"
          onChange={(event) => onSearchChange(event.target.value)}
          aria-label="Buscar donante o correo"
        />
      </div>
      <div className="table-scroll export-table certificate-table">
        <table>
          <thead>
            <tr>
              <th>Donante</th>
              <th className="numeric">Donaciones</th>
              <th className="numeric">Total</th>
              <th>Correo</th>
              <th>Enviar</th>
            </tr>
          </thead>
          <tbody>
            {donors.map((donor) => {
              const rowSending = rowBusy === `certificates-send-${donor.groupKey}`;
              return (
                <tr key={donor.groupKey}>
                  <td>
                    <StackedCell primary={donor.donorName} secondary={donor.donorEmail ?? ""} />
                  </td>
                  <td className="numeric">{donor.count}</td>
                  <td className="numeric">{donor.totalLabel}</td>
                  <td>{donor.hasEmail ? "Sí" : "—"}</td>
                  <td>
                    <button
                      className="ghost"
                      disabled={!donor.hasEmail || donor.dossierTooLarge || rowSending || anySending}
                      onClick={() => void onSendDonor(donor)}
                    >
                      <Download size={14} />
                      {rowSending ? "Enviando" : "Enviar"}
                    </button>
                    {donor.dossierTooLarge && (
                      <span className="hint">Demasiados comprobantes para una sola constancia</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {donors.length === 0 && (
              <tr>
                <td colSpan={5}>
                  {search.trim() ? "Ningún donante coincide con la búsqueda." : "Sin donaciones aceptadas para este año."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {preview?.hasMore && (
        <button
          className="ghost"
          disabled={anySending}
          onClick={() => void onLoadMore()}
        >
          {rowBusy === "certificates-preview-more" ? "Cargando" : "Ver más donantes"}
        </button>
      )}
    </section>
  );
}

// Bulk donor-contacts CSV export for CRM import. Exports the ACTIVE emission
// ambiente (the same ambiente in which donations are currently issued); the button
// stays disabled until the active ambiente is known. The period, tipo, and column
// controls customize which donations count and which columns the CSV carries.
export function ContactsExportPanel({
  environment,
  busy,
  period,
  from,
  to,
  giftType,
  columns,
  onPeriodChange,
  onFromChange,
  onToChange,
  onGiftTypeChange,
  onColumnToggle,
  onDownload
}: {
  environment: EmissionEnvironmentState["environment"] | null;
  busy: boolean;
  period: ContactsPeriod;
  from: string;
  to: string;
  giftType: "todos" | "DIEZMO" | "OFRENDA";
  columns: Set<string>;
  onPeriodChange: (period: ContactsPeriod) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onGiftTypeChange: (value: "todos" | "DIEZMO" | "OFRENDA") => void;
  onColumnToggle: (key: string) => void;
  onDownload: () => Promise<void>;
}) {
  const noColumns = columns.size === 0;
  const invalidRange = period === "personalizado" && (!from || !to || from > to);
  return (
    <section className="single-panel export-panel">
      <div className="panel-head">
        <div>
          <h2>Contactos para CRM</h2>
          <p>Exporte los datos de contacto de sus donantes para importarlos en su CRM.</p>
        </div>
        <Users size={20} />
      </div>
      <div className="export-controls">
        <label className="date-field">
          <span>Período</span>
          <select value={period} onChange={(event) => onPeriodChange(event.target.value as ContactsPeriod)}>
            <option value="todo">Todo el tiempo</option>
            <option value="esteAno">Este año</option>
            <option value="anioAnterior">Año anterior</option>
            <option value="personalizado">Personalizado</option>
          </select>
        </label>
        {period === "personalizado" && (
          <>
            <label className="date-field">
              <span>Desde</span>
              <input type="date" value={from} onChange={(event) => onFromChange(event.target.value)} />
            </label>
            <label className="date-field">
              <span>Hasta</span>
              <input type="date" value={to} onChange={(event) => onToChange(event.target.value)} />
            </label>
          </>
        )}
        <label className="date-field">
          <span>Tipo</span>
          <select value={giftType} onChange={(event) => onGiftTypeChange(event.target.value as "todos" | "DIEZMO" | "OFRENDA")}>
            <option value="todos">Todos</option>
            <option value="DIEZMO">Diezmo</option>
            <option value="OFRENDA">Ofrenda</option>
          </select>
        </label>
        <button className="primary" disabled={busy || !environment || noColumns || invalidRange} onClick={() => void onDownload()}>
          <Download size={16} />
          {busy ? "Preparando" : "Descargar contactos"}
        </button>
      </div>
      <fieldset className="contacts-columns">
        <legend>Columnas</legend>
        <div className="contacts-columns-grid">
          {CONTACT_EXPORT_COLUMNS.map((column) => (
            <label key={column.key} className="contacts-column-check">
              <input type="checkbox" checked={columns.has(column.key)} onChange={() => onColumnToggle(column.key)} />
              <span>{column.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {noColumns && <p className="hint contacts-columns-warning">Seleccione al menos una columna para exportar.</p>}
      {invalidRange && <p className="hint contacts-columns-warning">Revise el rango de fechas: «desde» no puede ser posterior a «hasta».</p>}
      <p className="hint">
        Se exportan los contactos del ambiente activo{environment ? ` (${environmentLabel(environment)})` : ""}.
      </p>
    </section>
  );
}

// Admin "Tipo" column label: Diezmo / Ofrenda / — for legacy and US-path intents.
function donationGiftTypeLabel(giftType: DonationIntentListItem["gift_type"]): string {
  if (giftType === "DIEZMO") {
    return "Diezmo";
  }
  if (giftType === "OFRENDA") {
    return "Ofrenda";
  }
  return "—";
}

export function OnlineDonationsPanel({ intents }: { intents: DonationIntentListItem[] }) {
  return (
    <section className="single-panel export-panel">
      <div className="panel-head">
        <div>
          <h2>Donaciones en línea</h2>
          <p>Últimas donaciones recibidas desde el formulario público de donación.</p>
        </div>
        <Cloud size={20} />
      </div>
      <div className="table-scroll export-table online-donations-table">
        <table>
          <thead>
            <tr>
              <th>Estado</th>
              <th>Tipo</th>
              <th className="numeric">Monto</th>
              <th>Donante</th>
              <th className="numeric">Fecha</th>
              <th>Número de control</th>
            </tr>
          </thead>
          <tbody>
            {intents.map((intent) => (
              <tr key={intent.id}>
                <td>
                  <span className={`status ${intent.status.toLowerCase()}`}>
                    {donationIntentStatusLabel(intent.status).toUpperCase()}
                  </span>
                </td>
                <td>{donationGiftTypeLabel(intent.gift_type)}</td>
                <td className="numeric">{formatCents(intent.amount_cents)}</td>
                <td>{intent.document_donor_name ?? "—"}</td>
                <td className="numeric">{formatDateTime(intent.created_at)}</td>
                <td className="mono">{intent.numero_control ?? "—"}</td>
              </tr>
            ))}
            {intents.length === 0 && (
              <tr>
                <td colSpan={6}>Sin donaciones en línea todavía.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BackupsPanel({
  months,
  verifyByMonth,
  busy,
  onVerify,
  onDownload,
  onDownloadAll,
  onExport
}: {
  months: BackupMonth[];
  verifyByMonth: Record<string, BackupVerifyResult>;
  busy: string;
  onVerify: (month: string) => Promise<void>;
  onDownload: (month: string, table: string) => Promise<void>;
  onDownloadAll: (month: string) => Promise<void>;
  onExport: (month: string) => Promise<void>;
}) {
  // Only closed months are expected to have a respaldo; en_curso is informational.
  const missing = months.filter((month) => month.status === "faltante").map((month) => month.month);
  const closedMonths = months.filter((month) => month.status !== "en_curso");
  const healthLine =
    missing.length === 0
      ? "Todos los meses cerrados están respaldados."
      : `Falta el respaldo de ${missing.join(", ")}.`;
  return (
    <section className="single-panel export-panel">
      <div className="panel-head">
        <div>
          <h2>Respaldos mensuales</h2>
          <p>Revise y verifique los respaldos legales mensuales guardados en R2.</p>
        </div>
        <ShieldCheck size={20} />
      </div>
      {closedMonths.length > 0 && (
        <p className={missing.length === 0 ? "backups-health ok" : "backups-health warn"}>{healthLine}</p>
      )}
      <div className="table-scroll export-table backups-table">
        <table>
          <thead>
            <tr>
              <th>Mes</th>
              <th>Estado</th>
              <th className="numeric">Filas</th>
              <th>Exportado el</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month) => {
              const verify = verifyByMonth[month.month];
              const rowFailed = verify ? !verify.ok : false;
              return (
                <tr key={month.month} className={rowFailed ? "backup-row-failed" : ""}>
                  <td className="mono">{month.month}</td>
                  <td>{backupStatusLabel(month.status)}</td>
                  <td className="numeric">{month.totalRows ?? "—"}</td>
                  <td>{month.exportedAt ? formatDateTime(month.exportedAt) : "—"}</td>
                  <td>
                    {month.status === "archivado" && (
                      <div className="backup-actions">
                        <button className="ghost" disabled={busy === `backup-verify-${month.month}`} onClick={() => void onVerify(month.month)}>
                          {busy === `backup-verify-${month.month}` ? "Verificando" : "Verificar"}
                        </button>
                        <select
                          aria-label={`Descargar tabla de ${month.month}`}
                          value=""
                          onChange={(event) => {
                            const table = event.target.value;
                            if (table) {
                              void onDownload(month.month, table);
                              event.target.value = "";
                            }
                          }}
                        >
                          <option value="">Descargar…</option>
                          <option value="manifest">manifest</option>
                          {month.tables.map((table) => (
                            <option key={table} value={table}>
                              {table}
                            </option>
                          ))}
                        </select>
                        <button
                          className="ghost"
                          disabled={busy === `backup-download-all-${month.month}`}
                          onClick={() => void onDownloadAll(month.month)}
                        >
                          <Download size={14} />
                          {busy === `backup-download-all-${month.month}` ? "Descargando" : "Descargar todo"}
                        </button>
                        {verify && (
                          <span className={verify.ok ? "backup-verify-ok" : "backup-verify-fail"}>
                            {verify.ok
                              ? "Íntegro"
                              : `Discrepancia: ${verify.files.filter((file) => !file.ok).map((file) => file.table).join(", ")}`}
                          </span>
                        )}
                      </div>
                    )}
                    {month.status === "faltante" && (
                      <button className="primary" disabled={busy === `backup-export-${month.month}`} onClick={() => void onExport(month.month)}>
                        <Upload size={16} />
                        {busy === `backup-export-${month.month}` ? "Exportando" : "Exportar mes"}
                      </button>
                    )}
                    {month.status === "en_curso" && <span className="hint">Mes en curso</span>}
                  </td>
                </tr>
              );
            })}
            {closedMonths.length === 0 && (
              <tr>
                <td colSpan={5}>Aún no hay meses cerrados para respaldar.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function backupStatusLabel(status: BackupMonth["status"]): string {
  if (status === "archivado") return "Archivado ✓";
  if (status === "faltante") return "Faltante ⚠";
  return "En curso —";
}
