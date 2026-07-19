import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  Mail,
  Pencil,
  RotateCcw,
  ShieldCheck,
  X
} from "lucide-react";
import { useRef } from "react";
import type {
  AuditRow,
  DteDocument,
  FiscalCorrectionData,
  FiscalReconciliationState,
  ReceiptEmailDeliveryState,
  WompiIssuanceFailureItem
} from "./types";
import { isPreCdeRetryInFlight, preCdeActionLabel } from "./preCdeFailures";
import { invalidationFormValidationMessage, type InvalidationFormInput } from "./invalidationForm";
import { documentDisplayStatus, environmentLabel } from "./displayText";
import { invalidationWindowInfo } from "./invalidationWindow";
import { rejectionDetailForDocument } from "./rejectionDetail";
import { formatCents } from "../shared/money";
import {
  fiscalCorrectionStatusLabel,
  isCorrectablePreCdeFailure,
  isReviewRequiredPreCdeFailure
} from "./fiscalCorrectionDialog";
import { formatElSalvadorDate, formatElSalvadorDateTime } from "../shared/legalWindows";
import {
  countByStatus,
  type FiscalCorrectionTarget,
  formatDateTime,
  isCorrectionReconciliationDocument,
  isRetryableDocument,
  receiptEmailFailureGuidance,
  shortCode,
  StatusPill,
  useDialogDismiss
} from "./App";

