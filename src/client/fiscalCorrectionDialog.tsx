import { AlertTriangle, X } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  CAT012_DEPARTMENTS,
  CAT019_ACTIVITIES,
  CAT020_COUNTRIES,
  CAT022_DOCUMENT_TYPES,
  CAT032_DOMICILE,
  findCatalogOption,
  getCat008Districts,
  getCat013Municipalities,
  type CatalogOption
} from "../shared/catalogs";
import {
  FiscalCorrectionValidationError,
  fiscalCorrectionChangedFields,
  fiscalCorrectionPayload,
  validateFiscalReceptorCorrection,
  type FiscalCorrectionStatus,
  type FiscalReceptorCorrection
} from "../shared/fiscalCorrection";
import { catalogOptionLabel } from "./displayText";
import {
  restoreFiscalCorrectionDialogFocus,
  trapFiscalCorrectionDialogFocus
} from "./fiscalCorrectionFocus";
import type {
  FiscalCorrectionData,
  FiscalCorrectionProtectedContext,
  WompiIssuanceFailureItem
} from "./types";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export interface FiscalCorrectionFormState {
  normalized: FiscalReceptorCorrection | null;
  changed: boolean;
  canSubmit: boolean;
  validationError: string;
}

export interface FiscalCorrectionPendingSubmission {
  correctionRequestId: string;
  receptor: FiscalReceptorCorrection;
}

export interface FiscalCorrectionSubmitResponse {
  status: FiscalCorrectionStatus;
  queued?: boolean;
  duplicate?: boolean;
  correctionId?: string;
}

export function fiscalCorrectionFormState(
  before: FiscalReceptorCorrection,
  draft: FiscalReceptorCorrection,
  activeStatus: FiscalCorrectionStatus | null,
  options: {
    initialDraft?: FiscalReceptorCorrection;
    retryingSubmittedPayload?: boolean;
  } = {}
): FiscalCorrectionFormState {
  try {
    const normalized = validateFiscalReceptorCorrection(
      draft as unknown as Record<string, unknown>
    );
    const initialDraft = options.initialDraft ?? before;
    const changed = fiscalCorrectionPayload(initialDraft) !== fiscalCorrectionPayload(draft);
    let changesSource = changed;
    try {
      const normalizedBefore = validateFiscalReceptorCorrection(
        before as unknown as Record<string, unknown>
      );
      changesSource =
        fiscalCorrectionChangedFields(normalizedBefore, normalized).length > 0;
    } catch {
      // A rejected source can itself be invalid. In that case an actual draft
      // edit plus a valid corrected payload is sufficient.
    }
    return {
      normalized,
      changed,
      canSubmit:
        (options.retryingSubmittedPayload || (changed && changesSource))
        && activeStatus === null,
      validationError: ""
    };
  } catch (error) {
    return {
      normalized: null,
      changed: false,
      canSubmit: false,
      validationError:
        error instanceof FiscalCorrectionValidationError
          ? error.message
          : "Revise los datos del receptor."
    };
  }
}

export function fiscalCorrectionStatusLabel(status: FiscalCorrectionStatus): string {
  const labels: Record<FiscalCorrectionStatus, string> = {
    QUEUED: "Corrección en cola",
    PROCESSING: "Procesando corrección",
    ACCEPTED: "Corrección aceptada",
    REJECTED: "Corrección rechazada",
    FAILED: "Falló la corrección",
    REVIEW_REQUIRED: "Revisión necesaria"
  };
  return labels[status];
}

export function isCorrectablePreCdeFailure(
  item: Pick<WompiIssuanceFailureItem, "correction_available">
): boolean {
  return item.correction_available === true;
}

export function isReviewRequiredPreCdeFailure(
  item: Pick<WompiIssuanceFailureItem, "correction_available">
): boolean {
  return item.correction_available === false;
}

