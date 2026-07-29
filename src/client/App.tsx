import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CircleHelp,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  LineChart,
  Braces,
  KeyRound,
  LogOut,
  Mail,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Unplug,
  UserPlus,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  X,
  Users
} from "lucide-react";
import { Fragment, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { AlertEmailState, AuditRow, BackupMonth, BackupsGrid, BackupVerifyResult, CredentialStatus, DocumentListPage, DonationIntentListItem, DteDocument, EmailTemplateSettings, EmailTemplateValue, EmissionEnvironmentState, FiscalCorrectionData, FiscalCorrectionProtectedContext, FiscalReconciliationState, ReceiptEmailDeliveryState, User, WompiIssuanceFailureItem } from "./types";
import { shouldShowBootstrapMode, type AuthBootstrapStatus } from "./authBootstrap";
import { AccountStateGuard, StaleAccountStateError } from "./accountState";
import { applyBranding, brandingDonorLogoSrc, brandingLogoSrc, CLIENT_BRANDING_DEFAULTS, parseBrandingResponse, type Branding } from "./branding";
import { filterAuditEntries } from "./auditFilter";
import { createLatestRequestGate, filterPreCdeFailures } from "./preCdeFailures";
import { defaultInvalidationForm, invalidationFormValidationMessage, invalidationRequestBody, type InvalidationFormInput } from "./invalidationForm";
import { passwordResetConfirmValidationMessage } from "./passwordReset";
import { isDonarGraciasPath, isDonarPath } from "./donation";
import { DonarGraciasPage, DonarPage } from "./donarPage";
import { type CredentialSettingsSectionId } from "./credentialSettings";
import { AnalyticsView } from "./analyticsView";
import { analyticsRangePresets, type AnalyticsRangePreset, type GiftTypeFilter } from "./analytics";
import type { AnalyticsResponse } from "./types";
import { auditActionLabel, auditActorLabel, auditLocationLabel, auditProtocolLabel, AUDIT_CONTEXT_LABELS, auditSummaryLabel, catalogOptionLabel, documentDisplayStatus, entityLabel, environmentLabel, parseAuditContext, roleLabel, statusLabel, userFacingErrorMessage } from "./displayText";
import {
  FiscalCorrectionDialog,
  fiscalCorrectionDraftForTarget,
  fiscalCorrectionSubmissionForTarget,
  fiscalCorrectionSubmissionMessage,
  type FiscalCorrectionPendingSubmission,
  type FiscalCorrectionSubmitResponse
} from "./fiscalCorrectionDialog";
import { PASSWORD_POLICY_REQUIREMENTS, passwordPolicyFailures, passwordPolicySatisfied } from "../shared/passwordPolicy";
import { isValidEmail } from "../shared/email";
import { formatCents } from "../shared/money";
import type { FiscalReceptorCorrection } from "../shared/fiscalCorrection";
import {
  CAT012_DEPARTMENTS,
  CAT014_UNITS,
  CAT017_PAYMENT_FORMS,
  CAT019_ACTIVITIES,
  CAT020_COUNTRIES,
  CAT021_ASSOCIATED_DOCUMENTS,
  CAT022_DOCUMENT_TYPES,
  CAT022_ISSUER_DOCUMENT_TYPES,
  CAT026_DONATION_TYPES,
  CAT032_DOMICILE,
  type CatalogOption,
  findCatalogOption,
  getCat008Districts,
  getCat013Municipalities,
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat014UnitCode,
  isCat017PaymentFormCode,
  isCat019ActivityCode,
  isCat020CountryCode,
  isCat021AssociatedDocumentCode,
  isCat022DocumentTypeCode,
  isCat026DonationTypeCode,
  isCat032DomicileCode,
  normalizeCatalogCode,
  normalizeCat020CountryCode
} from "../shared/catalogs";
import { cleanDui, isDuiDocumentType, isValidDui } from "../shared/dui";
import { formatElSalvadorDateTime } from "../shared/legalWindows";
import { cloneEmailTemplates, CredentialsPanel } from "./credentialsPanel";
import {
  AnnualCertificatePanel,
  BackupsPanel,
  CONTACT_EXPORT_COLUMNS,
  certificatePreviewPath,
  certificateYearOptions,
  ContactsExportPanel,
  type ContactsPeriod,
  contactsPeriodRange,
  ExportPanel,
  OnlineDonationsPanel
} from "./exportsPanel";
import {
  DetailPanel,
  DocumentListFooter,
  DocumentTable,
  InvalidationConfirmDialog,
  PreCdeFailuresPanel,
  Stats
} from "./documentsView";

type Role = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";
type View = "documents" | "failures" | "contingency" | "audit" | "analytics" | "users" | "exports" | "credentials";
export type FiscalCorrectionTarget =
  | { kind: "WOMPI_EVENT"; id: string }
  | { kind: "DTE_DOCUMENT"; id: string };

const DOCUMENT_PAGE_SIZE = 50;
const DOCUMENT_SEARCH_DEBOUNCE_MS = 300;
const TOAST_DISMISS_MS = 6000;
// The general Documents status picker keeps a combined fiscal failure option. The
// dedicated Fallos view uses the server-side attention filter so it can also include
// accepted CDEs whose latest receipt email failed.
export const FAILURE_VIEW_STATUSES = "FAILED,REJECTED";

export function receiptEmailFailureGuidance(
  outcome: DteDocument["receipt_email_outcome_class"]
): string {
  if (outcome === "NOT_SENT") {
    return "El proveedor rechazó el mensaje antes de enviarlo. Puede intentarlo de nuevo.";
  }
  if (outcome === "NOT_DELIVERED") {
    return "El proveedor confirmó que el mensaje no pudo entregarse. Revise el correo antes de reenviar.";
  }
  if (outcome === "UNKNOWN") {
    return "No podemos confirmar si el proveedor envió el correo. Revise el caso antes de reenviar.";
  }
  return "El intento de envío falló.";
}

export function shouldRetainResendRequestIdAfterFailure(
  outcome: ReceiptEmailDeliveryState["outcomeClass"] | undefined
): boolean {
  // A confirmed terminal non-delivery is safe only as a new deliberate action.
  // Proven pre-accept rejection reclaims the same attempt; ambiguous and legacy
  // outcomes retain the UUID so a reload-free retry cannot bypass their fence.
  return outcome !== "NOT_DELIVERED";
}

const navItems: Array<{ id: View; label: string; icon: typeof FileText; minRole?: Role }> = [
  { id: "documents", label: "Documentos", icon: FileText },
  { id: "failures", label: "Fallos", icon: AlertTriangle },
  { id: "contingency", label: "Contingencia", icon: Unplug },
  { id: "audit", label: "Auditoría", icon: ScrollText },
  { id: "analytics", label: "Analítica", icon: LineChart },
  { id: "users", label: "Usuarios", icon: Users },
  { id: "exports", label: "Exportar", icon: FileSpreadsheet, minRole: "ADMIN" },
  { id: "credentials", label: "Configuración", icon: Settings, minRole: "OWNER" }
];

export const credentialSettingsSectionIcons: Record<CredentialSettingsSectionId, typeof FileText> = {
  ambiente: Settings,
  mh: KeyRound,
  wompi: Cloud,
  emisor: FileText,
  correo: Mail,
  plantillas: Braces,
  marca: Palette
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, disabled: boolean) {
  // El filtro offsetParent de abajo clasifica elementos position:fixed como no
  // enfocables (offsetParent === null aunque sean visibles); ningún diálogo
  // actual anida hijos fixed. El enfoque inicial asume que ningún hijo trae su
  // propio autofocus: los efectos de hijos corren antes y este lo pisaría.
  useEffect(() => {
    ref.current?.focus();
  }, [ref]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!disabled) {
          onDismiss();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const container = ref.current;
      if (!container) {
        return;
      }
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement
      );
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [ref, onDismiss, disabled]);
}

function StartupShell() {
  return (
    <div className="startup-shell" aria-hidden="true">
      <aside className="startup-rail">
        <div className="startup-rail-mark" />
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="startup-rail-dot" />
        ))}
      </aside>
      <main className="startup-workspace">
        <div className="startup-heading" />
        <div className="startup-subheading" />
        <section className="startup-card">
          <div className="startup-control" />
          <div className="startup-row" />
          <div className="startup-row" />
          <div className="startup-row" />
        </section>
      </main>
    </div>
  );
}