export function PreCdeFailuresPanel({
  items,
  error,
  loading,
  busy,
  canRetry,
  onRetry,
  onCorrect
}: {
  items: WompiIssuanceFailureItem[];
  error: string;
  loading: boolean;
  busy: string;
  canRetry: boolean;
  onRetry: (id: string) => Promise<void>;
  onCorrect: (item: WompiIssuanceFailureItem) => Promise<void>;
}) {
  if (items.length === 0 && !error && !loading) {
    return null;
  }

  return (
    <section className="pre-cde-failures" aria-labelledby="pre-cde-failures-title" aria-busy={loading}>
      <div className="pre-cde-failures-heading">
        <h2 id="pre-cde-failures-title">Pagos sin CDE creado</h2>
        <p>Estos registros todavía no son comprobantes emitidos.</p>
      </div>
      {loading && <p className="pre-cde-failure-loading" role="status">Revisando pagos sin CDE creado…</p>}
      {error && <p className="error pre-cde-failure-error" role="alert">{error}</p>}
      {items.length > 0 && (
        <div className="pre-cde-failure-grid">
          {items.map((item) => {
            const retryQueued = isPreCdeRetryInFlight(item);
            const correctable = isCorrectablePreCdeFailure(item);
            const reviewRequired = isReviewRequiredPreCdeFailure(item);
            const actionLabel = preCdeActionLabel(item, correctable, reviewRequired);
            const actionBusy = reviewRequired
              ? false
              : correctable
                ? busy === `fiscal-correction-load:WOMPI_EVENT:${item.id}`
                : busy === `pre-cde-retry:${item.id}`;
            return (
              <article className="pre-cde-failure-card" key={item.id}>
                <span className="status pre-cde">CDE NO CREADO</span>
                <strong>{item.donor_name ?? "Donante sin nombre"}</strong>
                <span>{item.donor_email ?? "Correo no disponible"}</span>
                <div className="pre-cde-failure-meta">
                  <span>{formatCents(item.amount_cents)}</span>
                  <span>Pago recibido: {formatDateTime(item.received_at)}</span>
                  <span>Intentos: {item.issuance_attempt_count}</span>
                </div>
                <p>{item.issuance_error_message}</p>
                <span>
                  {item.reserved_numero_control
                    ? `Número reservado: ${item.reserved_numero_control}`
                    : "Número aún no asignado"}
                </span>
                {canRetry && (
                  <button
                    type="button"
                    disabled={reviewRequired || retryQueued || actionBusy}
                    onClick={() => {
                      if (reviewRequired) return;
                      if (correctable) void onCorrect(item);
                      else void onRetry(item.id);
                    }}
                  >
                    {actionLabel}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Stats({
  documents,
  onlyFailed,
  preCdeFailureCount = 0
}: {
  documents: DteDocument[];
  onlyFailed?: boolean;
  preCdeFailureCount?: number;
}) {
  const counts = countByStatus(documents);
  const receiptAttentionCount = documents.filter(
    (document) =>
      document.status === "ACCEPTED" &&
      (
        document.receipt_email_status === "FAILED" ||
        document.receipt_email_requires_review === 1
      )
  ).length;
  const failureAttentionCount = onlyFailed
    ? documents.length + preCdeFailureCount
    : (counts.FAILED ?? 0) + (counts.REJECTED ?? 0) + receiptAttentionCount + preCdeFailureCount;
  const fallidos = <Metric label="Fallos y rechazos" value={failureAttentionCount} tone="bad" />;
  if (onlyFailed) {
    return (
      <>
        <p className="stats-caption">Totales de la vista actual.</p>
        <div className="stats single">{fallidos}</div>
      </>
    );
  }
  return (
    <>
      <p className="stats-caption">Totales de la vista actual.</p>
      <div className="stats">
        <Metric label="Aceptados" value={counts.ACCEPTED ?? 0} tone="ok" />
        {fallidos}
        <Metric label="En trámite" value={counts.TRANSMISSION_PENDING ?? 0} tone="warn" />
        <Metric label="Invalidados" value={counts.INVALIDATED ?? 0} tone="neutral" />
      </div>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "ok" | "bad" | "warn" | "neutral" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function DocumentTable({
  documents,
  selectedId,
  showCorrectionAttention = false,
  onSelect
}: {
  documents: DteDocument[];
  selectedId?: string;
  showCorrectionAttention?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Estado</th>
            <th>Código</th>
            <th>Donante</th>
            <th className="numeric">Monto</th>
            <th>Sello</th>
            <th>Fecha</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id} className={selectedId === document.id ? "selected" : ""} onClick={() => onSelect(document.id)}>
              <td>
                <span className="document-status-stack">
                  <StatusPill status={documentDisplayStatus(document)} />
                  {(document.receipt_email_status === "FAILED" || document.receipt_email_requires_review === 1) && (
                    <span className="receipt-email-failure">
                      {document.receipt_email_requires_review === 1
                        ? "Correo por revisar"
                        : "Correo fallido"}
                    </span>
                  )}
                  {showCorrectionAttention && isCorrectionReconciliationDocument(document) && (
                    <span className="receipt-email-failure">Corrección por conciliar</span>
                  )}
                </span>
              </td>
              <td className="mono">{shortCode(document.codigo_generacion)}</td>
              <td><StackedCell primary={document.donor_name ?? "—"} secondary={document.donor_email ?? ""} /></td>
              <td className="numeric">{formatCents(document.amount_cents)}</td>
              <td className="mono">{document.sello_recibido ? shortCode(document.sello_recibido) : "—"}</td>
              <td className="numeric">{formatElSalvadorDate(document.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocumentListFooter({
  count,
  hasMore,
  loading,
  onLoadMore,
  emptyMessage
}: {
  count: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => Promise<void>;
  emptyMessage: string;
}) {
  return (
    <div className="document-list-footer">
      <span>{count > 0 ? `Mostrando ${count} CDE` : emptyMessage}</span>
      {hasMore && (
        <button type="button" onClick={() => void onLoadMore()} disabled={loading}>
          <ChevronRight size={16} />
          {loading ? "Cargando" : "Cargar más"}
        </button>
      )}
    </div>
  );
}

export function StackedCell({ primary, secondary }: { primary: string; secondary?: string | null }) {
  return (
    <span className="stacked-cell">
      <span>{primary}</span>
      {secondary && <span className="secondary">{secondary}</span>}
    </span>
  );
}

export function DetailPanel({
  selected,
  audit,
  receiptEmailDelivery,
  fiscalReconciliation,
  fiscalCorrectionData,
  donorDataVerified,
  busy,
  now,
  onAction,
  canCorrect,
  onCorrect,
  onInvalidateRequest,
  onDownload,
  emailEditingId,
  emailDraft,
  onStartEmailEdit,
  onEmailDraftChange,
  onCancelEmailEdit,
  onSaveEmail
}: {
  selected?: DteDocument;
  audit: AuditRow[];
  receiptEmailDelivery?: ReceiptEmailDeliveryState | null;
  fiscalReconciliation?: FiscalReconciliationState | null;
  fiscalCorrectionData?: FiscalCorrectionData | null;
  donorDataVerified?: boolean;
  busy: string;
  now: Date;
  onAction: (action: "resend" | "retry" | "invalidate") => void;
  canCorrect: boolean;
  onCorrect: (target: FiscalCorrectionTarget) => void;
  onInvalidateRequest: (id: string) => void;
  onDownload: (format: "pdf" | "json") => void;
  emailEditingId: string | null;
  emailDraft: string;
  onStartEmailEdit: (document: DteDocument) => void;
  onEmailDraftChange: (value: string) => void;
  onCancelEmailEdit: () => void;
  onSaveEmail: (document: DteDocument) => void;
}) {
  if (!selected) {
    return <aside className="detail-panel empty">Seleccione un CDE de la lista para ver su detalle.</aside>;
  }
  const plain = JSON.parse(selected.plain_json);
  const invalidationWindow = invalidationWindowInfo(selected, now);
  const rejectionDetail = rejectionDetailForDocument(selected, audit);
  const emailAttention =
    receiptEmailDelivery?.status === "FAILED" || receiptEmailDelivery?.requiresReview
    ? receiptEmailDelivery
    : null;
  const emailEditing = emailEditingId === selected.id;
  const fiscalOutcomePending = Boolean(selected.fiscal_operation_claim_id);
  const activeCorrectionStatus =
    fiscalCorrectionData?.activeCorrection?.status ?? null;
  const postAcceptFinalizationPending = selected.status === "ACCEPTED" && !selected.post_accept_finalized_at;
  const canRetry = isRetryableDocument(selected);
  const LegalIcon = invalidationWindow.tone === "expired" || invalidationWindow.tone === "warning" ? AlertTriangle : CheckCircle2;
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <StatusPill status={documentDisplayStatus(selected)} />
        <strong>{selected.numero_control}</strong>
      </div>
      {donorDataVerified && (
        <div className="donor-verified-badge">
          <ShieldCheck size={16} />
          <span>Datos del donante verificados en el formulario de donación</span>
        </div>
      )}
      {fiscalOutcomePending && (
        <div className="legal-box warning" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>
              {fiscalReconciliation
                ? "Requiere reconciliación"
                : "Resultado fiscal pendiente de conciliación"}
            </strong>
            <span>
              {fiscalReconciliation
                ? fiscalReconciliation.failureMessage
                  ?? "La corrección se detuvo antes del envío; no se transmitió a MH."
                : "MH pudo haber procesado la operación. Los reintentos e invalidaciones permanecen bloqueados."}
            </span>
            {fiscalReconciliation && (
              <span>No use Reintentar DTE; revise y concilie este caso.</span>
            )}
            {fiscalReconciliation?.failureCode && (
              <small>Código: {fiscalReconciliation.failureCode}</small>
            )}
            {selected.fiscal_operation_kind && (
              <small>Operación: {selected.fiscal_operation_kind === "INVALIDATION" ? "Invalidación" : "Transmisión"}</small>
            )}
            {selected.fiscal_operation_claimed_at && (
              <small>Operación iniciada: {formatElSalvadorDateTime(selected.fiscal_operation_claimed_at)} hora El Salvador</small>
            )}
          </div>
        </div>
      )}
      {activeCorrectionStatus && (
        <div
          className={`legal-box ${activeCorrectionStatus === "REVIEW_REQUIRED" ? "expired" : "warning"}`}
          role="status"
        >
          <AlertTriangle size={17} />
          <div>
            <strong>{fiscalCorrectionStatusLabel(activeCorrectionStatus)}</strong>
            <span>
              {activeCorrectionStatus === "REVIEW_REQUIRED"
                ? "No se enviará otra corrección hasta conciliar el resultado con Hacienda."
                : "La corrección protegida ya está en curso."}
            </span>
          </div>
        </div>
      )}
      {postAcceptFinalizationPending && !fiscalOutcomePending && (
        <div className="legal-box warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>Completando el comprobante aceptado</strong>
            <span>El envío definitivo y la trazabilidad local se reintentan automáticamente.</span>
          </div>
        </div>
      )}
      {emailAttention && (
        <div className="legal-box expired" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>
              {emailAttention.status === "PENDING"
                ? "Resultado del correo pendiente"
                : "Falló el envío del correo"}
            </strong>
            <span>
              {emailAttention.status === "PENDING"
                ? "El proveedor pudo aceptar el correo, pero el sistema no pudo confirmar el resultado. Requiere revisión técnica."
                : receiptEmailFailureGuidance(emailAttention.outcomeClass)}
            </span>
            {emailAttention.failureCode && <small>Código: {emailAttention.failureCode}</small>}
            <small>
              {emailAttention.status === "PENDING" ? "Iniciado" : "Falló"}:{" "}
              {formatElSalvadorDateTime(emailAttention.occurredAt)} hora El Salvador
            </small>
            <button
              type="button"
              className="email-recovery-action"
              disabled={
                emailAttention.status !== "FAILED" ||
                emailAttention.outcomeClass === null ||
                emailAttention.outcomeClass === "UNKNOWN" ||
                fiscalOutcomePending ||
                postAcceptFinalizationPending ||
                busy === "resend"
              }
              onClick={() => onAction("resend")}
            >
              <Mail size={16} />
              {emailAttention.status !== "FAILED" ||
              emailAttention.outcomeClass === null ||
              emailAttention.outcomeClass === "UNKNOWN"
                ? "Revisión necesaria"
                : "Reenviar ahora"}
            </button>
          </div>
        </div>
      )}
      <dl>
        <dt>Código de generación</dt>
        <dd className="mono">{selected.codigo_generacion}</dd>
        <dt>Sello</dt>
        <dd className="mono">{selected.sello_recibido ?? "Pendiente"}</dd>
        <dt>Donante</dt>
        <dd>{selected.donor_name ?? "—"}</dd>
        <dt className="detail-email-label">Correo de envío</dt>
        <dd className="detail-email-value">
          {emailEditing ? (
            <form className="inline-edit" onSubmit={(event) => {
              event.preventDefault();
              onSaveEmail(selected);
            }}>
              <input type="email" value={emailDraft} onChange={(event) => onEmailDraftChange(event.target.value)} placeholder="legacy-email-104@example.com" />
              <button type="submit" disabled={busy === "email"}><CheckCircle2 size={15} />Guardar</button>
              <button type="button" disabled={busy === "email"} onClick={onCancelEmailEdit}><X size={15} />Cancelar</button>
            </form>
          ) : (
            <span className="editable-readonly">
              <span>{selected.donor_email ?? "Sin correo"}</span>
              <button className="icon-button" onClick={() => onStartEmailEdit(selected)} title="Editar correo de envío">
                <Pencil size={15} />
              </button>
            </span>
          )}
        </dd>
        <dt>Ambiente</dt>
        <dd>{environmentLabel(selected.environment)}</dd>
      </dl>
      <div className={`legal-box ${invalidationWindow.tone}`}>
        <LegalIcon size={17} />
        <div>
          <strong>{invalidationWindow.title}</strong>
          <span>{invalidationWindow.remainingLabel}</span>
          {invalidationWindow.deadlineLabel && <small>Límite: {invalidationWindow.deadlineLabel} hora El Salvador</small>}
        </div>
      </div>
      <div className="actions">
        {!emailAttention && (
          <button disabled={fiscalOutcomePending || postAcceptFinalizationPending || busy === "resend"} title={fiscalOutcomePending ? "Requiere conciliación fiscal" : postAcceptFinalizationPending ? "Finalización local en curso" : "Reenviar el comprobante al correo del donante"} onClick={() => onAction("resend")}><Mail size={16} />Reenviar correo</button>
        )}
        {selected.status === "REJECTED" ? (
          <button
            disabled={
              !canCorrect
              || Boolean(activeCorrectionStatus)
              || fiscalOutcomePending
              || busy === `fiscal-correction-load:DTE_DOCUMENT:${selected.id}`
            }
            title={
              activeCorrectionStatus
                ? fiscalCorrectionStatusLabel(activeCorrectionStatus)
                : fiscalOutcomePending
                  ? "Corrección fiscal en curso"
                  : "Corregir los datos del receptor y crear un nuevo intento fiscal"
            }
            onClick={() => onCorrect({ kind: "DTE_DOCUMENT", id: selected.id })}
          >
            <Pencil size={16} />
            {activeCorrectionStatus
              ? fiscalCorrectionStatusLabel(activeCorrectionStatus)
              : fiscalOutcomePending
                ? "Corrección en cola"
                : "Corregir y reintentar"}
          </button>
        ) : (
          <button disabled={!canRetry || busy === "retry"} title={fiscalOutcomePending ? "Requiere conciliación fiscal" : canRetry ? "Reintentar procesamiento" : "Disponible solo para DTE con fallos o contingencia"} onClick={() => onAction("retry")}><RotateCcw size={16} />Reintentar DTE</button>
        )}
        <button className="danger" disabled={fiscalOutcomePending || postAcceptFinalizationPending || !invalidationWindow.canInvalidate || busy === "invalidate"} title={fiscalOutcomePending ? "Requiere conciliación fiscal" : postAcceptFinalizationPending ? "Finalización local en curso" : undefined} onClick={() => onInvalidateRequest(selected.id)}><AlertTriangle size={16} />Invalidar</button>
        <button disabled={busy === "download-pdf"} onClick={() => onDownload("pdf")}><Download size={16} />PDF</button>
        <button disabled={busy === "download-json"} onClick={() => onDownload("json")}><Download size={16} />JSON</button>
      </div>
      {rejectionDetail && (
        <section className="rejection-detail" aria-label="Detalle del rechazo">
          <div className="rejection-detail-head">
            <AlertTriangle size={16} />
            <strong>Detalle del rechazo</strong>
          </div>
          <dl>
            <dt>Motivo</dt>
            <dd>
              <ul>
                {rejectionDetail.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </dd>
            <dt>Fecha y hora</dt>
            <dd>
              {rejectionDetail.rejectedAt ? (
                <time dateTime={rejectionDetail.rejectedAt}>
                  {formatElSalvadorDateTime(rejectionDetail.rejectedAt)} hora El Salvador
                </time>
              ) : "Fecha no disponible"}
            </dd>
          </dl>
        </section>
      )}
      <details className="json-details">
        <summary>Ver JSON completo</summary>
        <div className="json-preview-head">
          <strong>JSON DTE</strong>
          <span>Vista completa del documento emitido.</span>
        </div>
        <pre>{JSON.stringify(plain, null, 2)}</pre>
      </details>
    </aside>
  );
}

export function InvalidationConfirmDialog({
  document,
  busy,
  now,
  form,
  onFormChange,
  onCancel,
  onConfirm
}: {
  document: DteDocument;
  busy: boolean;
  now: Date;
  form: InvalidationFormInput;
  onFormChange: (form: InvalidationFormInput) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const windowInfo = invalidationWindowInfo(document, now);
  const formError = invalidationFormValidationMessage(form);
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogDismiss(dialogRef, onCancel, busy);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invalidation-confirm-title"
      >
        <header>
          <div>
            <h2 id="invalidation-confirm-title">Confirmar invalidación</h2>
            <p>Esta acción transmite un evento de invalidación al Ministerio de Hacienda y no se puede deshacer desde el panel.</p>
          </div>
          <button className="icon-button" onClick={onCancel} disabled={busy} title="Cerrar">
            <X size={17} />
          </button>
        </header>
        <div className={`legal-box ${windowInfo.tone}`}>
          <AlertTriangle size={17} />
          <div>
            <strong>{windowInfo.remainingLabel}</strong>
            {windowInfo.deadlineLabel && <small>Límite: {windowInfo.deadlineLabel} hora El Salvador</small>}
          </div>
        </div>
        <dl className="confirm-facts">
          <dt>Control</dt>
          <dd className="mono">{document.numero_control}</dd>
          <dt>Código de generación</dt>
          <dd className="mono">{document.codigo_generacion}</dd>
          <dt>Sello</dt>
          <dd className="mono">{document.sello_recibido ?? "Pendiente"}</dd>
          <dt>Donante</dt>
          <dd>{document.donor_name ?? "—"}</dd>
        </dl>
        <div className="invalidation-form">
          <label>
            <span>Tipo de invalidación</span>
            <select
              value={form.tipoAnulacion}
              disabled={busy}
              onChange={(event) => onFormChange({ ...form, tipoAnulacion: Number(event.target.value) === 1 ? 1 : 2 })}
            >
              <option value={2}>2 - Rescindir la operación (dejar sin efecto el CDE)</option>
              <option value={1}>1 - Error en datos, con CDE de reemplazo ya emitido</option>
            </select>
          </label>
          {form.tipoAnulacion === 1 && (
            <label>
              <span>Código de generación del CDE de reemplazo</span>
              <input
                className="mono"
                value={form.codigoGeneracionR}
                disabled={busy}
                placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                onChange={(event) => onFormChange({ ...form, codigoGeneracionR: event.target.value })}
              />
              <small>Primero emita el nuevo CDE que ampara la donación; aquí se relaciona su código.</small>
            </label>
          )}
          <label>
            <span>Motivo</span>
            <textarea
              value={form.motivoAnulacion}
              disabled={busy}
              rows={2}
              placeholder="Ej.: Donación registrada con nombre de donante equivocado"
              onChange={(event) => onFormChange({ ...form, motivoAnulacion: event.target.value })}
            />
          </label>
        </div>
        <footer>
          <button onClick={onCancel} disabled={busy}>Cancelar</button>
          <button
            className="danger solid"
            title={formError || undefined}
            onClick={onConfirm}
            disabled={busy || !windowInfo.canInvalidate || Boolean(formError)}
          >
            <AlertTriangle size={16} />
            {busy ? "Invalidando" : "Confirmar invalidación"}
          </button>
        </footer>
      </section>
    </div>
  );
}