export function fiscalCorrectionSubmissionForTarget(
  submissions: Map<string, FiscalCorrectionPendingSubmission>,
  targetKey: string,
  receptor: FiscalReceptorCorrection,
  create: () => string = () => crypto.randomUUID()
): FiscalCorrectionPendingSubmission {
  const existing = submissions.get(targetKey);
  if (
    existing
    && fiscalCorrectionPayload(existing.receptor) === fiscalCorrectionPayload(receptor)
  ) {
    return existing;
  }
  const submission = {
    correctionRequestId: create(),
    receptor: { ...receptor }
  };
  submissions.set(targetKey, submission);
  return submission;
}

export function fiscalCorrectionDraftForTarget(
  submissions: Map<string, FiscalCorrectionPendingSubmission>,
  targetKey: string,
  fallback: FiscalReceptorCorrection
): FiscalReceptorCorrection {
  return submissions.get(targetKey)?.receptor ?? fallback;
}

export function fiscalCorrectionSubmissionMessage(
  response: Pick<FiscalCorrectionSubmitResponse, "status" | "duplicate">
): string {
  const messages: Record<FiscalCorrectionStatus, string> = {
    QUEUED: "Corrección en cola",
    PROCESSING: "Corrección en proceso",
    ACCEPTED: "La corrección ya fue aceptada por Hacienda.",
    REJECTED: "Hacienda rechazó la corrección. Revise el detalle.",
    FAILED: "La corrección falló. Revise el detalle.",
    REVIEW_REQUIRED: "La corrección requiere revisión antes de continuar."
  };
  return messages[response.status];
}