export function App({ initialResetToken = null }: { initialResetToken?: string | null }) {
  // Public donor-checkout routes render as standalone pages WITHOUT a session and
  // never trigger the auth bootstrap/login flow. Branch on pathname before any of
  // App's own hooks run so the hook order stays stable for a given URL (the page
  // never transitions between these routes and the admin shell without a reload).
  const pathname = window.location.pathname;
  if (isDonarPath(pathname)) {
    return <DonarPage />;
  }
  if (isDonarGraciasPath(pathname)) {
    return <DonarGraciasPage />;
  }

  const [token, setToken] = useState(() => localStorage.getItem("diezmos_token") ?? "");
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem("diezmos_user");
    return stored ? (JSON.parse(stored) as User) : null;
  });
  const accountStateGuardRef = useRef(new AccountStateGuard());
  const resendRequestIds = useRef(new Map<string, string>());
  const fiscalCorrectionSubmissions = useRef(
    new Map<string, FiscalCorrectionPendingSubmission>()
  );
  // Functions from an older React render retain this version. The centralized request
  // wrapper rejects them before they can issue another request or write account data.
  const renderAccountStateVersion = accountStateGuardRef.current.capture();
  const [view, setView] = useState<View>("documents");
  const [documents, setDocuments] = useState<DteDocument[]>([]);
  const [preCdeFailures, setPreCdeFailures] = useState<WompiIssuanceFailureItem[]>([]);
  const [preCdeFailuresError, setPreCdeFailuresError] = useState("");
  const [preCdeFailuresLoading, setPreCdeFailuresLoading] = useState(false);
  const preCdeFailureRequests = useRef(createLatestRequestGate());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  // Keyset cursor for the audit trail ("<created_at>|<id>"); null = no older pages.
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
  const [emissionEnvironment, setEmissionEnvironment] = useState<EmissionEnvironmentState | null>(null);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateSettings | null>(null);
  const [emailTemplateDraft, setEmailTemplateDraft] = useState<Record<string, EmailTemplateValue>>({});
  const [alertEmailDraft, setAlertEmailDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("diezmos_sidebar_collapsed") === "true");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [documentNextCursor, setDocumentNextCursor] = useState<string | null>(null);
  const [documentsHasMore, setDocumentsHasMore] = useState(false);
  const [documentsLoadingMore, setDocumentsLoadingMore] = useState(false);
  const [toast, setToast] = useState("");
  const [auditQuery, setAuditQuery] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authBootstrapStatus, setAuthBootstrapStatus] = useState<AuthBootstrapStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [pendingInvalidationId, setPendingInvalidationId] = useState<string | null>(null);
  const [invalidationForm, setInvalidationForm] = useState<InvalidationFormInput>(defaultInvalidationForm);
  const [emailEditingId, setEmailEditingId] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [advancedDteOpen, setAdvancedDteOpen] = useState(false);
  const [advancedDteTemplate, setAdvancedDteTemplate] = useState<Record<string, unknown> | null>(null);
  const [advancedDteForm, setAdvancedDteForm] = useState(defaultAdvancedCdeForm);
  const [advancedDteStep, setAdvancedDteStep] = useState(0);
  const [advancedDteError, setAdvancedDteError] = useState("");
  const [exportStartDate, setExportStartDate] = useState(currentMonthStartValue);
  const [exportEndDate, setExportEndDate] = useState(todayDateValue);
  const [exportPreview, setExportPreview] = useState<F960Preview>({
    rows: [],
    rowCount: 0,
    amountTotal: "0.00"
  });
  const [certificateYear, setCertificateYear] = useState(() => String(new Date().getFullYear()));
  const [certificateSearch, setCertificateSearch] = useState("");
  const [debouncedCertificateSearch, setDebouncedCertificateSearch] = useState("");
  const [certificatePreview, setCertificatePreview] = useState<AnnualCertificatePreview | null>(null);
  // CRM contacts export customization: period preset (with optional custom range), a
  // gift-type filter, and the selected CSV columns (all on by default).
  const [contactsPeriod, setContactsPeriod] = useState<ContactsPeriod>("todo");
  const [contactsFrom, setContactsFrom] = useState(currentMonthStartValue);
  const [contactsTo, setContactsTo] = useState(todayDateValue);
  const [contactsGiftType, setContactsGiftType] = useState<"todos" | "DIEZMO" | "OFRENDA">("todos");
  const [contactsColumns, setContactsColumns] = useState<Set<string>>(() => new Set(CONTACT_EXPORT_COLUMNS.map((column) => column.key)));
  const [donationIntents, setDonationIntents] = useState<DonationIntentListItem[]>([]);
  const [backups, setBackups] = useState<BackupMonth[]>([]);
  const [backupVerifyByMonth, setBackupVerifyByMonth] = useState<Record<string, BackupVerifyResult>>({});
  const [donorVerifiedDocId, setDonorVerifiedDocId] = useState<string | null>(null);
  const [selectedDocumentAudit, setSelectedDocumentAudit] = useState<AuditRow[]>([]);
  const [selectedReceiptEmailDelivery, setSelectedReceiptEmailDelivery] = useState<ReceiptEmailDeliveryState | null>(null);
  const [selectedFiscalReconciliation, setSelectedFiscalReconciliation] =
    useState<FiscalReconciliationState | null>(null);
  const [selectedDocumentDetailVersion, setSelectedDocumentDetailVersion] = useState(0);
  const [selectedFiscalCorrectionData, setSelectedFiscalCorrectionData] = useState<FiscalCorrectionData | null>(null);
  const [fiscalCorrectionTarget, setFiscalCorrectionTarget] = useState<FiscalCorrectionTarget | null>(null);
  const [fiscalCorrectionData, setFiscalCorrectionData] = useState<FiscalCorrectionData | null>(null);
  const [fiscalCorrectionProtectedContext, setFiscalCorrectionProtectedContext] =
    useState<FiscalCorrectionProtectedContext>(emptyFiscalCorrectionProtectedContext);
  const [fiscalCorrectionError, setFiscalCorrectionError] = useState("");
  const [testInput, setTestInput] = useState<TestDteInput>(emptyTestDteInput);
  const [newUser, setNewUser] = useState<CreateUserInput>({
    name: "",
    email: "",
    role: "VIEWER",
    password: ""
  });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettingsInput>(emptyUserSettings());
  const [credentialInput, setCredentialInput] = useState<CredentialFormInput>(emptyCredentialInput("test"));
  const [branding, setBranding] = useState<Branding>({ ...CLIENT_BRANDING_DEFAULTS, logoVersion: null, donorLogoVersion: null });
  const [brandingReady, setBrandingReady] = useState(false);
  // Analítica (carril Wompi): the view defaults its ambiente selector to the ACTIVE
  // emission environment, loaded lazily the first time the view is opened. Presets are
  // computed against `now` so "Este mes" tracks the calendar; the custom range seeds
  // from the "Personalizado" preset (last 90 days).
  const analyticsPresets = useMemo(() => analyticsRangePresets(now), [now]);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsEnvironment, setAnalyticsEnvironment] = useState<"00" | "01" | null>(null);
  const [analyticsPresetId, setAnalyticsPresetId] = useState<AnalyticsRangePreset["id"]>("trimestre");
  const [analyticsFrom, setAnalyticsFrom] = useState(() => analyticsRangePresets(new Date()).find((preset) => preset.id === "personalizado")!.from);
  const [analyticsTo, setAnalyticsTo] = useState(() => analyticsRangePresets(new Date()).find((preset) => preset.id === "personalizado")!.to);
  const [analyticsGiftFilter, setAnalyticsGiftFilter] = useState<GiftTypeFilter>("todos");

  const selected = useMemo(() => documents.find((document) => document.id === selectedId) ?? documents[0], [documents, selectedId]);
  const selectedUser = useMemo(() => users.find((candidate) => candidate.id === selectedUserId) ?? null, [users, selectedUserId]);
  const pendingInvalidation = useMemo(() => documents.find((document) => document.id === pendingInvalidationId) ?? null, [documents, pendingInvalidationId]);
  const visiblePreCdeFailures = useMemo(
    () => view === "failures" ? filterPreCdeFailures(preCdeFailures, debouncedQuery) : [],
    [view, preCdeFailures, debouncedQuery]
  );
  const visibleNavItems = navItems.filter((item) => !item.minRole || can(user, item.minRole));

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const allowed = emissionEnvironment?.allowedEnvironments[0];
    if (!allowed) return;
    const credentialEnvironment = allowed === "01" ? "production" : "test";
    setCredentialInput((current) =>
      current.environment === credentialEnvironment ? current : emptyCredentialInput(credentialEnvironment)
    );
  }, [emissionEnvironment]);

  // White-label branding boots BEFORE (and independently of) the session check so the
  // login screen is already branded. A failed fetch keeps the historical defaults.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/branding")
      .then((response) => (response.ok ? response.json() : {}))
      .then((data) => {
        if (cancelled) return;
        const next = parseBrandingResponse(data);
        applyBranding(next);
        setBranding(next);
      })
      .catch(() => {
        // Keep the defaults already applied via the initial state.
      })
      .finally(() => {
        if (!cancelled) setBrandingReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const handle = window.setTimeout(() => setToast(""), TOAST_DISMISS_MS);
    return () => window.clearTimeout(handle);
  }, [toast]);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), DOCUMENT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (view !== "failures") {
      clearPreCdeFailures();
    }
  }, [view]);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedCertificateSearch(certificateSearch.trim()), DOCUMENT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [certificateSearch]);

  useEffect(() => {
    document.querySelector(".sidebar nav button.active")?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [view]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void refresh().catch(handleApiFailure);
  }, [token, status, debouncedQuery, view, exportStartDate, exportEndDate, certificateYear, debouncedCertificateSearch]);

  // Effective analytics range: a non-custom preset supplies its own bounds; the custom
  // preset uses the two date inputs. Keeps the fetch effect independent of which mode.
  const analyticsRange = useMemo(() => {
    if (analyticsPresetId === "personalizado") {
      return { from: analyticsFrom, to: analyticsTo };
    }
    const preset = analyticsPresets.find((candidate) => candidate.id === analyticsPresetId);
    return preset ? { from: preset.from, to: preset.to } : { from: analyticsFrom, to: analyticsTo };
  }, [analyticsPresetId, analyticsPresets, analyticsFrom, analyticsTo]);

  // Default the ambiente selector to the ACTIVE emission environment the first time the
  // Analítica view is opened (loaded lazily so the rest of the app never pays for it).
  useEffect(() => {
    if (view !== "analytics" || !token || analyticsEnvironment) {
      return;
    }
    let cancelled = false;
    void accountApi<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment")
      .then((result) => {
        if (!cancelled) setAnalyticsEnvironment(result.emissionEnvironment.environment);
      })
      .catch((error) => {
        if (!cancelled && !(error instanceof StaleAccountStateError)) setAnalyticsEnvironment("00");
      });
    return () => {
      cancelled = true;
    };
  }, [view, token, analyticsEnvironment]);

  // Fetch analytics whenever the view is active and the ambiente or range changes. A
  // stale-guard drops out-of-order responses so quick filter changes never flicker.
  useEffect(() => {
    if (view !== "analytics" || !token || !analyticsEnvironment) {
      return;
    }
    if (analyticsRange.from > analyticsRange.to) {
      return;
    }
    let cancelled = false;
    setAnalyticsLoading(true);
    const params = new URLSearchParams({ from: analyticsRange.from, to: analyticsRange.to, environment: analyticsEnvironment });
    void accountApi<{ analytics: AnalyticsResponse }>(`/api/analytics?${params.toString()}`)
      .then((result) => {
        if (!cancelled) setAnalytics(result.analytics);
      })
      .catch((error) => {
        if (!cancelled && !(error instanceof StaleAccountStateError)) {
          setAnalytics(null);
          handleApiFailure(error);
        }
      })
      .finally(() => {
        if (!cancelled) setAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, token, analyticsEnvironment, analyticsRange.from, analyticsRange.to]);

  // The document list does not carry the donor-data-verified flag (it is a per-CDE
  // indexed lookup on the server), so fetch the selected document's detail to learn it.
  useEffect(() => {
    const documentId = selected?.id;
    if (!token || !documentId) {
      setDonorVerifiedDocId(null);
      setSelectedDocumentAudit([]);
      setSelectedReceiptEmailDelivery(null);
      setSelectedFiscalReconciliation(null);
      setSelectedFiscalCorrectionData(null);
      return;
    }
    setDonorVerifiedDocId(null);
    setSelectedDocumentAudit([]);
    setSelectedReceiptEmailDelivery(null);
    setSelectedFiscalReconciliation(null);
    let cancelled = false;
    void accountApi<{
      donorDataVerified?: boolean;
      receiptEmailDelivery?: ReceiptEmailDeliveryState | null;
      fiscalReconciliation?: FiscalReconciliationState | null;
      audit?: AuditRow[];
    }>(`/api/documents/${documentId}`)
      .then((detail) => {
        if (!cancelled) {
          setDonorVerifiedDocId(detail.donorDataVerified ? documentId : null);
          setSelectedReceiptEmailDelivery(detail.receiptEmailDelivery ?? null);
          setSelectedFiscalReconciliation(detail.fiscalReconciliation ?? null);
          setSelectedDocumentAudit(Array.isArray(detail.audit) ? detail.audit : []);
        }
      })
      .catch((error) => {
        if (!cancelled && !(error instanceof StaleAccountStateError)) {
          setDonorVerifiedDocId(null);
          setSelectedReceiptEmailDelivery(null);
          setSelectedFiscalReconciliation(null);
          setSelectedDocumentAudit([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, selected?.id, selectedDocumentDetailVersion]);

  useEffect(() => {
    const documentId = selected?.id;
    const shouldLoad =
      Boolean(token && documentId && can(user, "OPERATOR"))
      && (
        selected?.status === "REJECTED"
        || Boolean(selected?.fiscal_operation_claim_id)
      );
    if (!shouldLoad || !documentId) {
      setSelectedFiscalCorrectionData(null);
      return;
    }
    setSelectedFiscalCorrectionData(null);
    let cancelled = false;
    void (async () => {
      const documentData = await accountApi<FiscalCorrectionData>(
        `/api/documents/${documentId}/correction-data`
      );
      if (
        documentData.activeCorrection
        || !selected?.wompi_event_id
      ) {
        if (!cancelled) setSelectedFiscalCorrectionData(documentData);
        return;
      }
      const wompiData = await accountApi<FiscalCorrectionData>(
        `/api/wompi-events/${selected.wompi_event_id}/correction-data`
      );
      if (!cancelled) {
        setSelectedFiscalCorrectionData(
          wompiData.activeCorrection ? wompiData : documentData
        );
      }
    })()
      .catch(() => {
        if (!cancelled) setSelectedFiscalCorrectionData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    token,
    user?.role,
    selected?.id,
    selected?.status,
    selected?.wompi_event_id,
    selected?.fiscal_operation_claim_id,
    selectedDocumentDetailVersion
  ]);

  useEffect(() => {
    if (token) {
      return;
    }
    let cancelled = false;
    setAuthBootstrapStatus(null);
    void api<AuthBootstrapStatus>("/api/auth/bootstrap-status", "")
      .then((result) => {
        if (!cancelled) setAuthBootstrapStatus(result);
      })
      .catch(() => {
        if (!cancelled) setAuthBootstrapStatus({ bootstrapAvailable: false });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  function runAccountOperation<T>(operation: () => Promise<T>): Promise<T> {
    return accountStateGuardRef.current.runAt(renderAccountStateVersion, operation);
  }

  function accountApi<T>(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<T> {
    return runAccountOperation(() => api<T>(path, token, options));
  }

  async function fetchDocumentPage(options: { append?: boolean; cursor?: string | null; query?: string; status?: string } = {}) {
    const params = new URLSearchParams();
    const effectiveStatus = options.status ?? status;
    const effectiveQuery = options.query ?? debouncedQuery;
    if (view === "failures") params.set("attention", "failures");
    else if (effectiveStatus) params.set("status", effectiveStatus);
    if (effectiveQuery) params.set("q", effectiveQuery);
    if (options.cursor) params.set("cursor", options.cursor);
    params.set("limit", String(DOCUMENT_PAGE_SIZE));
    const page = await accountApi<DocumentListPage>(`/api/documents?${params}`);
    setDocuments((current) => options.append ? [...current, ...page.documents] : page.documents);
    setDocumentNextCursor(page.nextCursor);
    setDocumentsHasMore(page.hasMore);
    if (!options.append) {
      setSelectedId((current) => {
        if (current && page.documents.some((document) => document.id === current)) {
          return current;
        }
        return page.documents[0]?.id ?? null;
      });
    }
    return page;
  }

  function clearPreCdeFailures() {
    preCdeFailureRequests.current.invalidate();
    setPreCdeFailures([]);
    setPreCdeFailuresError("");
    setPreCdeFailuresLoading(false);
  }

  async function fetchPreCdeFailures() {
    const request = preCdeFailureRequests.current.start();
    request.commit(() => {
      setPreCdeFailuresError("");
      setPreCdeFailuresLoading(true);
    });
    try {
      const result = await api<{ failures: WompiIssuanceFailureItem[] }>("/api/wompi-events/issuance-failures", token);
      request.commit(() => {
        setPreCdeFailures(result.failures);
        setPreCdeFailuresError("");
        setPreCdeFailuresLoading(false);
      });
    } catch (error) {
      request.commit(() => {
        setPreCdeFailures([]);
        setPreCdeFailuresError(userFacingErrorMessage(error instanceof Error ? error.message : String(error)));
        setPreCdeFailuresLoading(false);
      });
    }
  }

  async function refresh() {
    await Promise.all([
      fetchDocumentPage(),
      view === "failures" ? fetchPreCdeFailures() : Promise.resolve()
    ]);
    if (view === "audit") {
      const auditPage = await accountApi<{ audit: AuditRow[]; nextCursor: string | null }>("/api/audit?limit=50");
      setAudit(auditPage.audit);
      setAuditCursor(auditPage.nextCursor);
    }
    if (view === "users" && can(user, "ADMIN")) {
      const result = await accountApi<{ users: User[] }>("/api/users");
      setUsers(result.users);
    }
    if (view === "credentials" && can(user, "OWNER")) {
      const [credentialResult, environmentResult, emailTemplateResult, alertEmailResult] = await Promise.all([
        accountApi<{ credentials: CredentialStatus }>("/api/credentials"),
        accountApi<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment"),
        accountApi<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates"),
        accountApi<AlertEmailState>("/api/settings/alert-email")
      ]);
      setCredentials(credentialResult.credentials);
      setEmissionEnvironment(environmentResult.emissionEnvironment);
      applyEmailTemplates(emailTemplateResult.emailTemplates);
      applyAlertEmail(alertEmailResult.alertEmail);
    }
    if (view === "exports" && can(user, "ADMIN")) {
      if (exportStartDate && exportEndDate && exportStartDate > exportEndDate) {
        setExportPreview({ rows: [], rowCount: 0, amountTotal: "0.00" });
        setToast("Revise el rango de fechas");
        return;
      }
      const params = exportParams(exportStartDate, exportEndDate);
      const [
        f960Preview,
        certificateResult,
        donationIntentResult,
        backupsResult,
        environmentResult
      ] = await Promise.all([
        accountApi<F960Preview>(`/api/exports/f960?${params}`),
        accountApi<AnnualCertificatePreview>(certificatePreviewPath(certificateYear, debouncedCertificateSearch)),
        accountApi<{ intents: DonationIntentListItem[] }>("/api/donations/intents"),
        accountApi<BackupsGrid>("/api/admin/backups"),
        accountApi<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment")
      ]);
      setExportPreview(f960Preview);
      setCertificatePreview(certificateResult);
      setDonationIntents(donationIntentResult.intents);
      setBackups(backupsResult.months);
      setEmissionEnvironment(environmentResult.emissionEnvironment);
    }
  }

  function resetAccountState() {
    accountStateGuardRef.current.advance();
    setView("documents");
    setDocuments([]);
    clearPreCdeFailures();
    setSelectedId(null);
    setAudit([]);
    setAuditCursor(null);
    setAuditLoadingMore(false);
    setUsers([]);
    setCredentials(null);
    setEmissionEnvironment(null);
    setEmailTemplates(null);
    setEmailTemplateDraft({});
    setAlertEmailDraft("");
    setQuery("");
    setDebouncedQuery("");
    setStatus("");
    setDocumentNextCursor(null);
    setDocumentsHasMore(false);
    setDocumentsLoadingMore(false);
    setToast("");
    setAuditQuery("");
    setBusy("");
    setPendingInvalidationId(null);
    setInvalidationForm(defaultInvalidationForm);
    setEmailEditingId(null);
    setEmailDraft("");
    setAdvancedDteOpen(false);
    setAdvancedDteTemplate(null);
    setAdvancedDteForm(defaultAdvancedCdeForm());
    setAdvancedDteStep(0);
    setAdvancedDteError("");
    setExportStartDate(currentMonthStartValue());
    setExportEndDate(todayDateValue());
    setExportPreview({ rows: [], rowCount: 0, amountTotal: "0.00" });
    setCertificateYear(String(new Date().getFullYear()));
    setCertificateSearch("");
    setDebouncedCertificateSearch("");
    setCertificatePreview(null);
    setContactsPeriod("todo");
    setContactsFrom(currentMonthStartValue());
    setContactsTo(todayDateValue());
    setContactsGiftType("todos");
    setContactsColumns(new Set(CONTACT_EXPORT_COLUMNS.map((column) => column.key)));
    setDonationIntents([]);
    setBackups([]);
    setBackupVerifyByMonth({});
    setDonorVerifiedDocId(null);
    setSelectedDocumentAudit([]);
    setSelectedReceiptEmailDelivery(null);
    setSelectedFiscalCorrectionData(null);
    setFiscalCorrectionTarget(null);
    setFiscalCorrectionData(null);
    setFiscalCorrectionProtectedContext(emptyFiscalCorrectionProtectedContext());
    setFiscalCorrectionError("");
    fiscalCorrectionSubmissions.current.clear();
    setTestInput(emptyTestDteInput());
    setNewUser({ name: "", email: "", role: "VIEWER", password: "" });
    setSelectedUserId(null);
    setUserSettings(emptyUserSettings());
    setCredentialInput(emptyCredentialInput("test"));
    setAnalytics(null);
    setAnalyticsLoading(false);
    setAnalyticsEnvironment(null);
    setAnalyticsPresetId("trimestre");
    const analyticsDefaults = analyticsRangePresets(new Date()).find((preset) => preset.id === "personalizado")!;
    setAnalyticsFrom(analyticsDefaults.from);
    setAnalyticsTo(analyticsDefaults.to);
    setAnalyticsGiftFilter("todos");
  }

  async function loadMoreDocuments() {
    if (!documentNextCursor || documentsLoadingMore) return;
    setDocumentsLoadingMore(true);
    try {
      await fetchDocumentPage({ append: true, cursor: documentNextCursor });
    } finally {
      setDocumentsLoadingMore(false);
    }
  }

  async function login(email: string, password: string) {
    const result = await api<{ user: User; token: string }>("/api/auth/login", "", { method: "POST", body: { email, password } });
    resetAccountState();
    localStorage.setItem("diezmos_token", result.token);
    localStorage.setItem("diezmos_user", JSON.stringify(result.user));
    setToken(result.token);
    setUser(result.user);
    setAuthNotice("");
  }

  async function bootstrap(email: string, name: string, password: string, setupToken: string) {
    await api("/api/auth/bootstrap-owner", "", {
      method: "POST",
      headers: { "X-Bootstrap-Owner-Token": setupToken },
      body: { email, name, password }
    });
    await login(email, password);
  }

  async function requestPasswordReset(email: string) {
    await api("/api/auth/password-reset/request", "", { method: "POST", body: { email } });
  }

  async function confirmPasswordReset(resetToken: string, password: string) {
    await api("/api/auth/password-reset/confirm", "", { method: "POST", body: { token: resetToken, password } });
  }

  async function logout() {
    try {
      await accountApi("/api/auth/logout", { method: "POST" });
    } catch (error) {
      handleApiFailure(error);
      return;
    }
    localStorage.removeItem("diezmos_token");
    localStorage.removeItem("diezmos_user");
    resetAccountState();
    setToken("");
    setUser(null);
    setAuthNotice("");
  }

  async function retryPreCdeFailure(id: string) {
    await runAction(`pre-cde-retry:${id}`, async () => {
      await api(`/api/wompi-events/${id}/retry`, token, { method: "POST", body: {} });
      setToast("Reintento de creación en cola");
      await refresh();
    });
  }

  async function openFiscalCorrection(
    target: FiscalCorrectionTarget,
    protectedContext: FiscalCorrectionProtectedContext
  ) {
    if (busy) return;
    const targetKey = fiscalCorrectionTargetKey(target);
    setFiscalCorrectionTarget(target);
    setFiscalCorrectionData(null);
    setFiscalCorrectionProtectedContext(protectedContext);
    setFiscalCorrectionError("");
    setBusy(`fiscal-correction-load:${targetKey}`);
    try {
      const path = target.kind === "WOMPI_EVENT"
        ? `/api/wompi-events/${target.id}/correction-data`
        : `/api/documents/${target.id}/correction-data`;
      const data = await accountApi<FiscalCorrectionData>(path);
      setFiscalCorrectionData(data);
    } catch (error) {
      setFiscalCorrectionTarget(null);
      setFiscalCorrectionData(null);
      setFiscalCorrectionProtectedContext(emptyFiscalCorrectionProtectedContext());
      handleApiFailure(error);
    } finally {
      if (accountStateGuardRef.current.isCurrent(renderAccountStateVersion)) {
        setBusy("");
      }
    }
  }

  function closeFiscalCorrection() {
    setFiscalCorrectionTarget(null);
    setFiscalCorrectionData(null);
    setFiscalCorrectionProtectedContext(emptyFiscalCorrectionProtectedContext());
    setFiscalCorrectionError("");
  }

  // Re-issue a rejected CDE untouched after a CONFIGURATION fix (a replaced certificate,
  // a corrected emisor). Only reachable for document targets whose failure is not
  // receptor-correctable; the server enforces the same rule and refuses otherwise.
  async function reissueFiscalDocument() {
    const target = fiscalCorrectionTarget;
    if (!target || target.kind === "WOMPI_EVENT" || !fiscalCorrectionData || busy) return;
    const targetKey = fiscalCorrectionTargetKey(target);
    const submission = fiscalCorrectionSubmissionForTarget(
      fiscalCorrectionSubmissions.current,
      targetKey,
      fiscalCorrectionData.receptor
    );
    setFiscalCorrectionError("");
    setBusy("fiscal-correction-submit");
    let accepted = false;
    let acceptedMessage = "";
    try {
      // No receptor in the body: the server re-uses the document's own, so this cannot
      // become an unaudited correction.
      const result = await accountApi<FiscalCorrectionSubmitResponse>(
        `/api/documents/${target.id}/reissue`,
        { method: "POST", body: { correctionRequestId: submission.correctionRequestId } }
      );
      fiscalCorrectionSubmissions.current.delete(targetKey);
      accepted = true;
      acceptedMessage = fiscalCorrectionSubmissionMessage(result);
    } catch (error) {
      if (isApiError(error)) {
        fiscalCorrectionSubmissions.current.delete(targetKey);
        if (error.details.error === "fiscal_correction_queue_failed") {
          accepted = true;
          acceptedMessage = "La reemisión quedó guardada y se reintentará automáticamente.";
        } else {
          setFiscalCorrectionError(error.message);
          if (error.status === 401) handleApiFailure(error);
        }
      } else if (!(error instanceof StaleAccountStateError)) {
        setFiscalCorrectionError(
          "No se pudo confirmar la respuesta. Revise su conexión y vuelva a intentarlo; se conservará la misma solicitud."
        );
      }
    } finally {
      if (accountStateGuardRef.current.isCurrent(renderAccountStateVersion)) {
        setBusy("");
      }
    }
    if (!accepted) return;
    closeFiscalCorrection();
    setToast(acceptedMessage);
    try {
      await refresh();
      setSelectedDocumentDetailVersion((current) => current + 1);
    } catch {
      // The reissue is queued regardless; a failed refresh must not look like failure.
    }
  }

  async function submitFiscalCorrection(receptor: FiscalReceptorCorrection) {
    const target = fiscalCorrectionTarget;
    if (!target || !fiscalCorrectionData || busy) return;
    const targetKey = fiscalCorrectionTargetKey(target);
    const submission = fiscalCorrectionSubmissionForTarget(
      fiscalCorrectionSubmissions.current,
      targetKey,
      receptor
    );
    const path = target.kind === "WOMPI_EVENT"
      ? `/api/wompi-events/${target.id}/correct-and-retry`
      : `/api/documents/${target.id}/correct-and-retry`;
    setFiscalCorrectionError("");
    setBusy("fiscal-correction-submit");
    let accepted = false;
    let acceptedMessage = "";
    try {
      const result = await accountApi<FiscalCorrectionSubmitResponse>(path, {
        method: "POST",
        body: {
          correctionRequestId: submission.correctionRequestId,
          receptor: submission.receptor
        }
      });
      fiscalCorrectionSubmissions.current.delete(targetKey);
      accepted = true;
      acceptedMessage = fiscalCorrectionSubmissionMessage(result);
    } catch (error) {
      if (isApiError(error)) {
        fiscalCorrectionSubmissions.current.delete(targetKey);
        if (error.details.error === "fiscal_correction_queue_failed") {
          accepted = true;
          acceptedMessage =
            "La corrección quedó guardada y se reintentará automáticamente.";
        } else {
          setFiscalCorrectionError(error.message);
          if (error.status === 401) handleApiFailure(error);
        }
      } else if (!(error instanceof StaleAccountStateError)) {
        setFiscalCorrectionError(
          "No se pudo confirmar la respuesta. Revise su conexión y vuelva a intentarlo; se conservará la misma solicitud."
        );
      }
    } finally {
      if (accountStateGuardRef.current.isCurrent(renderAccountStateVersion)) {
        setBusy("");
      }
    }
    if (!accepted) return;
    closeFiscalCorrection();
    setToast(acceptedMessage);
    try {
      await refresh();
      setSelectedDocumentDetailVersion((current) => current + 1);
    } catch (error) {
      handleApiFailure(error);
    }
  }

  async function createTestDte() {
    const validationError = quickDteValidationMessage(testInput);
    if (validationError) {
      setToast(validationError);
      return;
    }
    await runAction("test-dte", async () => {
      await accountApi("/api/test/dte", { method: "POST", body: testInput });
      setTestInput(emptyTestDteInput());
      setToast("CDE creado. Transmitiendo al Ministerio de Hacienda…");
      await delay(2500);
      await refresh();
    });
  }

  async function openAdvancedDte() {
    await runAction("advanced-template", async () => {
      const result = await accountApi<{ draft: Record<string, unknown> }>("/api/test/dte/advanced-template", { method: "POST", body: testInput });
      setAdvancedDteTemplate(result.draft);
      setAdvancedDteForm(advancedFormFromDraft(result.draft));
      setAdvancedDteStep(0);
      setAdvancedDteError("");
      setAdvancedDteOpen(true);
    });
  }

  async function createAdvancedDte() {
    const validationError = validateAdvancedCdeForm(advancedDteForm);
    if (validationError) {
      setAdvancedDteError(validationError);
      return;
    }
    if (!advancedDteTemplate) {
      setAdvancedDteError("Recargue la plantilla avanzada");
      return;
    }
    const draft = advancedDraftFromForm(advancedDteTemplate, advancedDteForm);
    setAdvancedDteError("");
    await runAction("advanced-dte", async () => {
      await accountApi("/api/test/dte/advanced", { method: "POST", body: { draft } });
      setToast("CDE avanzado creado. Transmitiendo al Ministerio de Hacienda…");
      setAdvancedDteOpen(false);
      await delay(2500);
      await refresh();
    });
  }

  async function documentAction(action: "resend" | "retry" | "invalidate", target = selected) {
    if (!target) return;
    if (action === "invalidate") {
      const validationError = invalidationFormValidationMessage(invalidationForm);
      if (validationError) {
        setToast(validationError);
        return;
      }
    }
    const resendRequestId = action === "resend"
      ? resendRequestIds.current.get(target.id) ?? crypto.randomUUID()
      : null;
    if (resendRequestId) {
      resendRequestIds.current.set(target.id, resendRequestId);
    }
    const body = action === "invalidate"
      ? invalidationRequestBody(invalidationForm)
      : action === "resend"
        ? { resendRequestId }
        : {};
    await runAction(action, async () => {
      let result: {
        accepted?: boolean;
        result?: { estado?: string };
        emailSent?: boolean;
        emailError?: string;
      };
      try {
        result = await accountApi<typeof result>(
          `/api/documents/${target.id}/${action}`,
          { method: "POST", body }
        );
      } catch (error) {
        if (
          action === "resend" &&
          isApiError(error) &&
          !shouldRetainResendRequestIdAfterFailure(
            typeof error.details.outcomeClass === "string"
              ? error.details.outcomeClass as ReceiptEmailDeliveryState["outcomeClass"]
              : null
          )
        ) {
          resendRequestIds.current.delete(target.id);
        }
        throw error;
      }
      if (action === "resend") {
        resendRequestIds.current.delete(target.id);
      }
      setToast(action === "resend" ? "Correo reenviado" : action === "retry" ? "Reintento ejecutado" : invalidationToast(result));
      if (action === "invalidate") setPendingInvalidationId(null);
      if (action !== "resend") {
        await refresh();
      }
    });
    if (action === "resend") {
      setSelectedDocumentDetailVersion((current) => current + 1);
      await refresh();
    }
  }

  async function saveDocumentEmail(target = selected) {
    if (!target) return;
    const email = emailDraft.trim();
    if (!isValidEmail(email)) {
      setToast("Ingrese un correo válido");
      return;
    }
    await runAction("email", async () => {
      await accountApi(`/api/documents/${target.id}/email`, { method: "PATCH", body: { email } });
      resendRequestIds.current.delete(target.id);
      setToast("Correo de envío actualizado");
      setEmailEditingId(null);
      setEmailDraft("");
      await refresh();
    });
  }

  async function fetchAccountDownload(path: string): Promise<{ blob: Blob; contentDisposition: string | null }> {
    return runAccountOperation(async () => {
      const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
      }
      return {
        blob: await response.blob(),
        contentDisposition: response.headers.get("Content-Disposition")
      };
    });
  }

  async function downloadDocument(format: "pdf" | "json") {
    if (!selected) return;
    await runAction(`download-${format}`, async () => {
      const { blob } = await fetchAccountDownload(`/api/documents/${selected.id}/${format}`);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${selected.codigo_generacion}.${format}`;
      link.click();
      URL.revokeObjectURL(href);
    });
  }

  async function downloadF960(format: "csv" | "xlsx") {
    await runAction(`export-${format}`, async () => {
      const { blob, contentDisposition } = await fetchAccountDownload(`/api/exports/f960.${format}?${exportParams(exportStartDate, exportEndDate)}`);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filenameFromDisposition(contentDisposition, `f960.${format}`);
      link.click();
      URL.revokeObjectURL(href);
      setToast(format === "csv" ? "CSV F960 descargado" : "XLSX de inspección descargado");
    });
  }

  async function downloadContacts() {
    await runAction("export-contacts", async () => {
      const environment = emissionEnvironment?.environment;
      if (!environment) {
        throw new Error("No se pudo determinar el ambiente activo.");
      }
      const selectedColumns = CONTACT_EXPORT_COLUMNS.filter((column) => contactsColumns.has(column.key)).map((column) => column.key);
      if (selectedColumns.length === 0) {
        throw new Error("Seleccione al menos una columna para exportar.");
      }
      const params = new URLSearchParams({ environment });
      const range = contactsPeriodRange(contactsPeriod, contactsFrom, contactsTo);
      if (range) {
        params.set("from", range.from);
        params.set("to", range.to);
      }
      if (contactsGiftType !== "todos") {
        params.set("giftType", contactsGiftType);
      }
      // Only send `columns` when a strict subset is chosen, so the default full export
      // keeps its original request shape (and audit).
      if (selectedColumns.length < CONTACT_EXPORT_COLUMNS.length) {
        params.set("columns", selectedColumns.join(","));
      }
      const { blob, contentDisposition } = await fetchAccountDownload(`/api/exports/contacts?${params.toString()}`);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filenameFromDisposition(contentDisposition, "contactos-donantes.csv");
      link.click();
      URL.revokeObjectURL(href);
      setToast("Contactos exportados");
    });
  }

  async function verifyBackup(month: string) {
    await runAction(`backup-verify-${month}`, async () => {
      const result = await accountApi<BackupVerifyResult>(`/api/admin/backups/${month}/verify`, { method: "POST" });
      setBackupVerifyByMonth((current) => ({ ...current, [month]: result }));
      setToast(result.ok ? `Respaldo de ${month} verificado: íntegro.` : `Respaldo de ${month}: se detectaron discrepancias.`);
    });
  }

  async function downloadBackup(month: string, table: string) {
    await runAction(`backup-download-${month}-${table}`, async () => {
      const { blob, contentDisposition } = await fetchAccountDownload(`/api/admin/backups/${month}/download?table=${encodeURIComponent(table)}`);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filenameFromDisposition(
        contentDisposition,
        table === "manifest" ? `retention-${month}-manifest.json` : `retention-${month}-${table}.ndjson`
      );
      link.click();
      URL.revokeObjectURL(href);
    });
  }

  // Downloads the whole month's archive (every table object + manifest) as one ZIP.
  // Keyed by `backup-download-all-<month>` so only that row's button shows a busy state.
  async function downloadAllBackup(month: string) {
    await runAction(`backup-download-all-${month}`, async () => {
      const { blob, contentDisposition } = await fetchAccountDownload(`/api/admin/backups/${month}/download-all`);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filenameFromDisposition(contentDisposition, `respaldo-${month}.zip`);
      link.click();
      URL.revokeObjectURL(href);
      setToast(`Respaldo completo de ${month} descargado.`);
    });
  }

  async function exportBackupMonth(month: string) {
    const confirmed = window.confirm(`¿Desea generar el respaldo del mes ${month}? Se exportarán todas las tablas legales a R2.`);
    if (!confirmed) {
      return;
    }
    await runAction(`backup-export-${month}`, async () => {
      await accountApi(`/api/admin/retention-export?month=${month}`, { method: "POST" });
      setBackups((await accountApi<BackupsGrid>("/api/admin/backups")).months);
      setToast(`Respaldo del mes ${month} generado.`);
    });
  }

  async function sendAnnualCertificates() {
    const preview = certificatePreview;
    if (!preview || preview.withEmail === 0) {
      setToast("No hay donantes con correo para el año seleccionado.");
      return;
    }
    const confirmed = window.confirm(
      `Se enviarán constancias del año ${preview.year} a ${preview.withEmail} donante(s) con correo. ` +
        `${preview.withoutEmail} donante(s) sin correo se omitirán. ¿Desea continuar?`
    );
    if (!confirmed) {
      return;
    }
    await runAction("certificates-send", async () => {
      const result = await accountApi<AnnualCertificateSendResult>(`/api/certificates/annual/send?year=${preview.year}`, { method: "POST" });
      setToast(`Constancias ${result.year}: ${result.sent} enviadas, ${result.skipped} omitidas, ${result.failed} fallidas`);
      setCertificatePreview(await accountApi<AnnualCertificatePreview>(certificatePreviewPath(certificateYear, debouncedCertificateSearch)));
    });
  }

  // Single-donor send (also the resend path): posts the donor's grouping key. Keyed by
  // `certificates-send-<groupKey>` so only that row shows a busy state while it runs.
  async function sendDonorCertificate(donor: AnnualCertificatePreviewDonor) {
    const preview = certificatePreview;
    if (!preview) {
      return;
    }
    if (!donor.hasEmail) {
      setToast("Este donante no tiene correo registrado, por lo que no se le puede enviar la constancia.");
      return;
    }
    const confirmed = window.confirm(
      `Se enviará la constancia del año ${preview.year} a ${donor.donorName}. ¿Desea continuar?`
    );
    if (!confirmed) {
      return;
    }
    await runAction(`certificates-send-${donor.groupKey}`, async () => {
      const result = await accountApi<AnnualCertificateSendResult>(`/api/certificates/annual/send?year=${preview.year}`, {
        method: "POST",
        body: { donor: donor.groupKey }
      });
      setToast(
        result.sent > 0
          ? `Constancia ${result.year} enviada a ${donor.donorName}.`
          : `No se pudo enviar la constancia a ${donor.donorName}.`
      );
      setCertificatePreview(await accountApi<AnnualCertificatePreview>(certificatePreviewPath(certificateYear, debouncedCertificateSearch)));
    });
  }

  async function createUser() {
    const passwordError = passwordPolicyMessage(newUser.password);
    if (passwordError) {
      setToast(passwordError);
      return;
    }
    await runAction("create-user", async () => {
      const created = await accountApi<{ user: User }>("/api/users", { method: "POST", body: newUser });
      setToast(`Usuario creado: ${created.user.email}`);
      setNewUser({ name: "", email: "", role: "VIEWER", password: "" });
      await refresh();
    });
  }

  function openUserSettings(target: User) {
    setSelectedUserId(target.id);
    setUserSettings({
      name: target.name,
      email: target.email,
      role: target.role,
      disabled: Boolean(target.disabled_at),
      password: ""
    });
  }

  function closeUserSettings() {
    setSelectedUserId(null);
    setUserSettings(emptyUserSettings());
  }

  async function saveUserSettings() {
    if (!selectedUserId) return;
    const name = userSettings.name.trim();
    const email = userSettings.email.trim();
    if (!name || !email) {
      setToast("Ingrese nombre y correo del usuario");
      return;
    }
    await runAction("user-settings", async () => {
      const result = await accountApi<{ user: User }>(`/api/users/${selectedUserId}`, {
        method: "PATCH",
        body: {
          name,
          email,
          role: userSettings.role,
          disabled: userSettings.disabled
        }
      });
      setUsers((current) => current.map((candidate) => candidate.id === result.user.id ? result.user : candidate));
      if (user?.id === result.user.id) {
        setUser(result.user);
        localStorage.setItem("diezmos_user", JSON.stringify(result.user));
      }
      setUserSettings({ ...userSettingsFromUser(result.user), password: "" });
      setToast(`Usuario actualizado: ${result.user.email}`);
    });
  }

  async function resetUserPassword() {
    if (!selectedUserId) return;
    const passwordError = passwordPolicyMessage(userSettings.password);
    if (passwordError) {
      setToast(passwordError);
      return;
    }
    await runAction("user-password", async () => {
      await accountApi(`/api/users/${selectedUserId}/password`, { method: "POST", body: { password: userSettings.password } });
      setUserSettings((current) => ({ ...current, password: "" }));
      setToast("Contraseña restablecida");
    });
  }

  async function updateCredentials() {
    await runAction("credentials", async () => {
      const result = await accountApi<{ updated: string[]; deleted: string[] }>("/api/credentials", { method: "POST", body: credentialInput });
      setToast(`Secretos actualizados: ${result.updated.length}`);
      setCredentialInput(emptyCredentialInput(credentialInput.environment));
      setCredentials((await accountApi<{ credentials: CredentialStatus }>("/api/credentials")).credentials);
    });
  }

  async function updateEmissionEnvironment(environment: EmissionEnvironmentState["environment"]) {
    if (emissionEnvironment?.environment === environment && emissionEnvironment.source === "setting") {
      return;
    }
    await runAction("emission-environment", async () => {
      const result = await accountApi<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment", {
        method: "PUT",
        body: { environment }
      });
      setEmissionEnvironment(result.emissionEnvironment);
      setToast(`Ambiente de emisión cambiado a ${environmentLabel(environment)}`);
    });
  }

  function applyEmailTemplates(settings: EmailTemplateSettings) {
    setEmailTemplates(settings);
    setEmailTemplateDraft(cloneEmailTemplates(settings.templates));
  }

  function applyAlertEmail(value: string) {
    setAlertEmailDraft(value);
  }

  async function updateAlertEmail() {
    await runAction("alert-email", async () => {
      const result = await accountApi<AlertEmailState>("/api/settings/alert-email", {
        method: "PUT",
        body: { alertEmail: alertEmailDraft.trim() }
      });
      applyAlertEmail(result.alertEmail);
      setToast(result.alertEmail ? "Correos de alertas actualizados" : "Alertas operativas desactivadas");
    });
  }

  async function updateEmailTemplates() {
    await runAction("email-templates", async () => {
      const result = await accountApi<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates", {
        method: "PUT",
        body: { templates: emailTemplateDraft }
      });
      applyEmailTemplates(result.emailTemplates);
      setToast("Plantillas de correo actualizadas");
    });
  }

  async function bootstrapCredentialWriter(cloudflareToken: string): Promise<boolean> {
    setBusy("credential-writer");
    try {
      const result = await accountApi<{ updated: string[]; credentials: CredentialStatus }>("/api/credentials/writer-token", {
        method: "POST",
        body: { token: cloudflareToken }
      });
      setCredentials(result.credentials);
      setToast("Guardado de credenciales habilitado");
      return true;
    } catch (error) {
      handleApiFailure(error);
      return false;
    } finally {
      if (accountStateGuardRef.current.isCurrent(renderAccountStateVersion)) setBusy("");
    }
  }

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    try {
      await runAccountOperation(action);
    } catch (error) {
      handleApiFailure(error);
    } finally {
      if (accountStateGuardRef.current.isCurrent(renderAccountStateVersion)) setBusy("");
    }
  }

  // Appends the next audit page (keyset cursor); the text filter keeps operating
  // over everything loaded so far.
  async function loadMoreAudit() {
    if (!auditCursor || auditLoadingMore) {
      return;
    }
    setAuditLoadingMore(true);
    try {
      const pageResult = await accountApi<{ audit: AuditRow[]; nextCursor: string | null }>(
        `/api/audit?limit=50&cursor=${encodeURIComponent(auditCursor)}`
      );
      setAudit((current) => [...current, ...pageResult.audit]);
      setAuditCursor(pageResult.nextCursor);
    } catch (err) {
      handleApiFailure(err);
    } finally {
      if (accountStateGuardRef.current.isCurrent(renderAccountStateVersion)) setAuditLoadingMore(false);
    }
  }

  if (!brandingReady) {
    return <StartupShell />;
  }

  if (!token || !user) {
    return (
      <AuthScreen
        initialResetToken={initialResetToken}
        notice={authNotice}
        branding={branding}
        onLogin={login}
        onBootstrap={bootstrap}
        onRequestReset={requestPasswordReset}
        onConfirmReset={confirmPasswordReset}
        bootstrapAvailable={shouldShowBootstrapMode(authBootstrapStatus)}
      />
    );
  }

  function handleApiFailure(error: unknown) {
    if (error instanceof StaleAccountStateError) {
      return;
    }
    if (isApiError(error) && error.status === 401) {
      expireSession();
      return;
    }
    setToast(userFacingErrorMessage(error instanceof Error ? error.message : String(error)));
  }

  function expireSession() {
    localStorage.removeItem("diezmos_token");
    localStorage.removeItem("diezmos_user");
    resetAccountState();
    setToken("");
    setUser(null);
    setAuthNotice("Su sesión expiró. Inicie sesión de nuevo.");
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem("diezmos_sidebar_collapsed", next ? "true" : "false");
      return next;
    });
  }

  function changeView(nextView: View) {
    if (nextView === "failures" && view !== "failures") {
      setPreCdeFailuresLoading(true);
    }
    if (nextView !== "failures") {
      clearPreCdeFailures();
    }
    setView(nextView);
  }

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="sidebar-head">
          <div className="brand">
            {brandingLogoSrc(branding.logoVersion) ? (
              <img className="brand-logo" src={brandingLogoSrc(branding.logoVersion) ?? undefined} alt={branding.displayName} />
            ) : (
              <ShieldCheck size={24} />
            )}
            <div className="brand-text">
              <strong>{branding.displayName}</strong>
              <span>DiezmosSV</span>
            </div>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expandir menú lateral" : "Contraer menú lateral"}
            title={sidebarCollapsed ? "Expandir menú lateral" : "Contraer menú lateral"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <nav>
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => changeView(item.id)} aria-label={item.label} title={item.label}>
                <Icon size={18} />
                <span className="nav-label">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="profile">
          <span>{user.name}</span>
          <strong>{roleLabel(user.role)}</strong>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
            <p>{viewSubtitle(view)}</p>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" onClick={logout} title="Cerrar sesión">
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {(view === "documents" || view === "failures") && (
          <>
            {view === "documents" && can(user, "OPERATOR") && (
              <TestDtePanel
                input={testInput}
                busy={busy === "test-dte"}
                advancedBusy={busy === "advanced-template"}
                onChange={setTestInput}
                onSubmit={createTestDte}
                onAdvanced={openAdvancedDte}
              />
            )}
            <section className="document-layout">
              <div className="table-panel">
              <div className="toolbar">
                <label className="search">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Buscar código, donante o correo"
                    aria-label="Buscar código, donante o correo"
                  />
                </label>
                {view !== "failures" && (
                  <select value={status} onChange={(event) => setStatus(event.target.value)}>
                    <option value="">Todos</option>
                    <option value="ACCEPTED">Aceptados</option>
                    <option value="TRANSMISSION_PENDING">En trámite</option>
                    <option value="CONTINGENCY_PENDING">Histórico sin sello</option>
                    <option value={FAILURE_VIEW_STATUSES}>Fallos/rechazos</option>
                    <option value="REJECTED">Rechazados</option>
                    <option value="FAILED">Fallidos</option>
                    <option value="INVALIDATED">Invalidados</option>
                  </select>
                )}
                <button className="icon-button" onClick={() => void refresh()} title="Actualizar">
                  <RefreshCw size={17} />
                </button>
              </div>
              {view === "failures" && (
                <PreCdeFailuresPanel
                  items={visiblePreCdeFailures}
                  error={preCdeFailuresError}
                  loading={preCdeFailuresLoading}
                  busy={busy}
                  canRetry={can(user, "OPERATOR")}
                  onRetry={retryPreCdeFailure}
                  onCorrect={(item) => openFiscalCorrection(
                    { kind: "WOMPI_EVENT", id: item.id },
                    {
                      amountLabel: formatCents(item.amount_cents),
                      environmentLabel: environmentLabel(item.environment),
                      issuerLabel: branding.displayName
                    }
                  )}
                />
              )}
              <Stats documents={documents} onlyFailed={view === "failures"} preCdeFailureCount={visiblePreCdeFailures.length} />
              <DocumentTable
                documents={documents}
                selectedId={selected?.id}
                showCorrectionAttention={view === "failures"}
                onSelect={setSelectedId}
              />
              <DocumentListFooter
                count={documents.length}
                hasMore={documentsHasMore}
                loading={documentsLoadingMore}
                onLoadMore={loadMoreDocuments}
                emptyMessage={
                  view === "failures" && (visiblePreCdeFailures.length > 0 || preCdeFailuresError)
                    ? "Sin CDE emitidos fallidos o rechazados"
                    : documentListEmptyMessage(view === "failures" ? "failures" : "documents", query, preCdeFailuresLoading)
                }
              />
            </div>
              <DetailPanel
                selected={selected}
                audit={selectedDocumentAudit}
                receiptEmailDelivery={selectedReceiptEmailDelivery}
                fiscalReconciliation={selectedFiscalReconciliation}
                fiscalCorrectionData={selectedFiscalCorrectionData}
                donorDataVerified={selected?.id === donorVerifiedDocId}
                busy={busy}
                now={now}
                onAction={documentAction}
                canCorrect={can(user, "OPERATOR")}
                onCorrect={(target) => {
                  if (!selected) return;
                  void openFiscalCorrection(target, {
                    amountLabel: formatCents(selected.amount_cents),
                    environmentLabel: environmentLabel(selected.environment),
                    issuerLabel: branding.displayName
                  });
                }}
                onInvalidateRequest={(id) => {
                  setInvalidationForm(defaultInvalidationForm());
                  setPendingInvalidationId(id);
                }}
                onDownload={downloadDocument}
                emailEditingId={emailEditingId}
                emailDraft={emailDraft}
                onStartEmailEdit={(document) => {
                  setEmailEditingId(document.id);
                  setEmailDraft(document.donor_email ?? "");
                }}
                onEmailDraftChange={setEmailDraft}
                onCancelEmailEdit={() => {
                  setEmailEditingId(null);
                  setEmailDraft("");
                }}
                onSaveEmail={saveDocumentEmail}
              />
            </section>
          </>
        )}

        {view === "contingency" && (
          <ContingencyPanel />
        )}

        {view === "audit" && (
          <section className="single-panel">
            <div className="toolbar">
              <label className="search">
                <Search size={16} />
                <input
                  placeholder="Filtrar por acción, documento o usuario"
                  value={auditQuery}
                  onChange={(event) => setAuditQuery(event.target.value)}
                />
              </label>
              <button onClick={() => void refresh()}>
                <RefreshCw size={16} />
                Actualizar
              </button>
            </div>
            <AuditTable rows={filterAuditEntries(audit, auditQuery)} />
            <div className="audit-pagination">
              <small>
                {auditQuery.trim()
                  ? `${filterAuditEntries(audit, auditQuery).length} de ${audit.length} registros cargados coinciden con el filtro.`
                  : `${audit.length} registros cargados.`}
              </small>
              {auditCursor && (
                <button type="button" disabled={auditLoadingMore} onClick={() => void loadMoreAudit()}>
                  {auditLoadingMore ? "Cargando…" : "Cargar más"}
                </button>
              )}
            </div>
          </section>
        )}

        {view === "analytics" && (
          <AnalyticsView
            analytics={analytics}
            loading={analyticsLoading}
            environment={analyticsEnvironment ?? "00"}
            activeEnvironment={analyticsEnvironment}
            presets={analyticsPresets}
            presetId={analyticsPresetId}
            from={analyticsRange.from}
            to={analyticsRange.to}
            giftFilter={analyticsGiftFilter}
            onEnvironmentChange={setAnalyticsEnvironment}
            onPresetChange={(presetId) => {
              setAnalyticsPresetId(presetId);
              // Seed the custom inputs from the chosen preset so switching to
              // "Personalizado" starts from the last-selected bounds, not stale ones.
              const preset = analyticsPresets.find((candidate) => candidate.id === presetId);
              if (preset) {
                setAnalyticsFrom(preset.from);
                setAnalyticsTo(preset.to);
              }
            }}
            onFromChange={setAnalyticsFrom}
            onToChange={setAnalyticsTo}
            onGiftFilterChange={setAnalyticsGiftFilter}
          />
        )}

        {view === "users" && (
          <section className="single-panel">
            {can(user, "ADMIN") ? (
              <>
                <UserCreateForm input={newUser} currentUser={user} busy={busy === "create-user"} onChange={setNewUser} onSubmit={createUser} />
                <UserTable users={users} selectedId={selectedUserId} onSelect={openUserSettings} />
                {selectedUser && (
                  <UserSettingsModal
                    user={selectedUser}
                    currentUser={user}
                    input={userSettings}
                    busy={busy}
                    onChange={setUserSettings}
                    onClose={closeUserSettings}
                    onSave={saveUserSettings}
                    onResetPassword={resetUserPassword}
                  />
                )}
              </>
            ) : (
              <p>No tiene permisos para administrar usuarios.</p>
            )}
          </section>
        )}

        {view === "exports" && can(user, "ADMIN") && (
          <>
            <ExportPanel
              startDate={exportStartDate}
              endDate={exportEndDate}
              preview={exportPreview}
              busy={busy}
              onStartDateChange={setExportStartDate}
              onEndDateChange={setExportEndDate}
              onDownload={downloadF960}
            />
            <AnnualCertificatePanel
              year={certificateYear}
              yearOptions={certificateYearOptions()}
              preview={certificatePreview}
              search={certificateSearch}
              busy={busy === "certificates-send"}
              rowBusy={busy}
              onYearChange={setCertificateYear}
              onSearchChange={setCertificateSearch}
              onSend={sendAnnualCertificates}
              onSendDonor={sendDonorCertificate}
            />
            <ContactsExportPanel
              environment={emissionEnvironment?.environment ?? null}
              busy={busy === "export-contacts"}
              period={contactsPeriod}
              from={contactsFrom}
              to={contactsTo}
              giftType={contactsGiftType}
              columns={contactsColumns}
              onPeriodChange={setContactsPeriod}
              onFromChange={setContactsFrom}
              onToChange={setContactsTo}
              onGiftTypeChange={setContactsGiftType}
              onColumnToggle={(key) =>
                setContactsColumns((current) => {
                  const next = new Set(current);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  return next;
                })
              }
              onDownload={downloadContacts}
            />
            <BackupsPanel
              months={backups}
              verifyByMonth={backupVerifyByMonth}
              busy={busy}
              onVerify={verifyBackup}
              onDownload={downloadBackup}
              onDownloadAll={downloadAllBackup}
              onExport={exportBackupMonth}
            />
            <OnlineDonationsPanel intents={donationIntents} />
          </>
        )}

        {view === "credentials" && can(user, "OWNER") && (
          <CredentialsPanel
            status={credentials}
            emissionEnvironment={emissionEnvironment}
            emailTemplates={emailTemplates}
            emailTemplateDraft={emailTemplateDraft}
            alertEmailDraft={alertEmailDraft}
            branding={branding}
            token={token}
            input={credentialInput}
            busy={busy === "credentials"}
            emissionBusy={busy === "emission-environment"}
            templateBusy={busy === "email-templates"}
            alertEmailBusy={busy === "alert-email"}
            writerBusy={busy === "credential-writer"}
            onChange={setCredentialInput}
            onSubmit={updateCredentials}
            onEmailTemplateChange={(type, patch) => {
              setEmailTemplateDraft((current) => ({
                ...current,
                [type]: {
                  subject: current[type]?.subject ?? "",
                  body: current[type]?.body ?? "",
                  ...patch
                }
              }));
            }}
            onEmailTemplateSubmit={updateEmailTemplates}
            onEmissionEnvironmentChange={updateEmissionEnvironment}
            onAlertEmailChange={setAlertEmailDraft}
            onAlertEmailSubmit={updateAlertEmail}
            onBrandingSave={(next) => {
              applyBranding(next);
              setBranding(next);
            }}
            onBootstrapWriter={bootstrapCredentialWriter}
            runAccountOperation={runAccountOperation}
            onRefresh={async () => {
              const [credentialResult, environmentResult, emailTemplateResult, alertEmailResult] = await Promise.all([
                accountApi<{ credentials: CredentialStatus }>("/api/credentials"),
                accountApi<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment"),
                accountApi<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates"),
                accountApi<AlertEmailState>("/api/settings/alert-email")
              ]);
              setCredentials(credentialResult.credentials);
              setEmissionEnvironment(environmentResult.emissionEnvironment);
              applyEmailTemplates(emailTemplateResult.emailTemplates);
              applyAlertEmail(alertEmailResult.alertEmail);
            }}
          />
        )}
      </main>
      {advancedDteOpen && can(user, "OPERATOR") && (
        <AdvancedDteModal
          form={advancedDteForm}
          preview={JSON.stringify(advancedDraftFromForm(advancedDteTemplate, advancedDteForm), null, 2)}
          step={advancedDteStep}
          error={advancedDteError}
          busy={busy === "advanced-dte" || busy === "advanced-template"}
          onChange={setAdvancedDteForm}
          onClose={() => setAdvancedDteOpen(false)}
          onReload={openAdvancedDte}
          onStepChange={setAdvancedDteStep}
          onSubmit={createAdvancedDte}
        />
      )}
      {pendingInvalidation && (
        <InvalidationConfirmDialog
          document={pendingInvalidation}
          busy={busy === "invalidate"}
          now={now}
          form={invalidationForm}
          onFormChange={setInvalidationForm}
          onCancel={() => setPendingInvalidationId(null)}
          onConfirm={() => void documentAction("invalidate", pendingInvalidation)}
        />
      )}
      {fiscalCorrectionTarget && fiscalCorrectionData && (
        <FiscalCorrectionDialog
          key={fiscalCorrectionTargetKey(fiscalCorrectionTarget)}
          open
          data={fiscalCorrectionData}
          initialDraft={fiscalCorrectionDraftForTarget(
            fiscalCorrectionSubmissions.current,
            fiscalCorrectionTargetKey(fiscalCorrectionTarget),
            fiscalCorrectionData.receptor
          )}
          retryingSubmittedPayload={fiscalCorrectionSubmissions.current.has(
            fiscalCorrectionTargetKey(fiscalCorrectionTarget)
          )}
          protectedContext={fiscalCorrectionProtectedContext}
          busy={busy === "fiscal-correction-submit"}
          error={fiscalCorrectionError}
          onCancel={closeFiscalCorrection}
          onSubmit={submitFiscalCorrection}
          onReissue={
            fiscalCorrectionTarget.kind === "WOMPI_EVENT" ? undefined : reissueFiscalDocument
          }
        />
      )}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <button className="toast" onClick={() => setToast("")}>
            {toast}
          </button>
        )}
      </div>
    </div>
  );
}

function ContingencyPanel() {
  return (
    <section className="contingency-dashboard">
      <div className="contingency-panel contingency-summary-panel">
        <div className="panel-head">
          <div>
            <h2>El CDE no usa modo de contingencia</h2>
            <p>
              La normativa no contempla contingencia para el CDE: la tabla de validaciones del
              evento de contingencia (campo 35) excluye el tipo 15. Cuando el Ministerio de
              Hacienda no está disponible, el CDE se emite con forma normal, queda
              «En trámite», el donante recibe de inmediato su comprobante transitorio y el
              sistema reintenta la transmisión cada 15 minutos hasta obtener el Sello de
              Recepción.
            </p>
          </div>
        </div>
      </div>
      <div className="contingency-flow" aria-label="Flujo de reintento automático">
        <article className="contingency-panel contingency-rule-panel warn">
          <Unplug size={18} />
          <span>Hacienda no responde</span>
          <strong>Queda «En trámite»</strong>
          <p>El CDE se conserva con forma normal; no se abre contingencia ni se cambia el tipo.</p>
        </article>
        <article className="contingency-panel contingency-rule-panel neutral">
          <Mail size={18} />
          <span>Donante informado</span>
          <strong>Correo transitorio inmediato</strong>
          <p>El donante recibe su comprobante provisional para sus registros sin esperar al sello.</p>
        </article>
        <article className="contingency-panel contingency-rule-panel retry">
          <RefreshCw size={18} />
          <span>Cron automático</span>
          <strong>Reintento cada 15 minutos</strong>
          <p>El sistema vuelve a transmitir los CDE pendientes hasta que Hacienda confirme.</p>
        </article>
        <article className="contingency-panel contingency-rule-panel ok">
          <CheckCircle2 size={18} />
          <span>Cierre normal</span>
          <strong>Sello de Recepción</strong>
          <p>Cuando llega el sello, el CDE pasa a aceptado y se envía el comprobante definitivo.</p>
        </article>
      </div>
      <div className="contingency-panel contingency-operator-panel">
        <strong>Qué revisar en operación</strong>
        <p>
          Use <b>Documentos</b> con el filtro <b>En trámite</b> para ver CDE esperando respuesta de
          Hacienda. Use <b>Fallos</b> solo cuando el sistema marque errores o rechazos que sí requieren
          intervención manual.
        </p>
      </div>
    </section>
  );
}

function TestDtePanel({
  input,
  busy,
  advancedBusy,
  onChange,
  onSubmit,
  onAdvanced
}: {
  input: TestDteInput;
  busy: boolean;
  advancedBusy: boolean;
  onChange: (input: TestDteInput) => void;
  onSubmit: () => Promise<void>;
  onAdvanced: () => Promise<void>;
}) {
  return (
    <section className="test-panel">
      <div>
        <h2>CDE rápido</h2>
        <p>Registre una donación recibida en persona y emita su comprobante al instante.</p>
      </div>
      <div className="test-grid">
        <input value={input.amount} onChange={(event) => onChange({ ...input, amount: event.target.value })} placeholder="Monto" aria-label="Monto" inputMode="decimal" />
        <input className="quick-donor-name" value={input.donorName} onChange={(event) => onChange({ ...input, donorName: event.target.value })} placeholder="Nombre o razón social" aria-label="Nombre o razón social" />
        <span className="quick-document-type">
          <CatalogSelect
            value={input.donorDocumentType}
            options={CAT022_DOCUMENT_TYPES}
            showCodes={false}
            onChange={(donorDocumentType) => onChange({ ...input, donorDocumentType })}
            ariaLabel="Tipo de documento del donante"
          />
        </span>
        <input value={input.donorDocument} onChange={(event) => onChange({ ...input, donorDocument: event.target.value })} placeholder="Documento" aria-label="Documento" />
        <input value={input.donorEmail} onChange={(event) => onChange({ ...input, donorEmail: event.target.value })} placeholder="Correo" aria-label="Correo" type="email" />
        <input value={input.donorPhone} onChange={(event) => onChange({ ...input, donorPhone: event.target.value })} placeholder="Teléfono" aria-label="Teléfono" />
        <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
          <FlaskConical size={16} />
          {busy ? "Generando" : "Generar"}
        </button>
        <button disabled={advancedBusy} onClick={() => void onAdvanced()}>
          <Braces size={16} />
          {advancedBusy ? "Preparando" : "CDE avanzado"}
        </button>
      </div>
    </section>
  );
}

function AdvancedDteModal({
  form,
  preview,
  step,
  error,
  busy,
  onChange,
  onClose,
  onReload,
  onStepChange,
  onSubmit
}: {
  form: AdvancedCdeFormInput;
  preview: string;
  step: number;
  error: string;
  busy: boolean;
  onChange: (form: AdvancedCdeFormInput) => void;
  onClose: () => void;
  onReload: () => Promise<void>;
  onStepChange: (step: number) => void;
  onSubmit: () => Promise<void>;
}) {
  const activeStep = Math.max(0, Math.min(step, advancedCdeSteps.length - 1));
  const active = advancedCdeSteps[activeStep];
  const donorDocumentError = isDuiDocumentType(form.donorTipoDocumento) ? duiValidationMessage(form.donorDocument) : "";
  const update = (patch: Partial<AdvancedCdeFormInput>) => onChange({ ...form, ...patch });
  const municipalityOptions = getCat013Municipalities(form.departamento);
  const districtOptions = getCat008Districts(form.departamento);
  const updateDepartment = (departamento: string) => {
    const municipalities = getCat013Municipalities(departamento);
    const districts = getCat008Districts(departamento);
    update({
      departamento,
      municipio: catalogSelectValue(municipalities, form.municipio) || municipalities[0]?.code || "",
      distrito: catalogSelectValue(districts, form.distrito) || districts[0]?.code || ""
    });
  };
  const updateActivity = (donorCodActividad: string) => {
    update({
      donorCodActividad,
      donorDescActividad: findCatalogOption(CAT019_ACTIVITIES, donorCodActividad)?.label ?? ""
    });
  };
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogDismiss(dialogRef, onClose, false);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="advanced-dte-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-dte-title"
      >
        <header>
          <div>
            <h2 id="advanced-dte-title">Crear CDE avanzado</h2>
            <p>Revise y edite cada sección del comprobante antes de transmitirlo al Ministerio de Hacienda.</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            <X size={17} />
          </button>
        </header>
        <div className="advanced-dte-body">
          <nav className="advanced-steps" aria-label="Pasos CDE avanzado">
            {advancedCdeSteps.map((item, index) => (
              <button
                key={item.id}
                className={index === activeStep ? "active" : ""}
                type="button"
                onClick={() => onStepChange(index)}
              >
                <span>{index + 1}</span>
                <strong>{item.label}</strong>
              </button>
            ))}
          </nav>
          <div className="advanced-step-panel">
            <div className="advanced-step-head">
              <div>
                <h3>{active.label}</h3>
                <p>{active.description}</p>
              </div>
              <span>{active.id}</span>
            </div>
            {active.id === "receptor" && (
              <div className="advanced-form-grid">
                <AdvancedField label="Nombre del donante">
                  <input value={form.donorName} onChange={(event) => update({ donorName: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Tipo documento">
                  <CatalogSelect value={form.donorTipoDocumento} options={CAT022_DOCUMENT_TYPES} onChange={(donorTipoDocumento) => update({ donorTipoDocumento })} />
                </AdvancedField>
                <AdvancedField label="Número documento">
                  <input
                    value={form.donorDocument}
                    onChange={(event) => update({ donorDocument: event.target.value })}
                    aria-invalid={donorDocumentError ? "true" : "false"}
                  />
                  {donorDocumentError && <small className="field-error">{donorDocumentError}</small>}
                </AdvancedField>
                <AdvancedField label="NRC">
                  <input value={form.donorNrc} onChange={(event) => update({ donorNrc: event.target.value })} placeholder="Opcional" />
                </AdvancedField>
                <AdvancedField label="Actividad económica" span>
                  <CatalogSelect value={form.donorCodActividad} options={CAT019_ACTIVITIES} onChange={updateActivity} placeholder="No aplica" />
                </AdvancedField>
                <AdvancedField label="Correo">
                  <input value={form.donorEmail} onChange={(event) => update({ donorEmail: event.target.value })} type="email" />
                </AdvancedField>
                <AdvancedField label="Teléfono">
                  <input value={form.donorPhone} onChange={(event) => update({ donorPhone: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Domicilio fiscal">
                  <CatalogSelect value={form.codDomiciliado} options={CAT032_DOMICILE} onChange={(codDomiciliado) => update({ codDomiciliado })} />
                </AdvancedField>
                <AdvancedField label="País">
                  <CatalogSelect value={form.codPais} options={CAT020_COUNTRIES} onChange={(codPais) => update({ codPais })} />
                </AdvancedField>
              </div>
            )}
            {active.id === "direccion" && (
              <div className="advanced-form-grid">
                <AdvancedField label="Departamento">
                  <CatalogSelect value={form.departamento} options={CAT012_DEPARTMENTS} onChange={updateDepartment} />
                </AdvancedField>
                <AdvancedField label="Municipio">
                  <CatalogSelect value={form.municipio} options={municipalityOptions} onChange={(municipio) => update({ municipio })} placeholder="Seleccione" />
                </AdvancedField>
                <AdvancedField label="Distrito">
                  <CatalogSelect value={form.distrito} options={districtOptions} onChange={(distrito) => update({ distrito })} placeholder="Seleccione" />
                </AdvancedField>
                <AdvancedField label="País de la dirección">
                  <CatalogSelect value={form.codPais} options={CAT020_COUNTRIES} onChange={(codPais) => update({ codPais })} />
                </AdvancedField>
                <AdvancedField label="Complemento / dirección completa" span>
                  <textarea
                    value={form.direccionComplemento}
                    onChange={(event) => update({ direccionComplemento: event.target.value })}
                    rows={4}
                    placeholder="Calle, número, colonia…"
                  />
                </AdvancedField>
              </div>
            )}
            {active.id === "donacion" && (
              <div className="advanced-form-grid">
                <AdvancedField label="Tipo donación">
                  <CatalogSelect value={form.tipoDonacion} options={CAT026_DONATION_TYPES} onChange={(tipoDonacion) => update({ tipoDonacion })} />
                </AdvancedField>
                <AdvancedField label="Cantidad">
                  <input value={form.cantidad} onChange={(event) => update({ cantidad: event.target.value })} inputMode="decimal" />
                </AdvancedField>
                <AdvancedField label="Código">
                  <input value={form.codigo} onChange={(event) => update({ codigo: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Unidad medida">
                  <CatalogSelect value={form.uniMedida} options={CAT014_UNITS} onChange={(uniMedida) => update({ uniMedida })} />
                </AdvancedField>
                <AdvancedField label="Tipo depreciación">
                  <input value={form.tipoDepreciacion} onChange={(event) => update({ tipoDepreciacion: event.target.value })} inputMode="numeric" />
                </AdvancedField>
                <AdvancedField label="Valor unitario">
                  <CurrencyInput value={form.valorUni} onChange={(valorUni) => update({ valorUni })} />
                </AdvancedField>
                <AdvancedField label="Valor total">
                  <CurrencyInput value={form.valorTotal} onChange={(valorTotal) => update({ valorTotal })} />
                </AdvancedField>
                <AdvancedField label="Descripción" span>
                  <textarea
                    value={form.descripcion}
                    onChange={(event) => update({ descripcion: event.target.value })}
                    rows={3}
                    placeholder="Ej.: Donación en efectivo"
                  />
                </AdvancedField>
              </div>
            )}
            {active.id === "pago" && (
              <div className="advanced-form-grid">
                <AdvancedField label="Código pago">
                  <CatalogSelect value={form.pagoCodigo} options={CAT017_PAYMENT_FORMS} onChange={(pagoCodigo) => update({ pagoCodigo })} />
                </AdvancedField>
                <AdvancedField label="Referencia pago">
                  <input value={form.pagoReferencia} onChange={(event) => update({ pagoReferencia: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Total en letras" span>
                  <input value={form.totalLetras} onChange={(event) => update({ totalLetras: event.target.value })} placeholder="Opcional" />
                </AdvancedField>
                <AdvancedField label="Documento asociado">
                  <CatalogSelect value={form.documentoCodigo} options={CAT021_ASSOCIATED_DOCUMENTS} onChange={(documentoCodigo) => update({ documentoCodigo })} />
                </AdvancedField>
                <AdvancedField label="Identificación documento">
                  <input value={form.documentoDesc} onChange={(event) => update({ documentoDesc: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Detalle documento">
                  <input value={form.documentoDetalle} onChange={(event) => update({ documentoDetalle: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Campo del apéndice">
                  <input value={form.apendiceCampo} onChange={(event) => update({ apendiceCampo: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Etiqueta del apéndice">
                  <input value={form.apendiceEtiqueta} onChange={(event) => update({ apendiceEtiqueta: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Valor del apéndice" span>
                  <input value={form.apendiceValor} onChange={(event) => update({ apendiceValor: event.target.value })} />
                </AdvancedField>
              </div>
            )}
            {active.id === "revision" && (
              <div className="advanced-review">
                <dl>
                  <div><dt>Donante</dt><dd>{form.donorName || "—"}</dd></div>
                  <div><dt>Documento</dt><dd>{form.donorDocument || "—"}</dd></div>
                  <div><dt>Correo</dt><dd>{form.donorEmail || "—"}</dd></div>
                  <div><dt>Total</dt><dd>${form.valorTotal || "0.00"}</dd></div>
                </dl>
                <pre className="advanced-json-preview">{preview}</pre>
              </div>
            )}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <footer>
          <button disabled={busy} onClick={() => void onReload()}>
            <RefreshCw size={16} />
            Recargar plantilla
          </button>
          <div className="wizard-actions">
            <button disabled={busy || activeStep === 0} onClick={() => onStepChange(activeStep - 1)}>
              <ChevronLeft size={16} />
              Anterior
            </button>
            {activeStep !== advancedCdeSteps.length - 1 && (
              <button disabled={busy} onClick={() => onStepChange(activeStep + 1)}>
                Siguiente
                <ChevronRight size={16} />
              </button>
            )}
          </div>
          {activeStep === advancedCdeSteps.length - 1 && (
            <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
              <FlaskConical size={16} />
              {busy ? "Generando" : "Generar avanzado"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function AdvancedField({ label, span, children }: { label: string; span?: boolean; children: ReactNode }) {
  return (
    <label className={span ? "span-2" : ""}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function CurrencyInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <span className="currency-input">
      <span className="currency-symbol" aria-hidden="true">$</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => onChange(formatCurrencyInputValue(value))}
        inputMode="decimal"
      />
    </span>
  );
}

export function CatalogSelect({
  value,
  options,
  onChange,
  placeholder,
  showCodes = true,
  ariaLabel
}: {
  value: string;
  options: readonly CatalogOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  showCodes?: boolean;
  ariaLabel?: string;
}) {
  const selectedValue = catalogSelectValue(options, value);
  return (
    <select value={selectedValue} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
      {(placeholder || !selectedValue) && <option value="">{placeholder ?? "Seleccione"}</option>}
      {options.map((option) => (
        <option key={`${option.code}-${option.label}`} value={option.code}>
          {showCodes ? `${option.code} - ` : ""}{catalogOptionLabel(option.label)}
        </option>
      ))}
    </select>
  );
}

export function catalogSelectValue(options: readonly CatalogOption[], value: unknown): string {
  const code = normalizeCatalogCode(value);
  return options.some((option) => option.code === code) ? code : "";
}

function AuthScreen({
  initialResetToken,
  notice,
  branding,
  onLogin,
  onBootstrap,
  onRequestReset,
  onConfirmReset,
  bootstrapAvailable
}: {
  initialResetToken: string | null;
  notice?: string;
  branding: Branding;
  onLogin: (email: string, password: string) => Promise<void>;
  onBootstrap: (email: string, name: string, password: string, setupToken: string) => Promise<void>;
  onRequestReset: (email: string) => Promise<void>;
  onConfirmReset: (token: string, password: string) => Promise<void>;
  bootstrapAvailable: boolean;
}) {
  const [resetToken] = useState(initialResetToken);
  const [mode, setMode] = useState<"login" | "bootstrap" | "reset-request" | "reset-confirm">(resetToken ? "reset-confirm" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
  const authLogoSrc = brandingDonorLogoSrc(branding.donorLogoVersion) ?? brandingLogoSrc(branding.logoVersion);

  useEffect(() => {
    if (!bootstrapAvailable && mode === "bootstrap") {
      setMode("login");
    }
  }, [bootstrapAvailable, mode]);

  function switchMode(next: "login" | "reset-request") {
    setMode(next);
    setError("");
    setLocalNotice("");
    setPassword("");
    setConfirmPassword("");
  }

  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            if (mode === "bootstrap") {
              await onBootstrap(email, name, password, setupToken);
            } else if (mode === "reset-request") {
              await onRequestReset(email);
              setLocalNotice("Si el correo está registrado, enviamos un enlace de restablecimiento. Revise su bandeja de entrada.");
            } else if (mode === "reset-confirm") {
              const validationError = passwordResetConfirmValidationMessage(password, confirmPassword);
              if (validationError) {
                setError(validationError);
                return;
              }
              await onConfirmReset(resetToken ?? "", password);
              window.history.replaceState(null, "", window.location.pathname);
              switchMode("login");
              setLocalNotice("Contraseña actualizada. Inicie sesión con su nueva contraseña.");
            } else {
              await onLogin(email, password);
            }
          } catch (err) {
            setError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
          }
        }}
      >
        {authLogoSrc ? (
          <img className="auth-logo" src={authLogoSrc} alt={branding.displayName} />
        ) : (
          <ShieldCheck size={32} />
        )}
        <h1>{branding.displayName}</h1>
        {bootstrapAvailable && (mode === "login" || mode === "bootstrap") && (
          <div className="segmented">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Ingresar</button>
            <button type="button" className={mode === "bootstrap" ? "active" : ""} onClick={() => setMode("bootstrap")}>Crear propietario</button>
          </div>
        )}
        {mode === "reset-request" && <p className="auth-hint">Ingrese su correo y le enviaremos un enlace para restablecer la contraseña.</p>}
        {mode === "reset-confirm" && <p className="auth-hint">Cree su nueva contraseña para completar el restablecimiento.</p>}
        {mode === "bootstrap" && <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nombre" aria-label="Nombre" />}
        {mode !== "reset-confirm" && <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Correo" aria-label="Correo" type="email" />}
        {mode !== "reset-request" && (
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={mode === "reset-confirm" ? "Nueva contraseña" : "Contraseña"}
            aria-label={mode === "reset-confirm" ? "Nueva contraseña" : "Contraseña"}
            type="password"
          />
        )}
        {mode === "reset-confirm" && (
          <input
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Confirme la nueva contraseña"
            aria-label="Confirme la nueva contraseña"
            type="password"
          />
        )}
        {mode === "bootstrap" && (
          <input
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            placeholder="Token de configuración"
            aria-label="Token de configuración"
            type="password"
          />
        )}
        {(localNotice || notice) && !error && <p className="auth-notice">{localNotice || notice}</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          <KeyRound size={16} />
          {mode === "reset-request" ? "Enviar enlace" : mode === "reset-confirm" ? "Guardar contraseña" : "Continuar"}
        </button>
        {mode === "login" && (
          <button type="button" className="link-button" onClick={() => switchMode("reset-request")}>
            ¿Olvidó su contraseña?
          </button>
        )}
        {(mode === "reset-request" || mode === "reset-confirm") && (
          <button type="button" className="link-button" onClick={() => switchMode("login")}>
            Volver a iniciar sesión
          </button>
        )}
      </form>
    </div>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th></th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>Resumen</th><th>IP</th><th>Fecha</th></tr></thead>
        <tbody>
          {rows.map((row) => {
            const context = parseAuditContext(row.actor_context);
            const hasDetail = Boolean(context || row.actor_ip);
            const expanded = expandedId === row.id;
            return (
              <Fragment key={row.id}>
                <tr className={hasDetail ? "audit-row audit-row-expandable" : "audit-row"}>
                  <td className="audit-expand-cell">
                    {hasDetail && (
                      <button
                        type="button"
                        className={expanded ? "audit-expand-toggle expanded" : "audit-expand-toggle"}
                        aria-label={expanded ? "Ocultar contexto" : "Ver contexto"}
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                      >
                        <ChevronDown size={16} />
                      </button>
                    )}
                  </td>
                  <td className="audit-actor" title={row.actor_email ?? undefined}>{auditActorLabel(row)}</td>
                  <td>{auditActionLabel(row.action)}</td>
                  <td>{entityLabel(row.entity_type)}</td>
                  <td>{auditSummaryLabel(row.summary)}</td>
                  <td className="audit-ip">{row.actor_ip ?? "—"}</td>
                  <td className="numeric">{formatElSalvadorDateTime(row.created_at)}</td>
                </tr>
                {expanded && hasDetail && (
                  <tr className="audit-detail-row">
                    <td></td>
                    <td colSpan={6}>
                      <AuditContextDetail ip={row.actor_ip ?? null} context={context} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditContextDetail({ ip, context }: { ip: string | null; context: ReturnType<typeof parseAuditContext> }) {
  const location = auditLocationLabel(context);
  const protocol = auditProtocolLabel(context);
  const items: Array<{ label: string; value: string; title?: string }> = [];
  if (ip) items.push({ label: AUDIT_CONTEXT_LABELS.ip, value: ip });
  if (location) items.push({ label: AUDIT_CONTEXT_LABELS.location, value: location });
  if (context?.asOrganization) items.push({ label: AUDIT_CONTEXT_LABELS.isp, value: context.asOrganization });
  if (context?.userAgent) items.push({ label: AUDIT_CONTEXT_LABELS.browser, value: context.userAgent, title: context.userAgent });
  if (protocol) items.push({ label: AUDIT_CONTEXT_LABELS.protocol, value: protocol });
  if (items.length === 0) {
    return <span className="audit-detail-empty">Sin contexto registrado.</span>;
  }
  return (
    <dl className="audit-context-grid">
      {items.map((item) => (
        <div key={item.label} className="audit-context-item">
          <dt>{item.label}</dt>
          <dd className="audit-context-value" title={item.title}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function UserTable({ users, selectedId, onSelect }: { users: User[]; selectedId: string | null; onSelect: (user: User) => void }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          {users.map((user) => (
            <tr
              key={user.id}
              className={selectedId === user.id ? "selected user-row" : "user-row"}
              tabIndex={0}
              onClick={() => onSelect(user)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(user);
                }
              }}
            >
              <td>{user.name}</td>
              <td>{user.email}</td>
              <td>{roleLabel(user.role)}</td>
              <td><span className={user.disabled_at ? "status invalidated" : "status accepted"}>{user.disabled_at ? "INACTIVA" : "ACTIVA"}</span></td>
              <td className="numeric">
                <button className="table-action" onClick={(event) => { event.stopPropagation(); onSelect(user); }}>
                  <Settings size={15} />
                  Ajustes
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Roles asignables desde la pantalla de usuarios. Solo un OWNER puede otorgar el
// rol OWNER: los ADMIN (y una sesión ausente) no deben ver esa opción.
const ASSIGNABLE_ROLES: Array<{ value: Role; label: string }> = [
  { value: "VIEWER", label: roleLabel("VIEWER") },
  { value: "OPERATOR", label: roleLabel("OPERATOR") },
  { value: "ADMIN", label: roleLabel("ADMIN") },
  { value: "OWNER", label: roleLabel("OWNER") }
];

export function roleOptionsFor(actor: { role: Role } | null): Array<{ value: Role; label: string }> {
  return actor?.role === "OWNER" ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter((option) => option.value !== "OWNER");
}

function UserSettingsModal({
  user,
  currentUser,
  input,
  busy,
  onChange,
  onClose,
  onSave,
  onResetPassword
}: {
  user: User;
  currentUser: User | null;
  input: UserSettingsInput;
  busy: string;
  onChange: (input: UserSettingsInput | ((current: UserSettingsInput) => UserSettingsInput)) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
  onResetPassword: () => Promise<void>;
}) {
  const saving = busy === "user-settings";
  const resetting = busy === "user-password";
  const passwordReady = passwordPolicySatisfied(input.password);
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogDismiss(dialogRef, onClose, saving || resetting);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="user-settings-title">
      <section ref={dialogRef} tabIndex={-1} className="confirm-modal user-settings-modal">
        <header>
          <div>
            <h2 id="user-settings-title">Ajustes de usuario</h2>
            <p>{user.email}</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            <X size={17} />
          </button>
        </header>

        <div className="user-settings-grid">
          <label>
            <span>Nombre</span>
            <input value={input.name} onChange={(event) => onChange({ ...input, name: event.target.value })} />
          </label>
          <label>
            <span>Correo</span>
            <input value={input.email} onChange={(event) => onChange({ ...input, email: event.target.value })} type="email" />
          </label>
          <div className="form-field">
            <div className="field-label-row">
              <span>Rol</span>
              <RoleHelpTooltip />
            </div>
            <select value={input.role} onChange={(event) => onChange({ ...input, role: event.target.value as Role })}>
              {roleOptionsFor(currentUser).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <label className="checkbox-line">
            <input type="checkbox" checked={input.disabled} onChange={(event) => onChange({ ...input, disabled: event.target.checked })} />
            <span>Cuenta deshabilitada (no puede iniciar sesión)</span>
          </label>
        </div>

        <div className="user-password-box">
          <div>
	            <strong>Restablecer contraseña</strong>
	            <span>Mínimo 10 caracteres, mayúscula, minúscula, número y símbolo. Las sesiones activas se revocan.</span>
          </div>
          <div className="user-password-row">
            <input
              value={input.password}
              onChange={(event) => onChange({ ...input, password: event.target.value })}
	              placeholder="Nueva contraseña"
              type="password"
              aria-describedby="user-password-policy"
            />
            <button disabled={resetting || !passwordReady} onClick={() => void onResetPassword()}>
              <KeyRound size={16} />
              {resetting ? "Restableciendo" : "Restablecer"}
            </button>
          </div>
          <PasswordPolicyList value={input.password} />
        </div>

        <footer>
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving} onClick={() => void onSave()}>
            <ShieldCheck size={16} />
            {saving ? "Guardando" : "Guardar cambios"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function PasswordPolicyList({ value }: { value: string }) {
  const failures = new Set(passwordPolicyFailures(value).map((failure) => failure.id));
  return (
    <ul className="password-policy-list" id="user-password-policy">
      {PASSWORD_POLICY_REQUIREMENTS.map((requirement) => {
        const met = value.length > 0 && !failures.has(requirement.id);
        return (
          <li key={requirement.id} className={met ? "met" : ""}>
            <CheckCircle2 size={13} />
            {requirement.label}
          </li>
        );
      })}
    </ul>
  );
}

function RoleHelpTooltip() {
  return (
    <span className="help-tooltip">
      <button type="button" aria-label="Ver permisos de roles">
        <CircleHelp size={14} />
      </button>
      <span className="help-tooltip-panel" role="tooltip">
        <strong>Permisos por rol</strong>
	        <span><b>{roleLabel("VIEWER")}</b>: consulta documentos, auditoría y archivos PDF/JSON.</span>
	        <span><b>{roleLabel("OPERATOR")}</b>: genera, reenvía, reintenta, invalida y ejecuta barridos.</span>
	        <span><b>{roleLabel("ADMIN")}</b>: administra usuarios y exportaciones.</span>
	        <span><b>{roleLabel("OWNER")}</b>: todo lo anterior y gestión de credenciales.</span>
      </span>
    </span>
  );
}

function UserCreateForm({
  input,
  currentUser,
  busy,
  onChange,
  onSubmit
}: {
  input: CreateUserInput;
  currentUser: User | null;
  busy: boolean;
  onChange: (input: CreateUserInput) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <div className="user-create">
      <input value={input.name} onChange={(event) => onChange({ ...input, name: event.target.value })} placeholder="Nombre" aria-label="Nombre" />
      <input value={input.email} onChange={(event) => onChange({ ...input, email: event.target.value })} placeholder="Correo" aria-label="Correo" type="email" />
      <div className="role-create-field">
        <select value={input.role} onChange={(event) => onChange({ ...input, role: event.target.value as Role })} aria-label="Rol">
          {roleOptionsFor(currentUser).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <RoleHelpTooltip />
      </div>
      <input
        value={input.password}
        onChange={(event) => onChange({ ...input, password: event.target.value })}
	        placeholder="Contraseña inicial"
	        aria-label="Contraseña inicial"
	        title="10+ caracteres, mayúscula, minúscula, número y símbolo"
        type="password"
      />
      <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
        <UserPlus size={16} />
        Crear usuario
      </button>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`status ${status.toLowerCase()}`}>{statusLabel(status).toUpperCase()}</span>;
}

function invalidationToast(result: { accepted?: boolean; result?: { estado?: string }; emailSent?: boolean; emailError?: string }): string {
  if (result.accepted) {
    if (result.emailSent) {
      return `Invalidación aceptada por el Ministerio de Hacienda${result.result?.estado ? `: ${result.result.estado}` : ""}. Aviso enviado por correo`;
    }
    if (result.emailError) {
      return `Invalidación aceptada por el Ministerio de Hacienda; falló el correo: ${result.emailError}`;
    }
    return `Invalidación aceptada por el Ministerio de Hacienda${result.result?.estado ? `: ${result.result.estado}` : ""}. El CDE no tiene correo, no se envió aviso al donante`;
  }
  return "Invalidación enviada al Ministerio de Hacienda";
}

export function isRetryableDocument(document: Pick<DteDocument, "status" | "transmission_deferred_at" | "fiscal_operation_claim_id">): boolean {
  if (document.fiscal_operation_claim_id) {
    return false;
  }
  // Espejo del worker: un CDE diferido (SIGNED + transmission_deferred_at) no se
  // reintenta manualmente — el cron de 15 minutos es el dueño del reintento. Un
  // SIGNED plano (sin marcador) sigue siendo reintetable.
  if (document.status === "SIGNED" && document.transmission_deferred_at) {
    return false;
  }
  return ["SIGNED", "FAILED", "CONTINGENCY_PENDING"].includes(document.status);
}

export function isCorrectionReconciliationDocument(
  document: Pick<DteDocument, "status" | "fiscal_operation_claim_id">
): boolean {
  const isCorrectionOwned =
    document.fiscal_operation_claim_id?.startsWith("fiscal_correction_") === true;
  return isCorrectionOwned && (
    document.status === "PENDING"
    || document.status === "SIGNED"
    || document.status === "CONTINGENCY_PENDING"
  );
}

function fiscalCorrectionTargetKey(target: FiscalCorrectionTarget): string {
  return `${target.kind}:${target.id}`;
}

function emptyFiscalCorrectionProtectedContext(): FiscalCorrectionProtectedContext {
  return {
    amountLabel: "—",
    environmentLabel: "—",
    issuerLabel: "—"
  };
}

function passwordPolicyMessage(password: string): string {
  const failures = passwordPolicyFailures(password);
  if (failures.length === 0) return "";
  return `La contraseña debe cumplir: ${failures.map((failure) => failure.label).join(", ")}`;
}

export async function api<T>(path: string, token: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = recordValue(data);
    throw new ApiError(
      response.status,
      userFacingErrorMessage(String(details.message ?? details.error ?? `HTTP ${response.status}`)),
      details
    );
  }
  return data as T;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function countByStatus(documents: DteDocument[]): Record<string, number> {
  // Cuenta por estado VISUAL: los diferidos (SIGNED + marcador) suman a "En trámite".
  return documents.reduce<Record<string, number>>((acc, document) => {
    const status = documentDisplayStatus(document);
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

export function shortCode(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

export function can(user: User | null, role: Role): boolean {
  const rank = { VIEWER: 1, OPERATOR: 2, ADMIN: 3, OWNER: 4 };
  return user ? rank[user.role] >= rank[role] : false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIEW_SUBTITLES: Record<View, string> = {
  documents: "Emita, envíe por correo y administre los comprobantes de donación (CDE).",
  failures: "CDE con errores, rechazos o pagos sin comprobante que requieren su atención.",
  contingency: "El CDE no usa contingencia; cuando Hacienda no responde, queda en trámite y se reintenta automáticamente.",
  audit: "Historial de todas las acciones realizadas en el panel.",
  analytics: "Tendencias de las donaciones en línea (carril Wompi).",
  users: "Cree cuentas y asigne roles de acceso al panel.",
  credentials: "Credenciales del Ministerio de Hacienda, Wompi y correo.",
  exports: "Exporte los CDE aceptados para el F960 y control interno."
};

export function viewSubtitle(view: View): string {
  return VIEW_SUBTITLES[view];
}

export function documentListEmptyMessage(
  view: "documents" | "failures",
  query: string,
  preCdeFailuresLoading = false
): string {
  if (view === "failures" && preCdeFailuresLoading) return "Revisando pagos sin CDE creado…";
  if (view === "failures" && query.trim() === "") return "Sin fallos pendientes. Todo en orden.";
  if (view === "failures") return "No hay CDE ni pagos sin comprobante que coincidan con la búsqueda.";
  return "No hay CDE que coincidan con la búsqueda o el filtro.";
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  return formatElSalvadorDateTime(value);
}

function currentMonthStartValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayDateValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function monthStart(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  }
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
}

export function addMonths(value: Date, offset: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + offset, 1));
}

export function calendarDays(month: Date): Array<Date | null> {
  const firstDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const totalDays = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const days: Array<Date | null> = Array.from({ length: firstDay.getUTCDay() }, () => null);
  for (let day = 1; day <= totalDays; day += 1) {
    days.push(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day)));
  }
  return days;
}

export function formatDateValue(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function monthLabel(value: Date): string {
  return new Intl.DateTimeFormat("es-SV", { month: "long", timeZone: "UTC", year: "numeric" }).format(value);
}

function exportParams(startDate: string, endDate: string): URLSearchParams {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  return params;
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

const advancedCdeSteps = [
  { id: "receptor", label: "Donante", description: "Datos fiscales y contacto del receptor." },
  { id: "direccion", label: "Dirección", description: "Ubicación declarada para el CDE." },
  { id: "donacion", label: "Donación", description: "Detalle del bien o aporte emitido." },
  { id: "pago", label: "Pago y anexos", description: "Referencia, documento asociado y apéndice." },
  { id: "revision", label: "Revisión", description: "Resumen final antes de generar el CDE." }
] as const;

interface AdvancedCdeFormInput {
  donorName: string;
  donorTipoDocumento: string;
  donorDocument: string;
  donorNrc: string;
  donorCodActividad: string;
  donorDescActividad: string;
  donorEmail: string;
  donorPhone: string;
  codDomiciliado: string;
  codPais: string;
  departamento: string;
  municipio: string;
  distrito: string;
  direccionComplemento: string;
  tipoDonacion: string;
  cantidad: string;
  codigo: string;
  uniMedida: string;
  descripcion: string;
  tipoDepreciacion: string;
  valorUni: string;
  valorTotal: string;
  totalLetras: string;
  pagoCodigo: string;
  pagoReferencia: string;
  documentoCodigo: string;
  documentoDesc: string;
  documentoDetalle: string;
  apendiceCampo: string;
  apendiceEtiqueta: string;
  apendiceValor: string;
}

function defaultAdvancedCdeForm(): AdvancedCdeFormInput {
  return {
    donorName: "",
    donorTipoDocumento: "13",
    donorDocument: "",
    donorNrc: "",
    donorCodActividad: "",
    donorDescActividad: "",
    donorEmail: "",
    donorPhone: "",
    codDomiciliado: "1",
    codPais: "SV",
    departamento: "06",
    municipio: "22",
    distrito: "01",
    direccionComplemento: "",
    tipoDonacion: "1",
    cantidad: "1",
    codigo: "DONACION",
    uniMedida: "59",
    descripcion: "",
    tipoDepreciacion: "0",
    valorUni: "1.00",
    valorTotal: "1.00",
    totalLetras: "",
    pagoCodigo: "01",
    pagoReferencia: "",
    documentoCodigo: "1",
    documentoDesc: "Referencia Wompi",
    documentoDetalle: "",
    apendiceCampo: "Aplicativo",
    apendiceEtiqueta: "Aplicativo",
    apendiceValor: ""
  };
}

function advancedFormFromDraft(draft: Record<string, unknown>): AdvancedCdeFormInput {
  const receptor = recordValue(draft.receptor);
  const direccion = recordValue(receptor.direccion);
  const item = firstRecord(draft.cuerpoDocumento);
  const resumen = recordValue(draft.resumen);
  const pago = firstRecord(resumen.pagos);
  const documento = firstRecord(draft.otrosDocumentos);
  const apendice = firstRecord(draft.apendice);
  const fallback = defaultAdvancedCdeForm();
  const countryCode = normalizeCat020CountryCode(textValue(receptor.codPais, fallback.codPais));
  const departmentCode = catalogSelectValue(CAT012_DEPARTMENTS, textValue(direccion.departamento, fallback.departamento)) || fallback.departamento;
  const municipalityOptions = getCat013Municipalities(departmentCode);
  const districtOptions = getCat008Districts(departmentCode);
  const activityCode = catalogSelectValue(CAT019_ACTIVITIES, textValue(receptor.codActividad));
  return {
    donorName: textValue(receptor.nombre, fallback.donorName),
    donorTipoDocumento: catalogSelectValue(CAT022_DOCUMENT_TYPES, textValue(receptor.tipoDocumento, fallback.donorTipoDocumento)) || fallback.donorTipoDocumento,
    donorDocument: textValue(receptor.numDocumento, fallback.donorDocument),
    donorNrc: textValue(receptor.nrc),
    donorCodActividad: activityCode,
    donorDescActividad: activityCode ? findCatalogOption(CAT019_ACTIVITIES, activityCode)?.label ?? textValue(receptor.descActividad) : "",
    donorEmail: textValue(receptor.correo),
    donorPhone: textValue(receptor.telefono),
    codDomiciliado: catalogSelectValue(CAT032_DOMICILE, textValue(receptor.codDomiciliado, fallback.codDomiciliado)) || fallback.codDomiciliado,
    codPais: isCat020CountryCode(countryCode) ? countryCode : fallback.codPais,
    departamento: departmentCode,
    municipio: catalogSelectValue(municipalityOptions, textValue(direccion.municipio, fallback.municipio)) || municipalityOptions[0]?.code || fallback.municipio,
    distrito: catalogSelectValue(districtOptions, textValue(direccion.distrito, fallback.distrito)) || districtOptions[0]?.code || fallback.distrito,
    direccionComplemento: textValue(direccion.complemento, fallback.direccionComplemento),
    tipoDonacion: catalogSelectValue(CAT026_DONATION_TYPES, textValue(item.tipoDonacion, fallback.tipoDonacion)) || fallback.tipoDonacion,
    cantidad: textValue(item.cantidad, fallback.cantidad),
    codigo: textValue(item.codigo, fallback.codigo),
    uniMedida: catalogSelectValue(CAT014_UNITS, textValue(item.uniMedida, fallback.uniMedida)) || fallback.uniMedida,
    descripcion: textValue(item.descripcion, fallback.descripcion),
    tipoDepreciacion: textValue(item.tipoDepreciacion, fallback.tipoDepreciacion),
    valorUni: formatCurrencyInputValue(textValue(item.valorUni, fallback.valorUni)) || fallback.valorUni,
    valorTotal: formatCurrencyInputValue(textValue(item.valor, textValue(resumen.valorTotal, fallback.valorTotal))) || fallback.valorTotal,
    totalLetras: textValue(resumen.totalLetras),
    pagoCodigo: catalogSelectValue(CAT017_PAYMENT_FORMS, textValue(pago.codigo, fallback.pagoCodigo)),
    pagoReferencia: textValue(pago.referencia, fallback.pagoReferencia),
    documentoCodigo: catalogSelectValue(CAT021_ASSOCIATED_DOCUMENTS, textValue(documento.codDocAsociado, fallback.documentoCodigo)) || fallback.documentoCodigo,
    documentoDesc: textValue(documento.descDocumento, fallback.documentoDesc),
    documentoDetalle: textValue(documento.detalleDocumento, fallback.documentoDetalle),
    apendiceCampo: textValue(apendice.campo, fallback.apendiceCampo),
    apendiceEtiqueta: textValue(apendice.etiqueta, fallback.apendiceEtiqueta),
    apendiceValor: textValue(apendice.valor, fallback.apendiceValor)
  };
}

function advancedDraftFromForm(template: Record<string, unknown> | null, form: AdvancedCdeFormInput): Record<string, unknown> {
  const draft = cloneRecord(template);
  const receptor = recordValue(draft.receptor);
  const item = firstRecord(draft.cuerpoDocumento);
  const resumen = recordValue(draft.resumen);
  const pago = firstRecord(resumen.pagos);
  const documento = firstRecord(draft.otrosDocumentos);
  const cantidad = decimalValue(form.cantidad, 1);
  const valorUni = decimalValue(form.valorUni, 1);
  const valorTotal = decimalValue(form.valorTotal, Number((cantidad * valorUni).toFixed(2)));

  draft.receptor = {
    ...receptor,
    tipoDocumento: cleanText(form.donorTipoDocumento) || "13",
    numDocumento: cleanText(form.donorDocument),
    nrc: nullableText(form.donorNrc),
    nombre: cleanText(form.donorName),
    codActividad: nullableText(form.donorCodActividad),
    descActividad: nullableText(form.donorDescActividad),
    direccion: {
      departamento: cleanText(form.departamento),
      municipio: cleanText(form.municipio),
      distrito: cleanText(form.distrito),
      complemento: cleanText(form.direccionComplemento)
    },
    telefono: nullableText(form.donorPhone),
    correo: nullableText(form.donorEmail),
    codDomiciliado: integerValue(form.codDomiciliado, 1),
    codPais: cleanText(form.codPais).toUpperCase() || "SV"
  };

  draft.cuerpoDocumento = [
    {
      ...item,
      numItem: 1,
      tipoDonacion: integerValue(form.tipoDonacion, 1),
      cantidad,
      codigo: cleanText(form.codigo) || "DONACION",
      uniMedida: integerValue(form.uniMedida, 59),
      descripcion: cleanText(form.descripcion),
      tipoDepreciacion: integerValue(form.tipoDepreciacion, 0),
      valorUni,
      valor: valorTotal
    }
  ];

  draft.resumen = {
    ...resumen,
    valorTotal,
    totalLetras: nullableText(form.totalLetras),
    pagos: [
      {
        ...pago,
        codigo: cleanText(form.pagoCodigo) || "01",
        montoPago: valorTotal,
        referencia: cleanText(form.pagoReferencia)
      }
    ]
  };

  draft.otrosDocumentos = [
    {
      ...documento,
      codDocAsociado: integerValue(form.documentoCodigo, 1),
      descDocumento: cleanText(form.documentoDesc) || "Referencia avanzada",
      detalleDocumento: cleanText(form.documentoDetalle) || cleanText(form.pagoReferencia) || "DTE avanzado"
    }
  ];

  const hasApendice = cleanText(form.apendiceCampo) || cleanText(form.apendiceEtiqueta) || cleanText(form.apendiceValor);
  draft.apendice = hasApendice
    ? [
        {
          campo: cleanText(form.apendiceCampo) || "Nota",
          etiqueta: cleanText(form.apendiceEtiqueta) || "Nota",
          valor: cleanText(form.apendiceValor) || "DTE avanzado"
        }
      ]
    : null;

  return draft;
}

export function validateAdvancedCdeForm(form: AdvancedCdeFormInput): string | null {
  const requiredFields: Array<[string, string]> = [
    [form.donorName, "Nombre del donante"],
    [form.donorDocument, "Número documento"],
    [form.departamento, "Departamento"],
    [form.municipio, "Municipio"],
    [form.distrito, "Distrito"],
    [form.direccionComplemento, "Dirección completa"],
    [form.descripcion, "Descripción"],
    [form.pagoReferencia, "Referencia pago"]
  ];
  const missing = requiredFields.find(([value]) => !cleanText(value));
  if (missing) return `${missing[1]} es requerido`;
  if (isDuiDocumentType(form.donorTipoDocumento)) {
    const duiError = duiValidationMessage(form.donorDocument);
    if (duiError) return duiError;
  }
  if (!isCat022DocumentTypeCode(form.donorTipoDocumento)) return "Tipo documento debe existir en CAT-022";
  if (cleanText(form.donorCodActividad) && !isCat019ActivityCode(form.donorCodActividad)) return "Actividad económica debe existir en CAT-019";
  if (!isCat032DomicileCode(form.codDomiciliado)) return "Domicilio fiscal debe existir en CAT-032";
  if (!isCat020CountryCode(form.codPais)) return "País debe existir en CAT-020";
  if (!isCat012DepartmentCode(form.departamento)) return "Departamento debe existir en CAT-012";
  if (!isCat013MunicipalityCode(form.municipio, form.departamento)) return "Municipio debe existir en CAT-013";
  if (!isCat008DistrictCode(form.distrito, form.departamento)) return "Distrito debe existir en CAT-008";
  if (!isCat026DonationTypeCode(form.tipoDonacion)) return "Tipo donación debe existir en CAT-026";
  if (!isCat014UnitCode(form.uniMedida)) return "Unidad medida debe existir en CAT-014";
  if (!isCat017PaymentFormCode(form.pagoCodigo)) return "Código pago debe existir en CAT-017";
  if (!isCat021AssociatedDocumentCode(form.documentoCodigo)) return "Documento asociado debe existir en CAT-021";
  if (decimalValue(form.cantidad, 0) <= 0) return "Cantidad debe ser mayor que cero";
  if (decimalValue(form.valorUni, 0) <= 0) return "Valor unitario debe ser mayor que cero";
  if (decimalValue(form.valorTotal, 0) <= 0) return "Valor total debe ser mayor que cero";
  return null;
}

function duiValidationMessage(value: string): string {
  const raw = cleanText(value);
  if (!raw) return "";
  if (cleanDui(raw).length !== 9) return "DUI debe tener 9 dígitos";
  if (!isValidDui(raw)) return "DUI con dígito verificador inválido";
  return "";
}

function defaultIssuerConfigForm(): IssuerConfigFormInput {
  return {
    tipoDocumento: "36",
    numDocumento: "",
    nrc: "",
    nombre: "",
    codActividad: "94910",
    descActividad: findCatalogOption(CAT019_ACTIVITIES, "94910")?.label ?? "",
    nombreComercial: "",
    departamento: "06",
    municipio: "22",
    distrito: "01",
    direccionComplemento: "",
    telefono: "",
    correo: "",
    codEstable: "",
    codEstableMH: "M001",
    codPuntoVenta: "",
    codPuntoVentaMH: "P004",
    controlPrefix: "M001P004",
    defaultReceptorTipoDocumento: "13",
    defaultCodPais: "SV",
    defaultDonationType: "1",
    defaultUnidadMedida: "59",
    paymentMethodCode: "01",
    responsableNombre: "",
    responsableTipoDocumento: "36",
    responsableNumeroDocumento: "",
    responsableTipoEstablecimiento: ""
  };
}

export function issuerFormFromConfigJson(value: string): IssuerConfigFormInput {
  const fallback = defaultIssuerConfigForm();
  if (!value.trim()) return fallback;
  try {
    const parsed = recordValue(JSON.parse(value));
    const direccion = recordValue(parsed.direccion);
    const responsable = recordValue(parsed.responsable);
    const departmentCode = catalogSelectValue(CAT012_DEPARTMENTS, textValue(direccion.departamento, fallback.departamento)) || fallback.departamento;
    const municipalityOptions = getCat013Municipalities(departmentCode);
    const districtOptions = getCat008Districts(departmentCode);
    const activityCode = catalogSelectValue(CAT019_ACTIVITIES, textValue(parsed.codActividad, fallback.codActividad)) || fallback.codActividad;
    const countryCode = normalizeCat020CountryCode(textValue(parsed.defaultCodPais, fallback.defaultCodPais));
    return {
      tipoDocumento: catalogSelectValue(CAT022_ISSUER_DOCUMENT_TYPES, textValue(parsed.tipoDocumento, fallback.tipoDocumento)) || fallback.tipoDocumento,
      numDocumento: textValue(parsed.numDocumento, fallback.numDocumento),
      nrc: textValue(parsed.nrc),
      nombre: textValue(parsed.nombre, fallback.nombre),
      codActividad: activityCode,
      descActividad: textValue(parsed.descActividad, findCatalogOption(CAT019_ACTIVITIES, activityCode)?.label ?? fallback.descActividad),
      nombreComercial: textValue(parsed.nombreComercial),
      departamento: departmentCode,
      municipio: catalogSelectValue(municipalityOptions, textValue(direccion.municipio, fallback.municipio)) || municipalityOptions[0]?.code || fallback.municipio,
      distrito: catalogSelectValue(districtOptions, textValue(direccion.distrito, fallback.distrito)) || districtOptions[0]?.code || fallback.distrito,
      direccionComplemento: textValue(direccion.complemento, fallback.direccionComplemento),
      telefono: textValue(parsed.telefono, fallback.telefono),
      correo: textValue(parsed.correo, fallback.correo),
      codEstable: textValue(parsed.codEstable),
      codEstableMH: textValue(parsed.codEstableMH, fallback.codEstableMH),
      codPuntoVenta: textValue(parsed.codPuntoVenta),
      codPuntoVentaMH: textValue(parsed.codPuntoVentaMH, fallback.codPuntoVentaMH),
      controlPrefix: textValue(parsed.controlPrefix, fallback.controlPrefix),
      defaultReceptorTipoDocumento: catalogSelectValue(CAT022_DOCUMENT_TYPES, textValue(parsed.defaultReceptorTipoDocumento, fallback.defaultReceptorTipoDocumento)) || fallback.defaultReceptorTipoDocumento,
      defaultCodPais: isCat020CountryCode(countryCode) ? countryCode : fallback.defaultCodPais,
      defaultDonationType: catalogSelectValue(CAT026_DONATION_TYPES, textValue(parsed.defaultDonationType, fallback.defaultDonationType)) || fallback.defaultDonationType,
      defaultUnidadMedida: catalogSelectValue(CAT014_UNITS, textValue(parsed.defaultUnidadMedida, fallback.defaultUnidadMedida)) || fallback.defaultUnidadMedida,
      paymentMethodCode: catalogSelectValue(CAT017_PAYMENT_FORMS, textValue(parsed.paymentMethodCode, fallback.paymentMethodCode)) || fallback.paymentMethodCode,
      responsableNombre: textValue(responsable.nombre, fallback.responsableNombre),
      responsableTipoDocumento: catalogSelectValue(CAT022_DOCUMENT_TYPES, textValue(responsable.tipoDocumento, fallback.responsableTipoDocumento)) || fallback.responsableTipoDocumento,
      responsableNumeroDocumento: textValue(responsable.numeroDocumento, fallback.responsableNumeroDocumento),
      responsableTipoEstablecimiento: textValue(responsable.tipoEstablecimiento, fallback.responsableTipoEstablecimiento)
    };
  } catch {
    return fallback;
  }
}

export function issuerConfigJsonFromForm(form: IssuerConfigFormInput): string {
  return JSON.stringify(
    {
      tipoDocumento: cleanText(form.tipoDocumento),
      numDocumento: cleanText(form.numDocumento),
      nrc: nullableText(form.nrc),
      nombre: cleanText(form.nombre),
      codActividad: cleanText(form.codActividad),
      descActividad: cleanText(form.descActividad) || findCatalogOption(CAT019_ACTIVITIES, form.codActividad)?.label || "",
      nombreComercial: nullableText(form.nombreComercial),
      direccion: {
        departamento: cleanText(form.departamento),
        municipio: cleanText(form.municipio),
        distrito: cleanText(form.distrito),
        complemento: cleanText(form.direccionComplemento)
      },
      telefono: cleanText(form.telefono),
      correo: cleanText(form.correo),
      codEstable: nullableText(form.codEstable),
      codEstableMH: cleanText(form.codEstableMH),
      codPuntoVenta: nullableText(form.codPuntoVenta),
      codPuntoVentaMH: cleanText(form.codPuntoVentaMH),
      controlPrefix: cleanText(form.controlPrefix),
      defaultReceptorTipoDocumento: cleanText(form.defaultReceptorTipoDocumento),
      defaultCodPais: cleanText(form.defaultCodPais),
      defaultDonationType: integerValue(form.defaultDonationType, 1),
      defaultUnidadMedida: integerValue(form.defaultUnidadMedida, 59),
      paymentMethodCode: nullableText(form.paymentMethodCode),
      responsable: {
        nombre: cleanText(form.responsableNombre),
        tipoDocumento: cleanText(form.responsableTipoDocumento),
        numeroDocumento: cleanText(form.responsableNumeroDocumento),
        tipoEstablecimiento: cleanText(form.responsableTipoEstablecimiento)
      }
    },
    null,
    2
  );
}

function cloneRecord(value: Record<string, unknown> | null): Record<string, unknown> {
  return value ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>) : {};
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? recordValue(value[0]) : {};
}

function textValue(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function cleanText(value: string): string {
  return value.trim();
}

function nullableText(value: string): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned : null;
}

function integerValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimalValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(normalizeDecimalText(value));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : fallback;
}

function normalizeDecimalText(value: string): string {
  return value.replace(/[$,\s]/g, "");
}

function formatCurrencyInputValue(value: string): string {
  const parsed = Number.parseFloat(normalizeDecimalText(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : "";
}

function emptyTestDteInput(): TestDteInput {
  return {
    amount: "",
    donorName: "",
    donorEmail: "",
    donorDocumentType: "13",
    donorDocument: "",
    donorPhone: ""
  };
}

function testAmountValidationMessage(value: string): string {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? "" : "Ingrese un monto mayor que cero";
}

export function quickDteValidationMessage(input: TestDteInput, options: { requireAmount?: boolean } = {}): string {
  if (options.requireAmount !== false) {
    const amountError = testAmountValidationMessage(input.amount);
    if (amountError) return amountError;
  }
  if (!input.donorName.trim()) return "Ingrese el nombre o razón social del donante";
  if (!input.donorDocument.trim()) return "Ingrese el documento del donante";
  const donorDuiError = isDuiDocumentType(input.donorDocumentType) ? duiValidationMessage(input.donorDocument) : "";
  if (donorDuiError) return donorDuiError;
  const donorEmail = input.donorEmail.trim();
  if (donorEmail && !isValidEmail(donorEmail)) return "Ingrese un correo válido";
  return "";
}

interface TestDteInput {
  amount: string;
  donorName: string;
  donorEmail: string;
  donorDocumentType: string;
  donorDocument: string;
  donorPhone: string;
}

interface CreateUserInput {
  name: string;
  email: string;
  role: Role;
  password: string;
}

interface UserSettingsInput {
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
  password: string;
}

function emptyUserSettings(): UserSettingsInput {
  return {
    name: "",
    email: "",
    role: "VIEWER",
    disabled: false,
    password: ""
  };
}

function userSettingsFromUser(user: User): UserSettingsInput {
  return {
    name: user.name,
    email: user.email,
    role: user.role,
    disabled: Boolean(user.disabled_at),
    password: ""
  };
}

export interface IssuerConfigFormInput {
  tipoDocumento: string;
  numDocumento: string;
  nrc: string;
  nombre: string;
  codActividad: string;
  descActividad: string;
  nombreComercial: string;
  departamento: string;
  municipio: string;
  distrito: string;
  direccionComplemento: string;
  telefono: string;
  correo: string;
  codEstable: string;
  codEstableMH: string;
  codPuntoVenta: string;
  codPuntoVentaMH: string;
  controlPrefix: string;
  defaultReceptorTipoDocumento: string;
  defaultCodPais: string;
  defaultDonationType: string;
  defaultUnidadMedida: string;
  paymentMethodCode: string;
  responsableNombre: string;
  responsableTipoDocumento: string;
  responsableNumeroDocumento: string;
  responsableTipoEstablecimiento: string;
}

export interface CredentialFormInput {
  environment: "test" | "production";
  mhUser: string;
  mhPassword: string;
  certificateXml: string;
  certificateFileName: string;
  certificatePassword: string;
  emisorConfigJson: string;
  wompiSecret: string;
  emailApiKey: string;
  emailFrom: string;
}

export interface F960Preview {
  rows: F960PreviewRow[];
  rowCount: number;
  amountTotal: string;
}

export interface AnnualCertificatePreviewDonor {
  groupKey: string;
  donorName: string;
  donorEmail: string | null;
  hasEmail: boolean;
  count: number;
  totalLabel: string;
  hasTestEnvironment: boolean;
}

export interface AnnualCertificatePreview {
  year: number;
  donorCount: number;
  withEmail: number;
  withoutEmail: number;
  totalLabel: string;
  donors: AnnualCertificatePreviewDonor[];
  matchCount: number;
  truncated: boolean;
}

interface AnnualCertificateSendResult {
  year: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface F960PreviewRow {
  nit: string;
  nombre: string;
  codigoActividad: string;
  tipoDonacion: string;
  sello: string;
  codigoGeneracion: string;
  monto: string;
  dui: string;
  periodo: string;
  fechaEmision: string;
  numeroControl: string;
  correo: string;
}

function emptyCredentialInput(environment: CredentialFormInput["environment"]): CredentialFormInput {
  return {
    environment,
    mhUser: "",
    mhPassword: "",
    certificateXml: "",
    certificateFileName: "",
    certificatePassword: "",
    emisorConfigJson: "",
    wompiSecret: "",
    emailApiKey: "",
    emailFrom: ""
  };
}