export function FiscalCorrectionDialog({
  open,
  data,
  initialDraft,
  retryingSubmittedPayload,
  protectedContext,
  busy,
  error,
  onCancel,
  onSubmit
}: {
  open: boolean;
  data: FiscalCorrectionData | null;
  initialDraft?: FiscalReceptorCorrection;
  retryingSubmittedPayload?: boolean;
  protectedContext: FiscalCorrectionProtectedContext;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (value: FiscalReceptorCorrection) => Promise<void>;
}) {
  const [form, setForm] = useState<FiscalReceptorCorrection>(
    () => initialDraft ?? data?.receptor ?? emptyCorrection()
  );
  const dialogRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!busyRef.current) onCancelRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) return;
      trapFiscalCorrectionDialogFocus(dialog, event);
    }
    function handleFocusIn(event: FocusEvent) {
      const dialog = dialogRef.current;
      if (!dialog || !(event.target instanceof Node) || dialog.contains(event.target)) {
        return;
      }
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialog).focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      restoreFiscalCorrectionDialogFocus(previouslyFocusedRef.current);
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  const formState = useMemo(
    () =>
      data
        ? fiscalCorrectionFormState(
            data.receptor,
            form,
            data.activeCorrection?.status ?? null,
            { initialDraft, retryingSubmittedPayload }
          )
        : null,
    [data, form, initialDraft, retryingSubmittedPayload]
  );

  if (!open || !data || !formState) return null;

  const businessFields =
    form.tipoDocumento === "36"
    || Boolean(form.nrc || form.codActividad || form.descActividad);
  const domestic = form.codDomiciliado === 1;
  const municipalityOptions = domestic
    ? getCat013Municipalities(form.departamento)
    : [];
  const districtOptions = domestic
    ? getCat008Districts(form.departamento)
    : [];
  const activeStatus = data.activeCorrection?.status ?? null;
  const validationMessage = formState.validationError || error;
  const canSubmit =
    data.correctable && formState.canSubmit && !busy && activeStatus === null;
  const normalized = formState.normalized;

  function update(patch: Partial<FiscalReceptorCorrection>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function updateDocumentType(tipoDocumento: string) {
    update({
      tipoDocumento,
      ...(tipoDocumento === "36"
        ? {}
        : { nrc: null, codActividad: null, descActividad: null })
    });
  }

  function updateDomicile(value: string) {
    const codDomiciliado = value === "2" ? 2 : 1;
    if (codDomiciliado === 2) {
      update({
        codDomiciliado,
        codPais: form.codPais === "SV" ? "" : form.codPais,
        departamento: "00",
        municipio: "00",
        distrito: "00"
      });
      return;
    }
    update({
      codDomiciliado,
      codPais: "SV",
      departamento: form.departamento === "00" ? "" : form.departamento,
      municipio: form.municipio === "00" ? "" : form.municipio,
      distrito: form.distrito === "00" ? "" : form.distrito
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit && normalized) {
      void onSubmit(normalized);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="fiscal-correction-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fiscal-correction-title"
        aria-describedby="fiscal-correction-reason"
      >
        <header>
          <div>
            <h2 id="fiscal-correction-title">Corregir datos fiscales</h2>
            <p>Revise únicamente los datos del receptor que causaron el rechazo.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Cerrar corrección fiscal"
            title="Cerrar"
          >
            <X size={17} />
          </button>
        </header>

        <div
          id="fiscal-correction-reason"
          className="fiscal-correction-reason"
          role="alert"
        >
          <AlertTriangle size={18} />
          <div>
            <strong>Motivo del fallo</strong>
            <span>{data.failureReason}</span>
          </div>
        </div>

        {activeStatus && (
          <p className="fiscal-correction-active" role="status">
            {fiscalCorrectionStatusLabel(activeStatus)}
          </p>
        )}
        {!data.correctable && (
          <p className="fiscal-correction-guidance" role="alert">
            {data.guidance ?? "Este caso requiere revisión técnica."}
          </p>
        )}

        <div className="fiscal-correction-protected">
          <strong>Datos protegidos</strong>
          <p>
            El monto, el emisor, el ambiente y los identificadores fiscales no
            se modificarán.
          </p>
          <dl>
            <div><dt>Monto</dt><dd>{protectedContext.amountLabel}</dd></div>
            <div><dt>Ambiente</dt><dd>{protectedContext.environmentLabel}</dd></div>
            <div><dt>Emisor</dt><dd>{protectedContext.issuerLabel}</dd></div>
          </dl>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="fiscal-correction-grid">
            <CorrectionField label="Tipo de documento">
              <CorrectionSelect
                name="tipoDocumento"
                value={form.tipoDocumento}
                options={CAT022_DOCUMENT_TYPES}
                onChange={updateDocumentType}
              />
            </CorrectionField>
            <CorrectionField label="Número de documento">
              <input
                name="numDocumento"
                value={form.numDocumento}
                onChange={(event) => update({ numDocumento: event.target.value })}
                autoComplete="off"
              />
            </CorrectionField>
            <CorrectionField label="Nombre o razón social" span>
              <input
                name="nombre"
                value={form.nombre}
                onChange={(event) => update({ nombre: event.target.value })}
                autoComplete="name"
              />
            </CorrectionField>

            {businessFields && (
              <>
                <CorrectionField label="NRC">
                  <input
                    name="nrc"
                    value={form.nrc ?? ""}
                    onChange={(event) => update({ nrc: event.target.value || null })}
                    inputMode="numeric"
                  />
                </CorrectionField>
                <CorrectionField label="Actividad económica">
                  <CorrectionSelect
                    name="codActividad"
                    value={form.codActividad ?? ""}
                    options={CAT019_ACTIVITIES}
                    onChange={(codActividad) =>
                      update({
                        codActividad: codActividad || null,
                        descActividad:
                          findCatalogOption(CAT019_ACTIVITIES, codActividad)?.label
                          ?? null
                      })
                    }
                    placeholder="Seleccione"
                  />
                </CorrectionField>
                <CorrectionField label="Descripción de actividad" span>
                  <input
                    name="descActividad"
                    value={form.descActividad ?? ""}
                    onChange={(event) =>
                      update({ descActividad: event.target.value || null })
                    }
                  />
                </CorrectionField>
              </>
            )}

            <CorrectionField label="Correo">
              <input
                name="correo"
                type="email"
                value={form.correo ?? ""}
                onChange={(event) => update({ correo: event.target.value || null })}
                autoComplete="email"
              />
            </CorrectionField>
            <CorrectionField label="Teléfono">
              <input
                name="telefono"
                value={form.telefono ?? ""}
                onChange={(event) =>
                  update({ telefono: event.target.value || null })
                }
                inputMode="tel"
                autoComplete="tel"
              />
            </CorrectionField>
            <CorrectionField label="Domicilio fiscal">
              <CorrectionSelect
                name="codDomiciliado"
                value={String(form.codDomiciliado)}
                options={CAT032_DOMICILE}
                onChange={updateDomicile}
              />
            </CorrectionField>

            {domestic ? (
              <>
                <CorrectionField label="País">
                  <span className="fiscal-correction-readonly">El Salvador</span>
                </CorrectionField>
                <CorrectionField label="Departamento">
                  <CorrectionSelect
                    name="departamento"
                    value={form.departamento}
                    options={CAT012_DEPARTMENTS.filter((option) => option.code !== "00")}
                    onChange={(departamento) =>
                      update({ departamento, municipio: "", distrito: "" })
                    }
                    placeholder="Seleccione"
                  />
                </CorrectionField>
                <CorrectionField label="Municipio">
                  <CorrectionSelect
                    name="municipio"
                    value={form.municipio}
                    options={municipalityOptions}
                    onChange={(municipio) => update({ municipio })}
                    placeholder="Seleccione"
                  />
                </CorrectionField>
                <CorrectionField label="Distrito">
                  <CorrectionSelect
                    name="distrito"
                    value={form.distrito}
                    options={districtOptions}
                    onChange={(distrito) => update({ distrito })}
                    placeholder="Seleccione"
                  />
                </CorrectionField>
                <CorrectionField label="Dirección completa" span>
                  <textarea
                    name="complemento"
                    value={form.complemento}
                    onChange={(event) => update({ complemento: event.target.value })}
                    rows={3}
                    autoComplete="street-address"
                  />
                </CorrectionField>
              </>
            ) : (
              <>
                <CorrectionField label="País" span>
                  <CorrectionSelect
                    name="codPais"
                    value={form.codPais}
                    options={CAT020_COUNTRIES.filter((option) => option.code !== "SV")}
                    onChange={(codPais) => update({ codPais })}
                    placeholder="Seleccione"
                  />
                </CorrectionField>
                <CorrectionField label="Dirección en el extranjero" span>
                  <textarea
                    name="complemento"
                    value={form.complemento}
                    onChange={(event) => update({ complemento: event.target.value })}
                    rows={3}
                    autoComplete="street-address"
                  />
                </CorrectionField>
              </>
            )}
          </div>

          {validationMessage && (
            <p className="error fiscal-correction-error" role="alert">
              {validationMessage}
            </p>
          )}
          {!validationMessage && !formState.changed && (
            <p className="fiscal-correction-hint">
              Cambie al menos un dato para continuar.
            </p>
          )}

          <footer>
            <button type="button" onClick={onCancel} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="primary" disabled={!canSubmit}>
              Guardar y reintentar
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function CorrectionField({
  label,
  span,
  children
}: {
  label: string;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={span ? "span-2" : ""}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function CorrectionSelect({
  name,
  value,
  options,
  onChange,
  placeholder
}: {
  name: string;
  value: string;
  options: readonly CatalogOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <select
      name={name}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {(placeholder || !value) && (
        <option value="">{placeholder ?? "Seleccione"}</option>
      )}
      {options.map((option) => (
        <option key={`${option.code}-${option.label}`} value={option.code}>
          {option.code} - {catalogOptionLabel(option.label)}
        </option>
      ))}
    </select>
  );
}

function emptyCorrection(): FiscalReceptorCorrection {
  return {
    tipoDocumento: "13",
    numDocumento: "",
    nrc: null,
    nombre: "",
    codActividad: null,
    descActividad: null,
    correo: null,
    telefono: null,
    codDomiciliado: 1,
    codPais: "SV",
    departamento: "",
    municipio: "",
    distrito: "",
    complemento: ""
  };
}
