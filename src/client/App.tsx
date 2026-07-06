import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Clock,
  CircleHelp,
  Copy,
  Download,
  EyeOff,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Braces,
  History,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Settings,
  Upload,
  UserPlus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
  Users
} from "lucide-react";
import { Fragment, type FormEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { AlertEmailState, AuditRow, BackupMonth, BackupsGrid, BackupVerifyResult, ContingencyState, CredentialStatus, CredentialStatusItem, DocumentListPage, DonationIntentListItem, DteDocument, EmailTemplateSettings, EmailTemplateValue, EmissionEnvironmentState, User } from "./types";
import { shouldShowBootstrapMode, type AuthBootstrapStatus } from "./authBootstrap";
import { filterAuditEntries } from "./auditFilter";
import { defaultInvalidationForm, invalidationFormValidationMessage, invalidationRequestBody, type InvalidationFormInput } from "./invalidationForm";
import { passwordResetConfirmValidationMessage, resetTokenFromSearch } from "./passwordReset";
import { isDonarGraciasPath, isDonarPath } from "./donation";
import { DonarGraciasPage, DonarPage } from "./donarPage";
import { openNativeDatePicker } from "./datePicker";
import { certificateExpiryStatus, credentialSectionState, credentialSettingsSections, type CredentialSettingsSectionId } from "./credentialSettings";
import { auditActionLabel, auditActorLabel, auditLocationLabel, auditProtocolLabel, AUDIT_CONTEXT_LABELS, auditSummaryLabel, catalogOptionLabel, donationIntentStatusLabel, entityLabel, environmentLabel, parseAuditContext, roleLabel, statusLabel, userFacingErrorMessage } from "./displayText";
import { invalidationWindowInfo } from "./invalidationWindow";
import { PASSWORD_POLICY_REQUIREMENTS, passwordPolicyFailures, passwordPolicySatisfied } from "../shared/passwordPolicy";
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
import { formatElSalvadorDate, formatElSalvadorDateTime } from "../shared/legalWindows";

type Role = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";
type View = "documents" | "failures" | "contingency" | "audit" | "users" | "exports" | "credentials";

const DOCUMENT_PAGE_SIZE = 50;
const DOCUMENT_SEARCH_DEBOUNCE_MS = 300;
const TOAST_DISMISS_MS = 6000;

const navItems: Array<{ id: View; label: string; icon: typeof FileText; minRole?: Role }> = [
  { id: "documents", label: "Documentos", icon: FileText },
  { id: "failures", label: "Fallos", icon: AlertTriangle },
  { id: "contingency", label: "Contingencia", icon: Clock },
  { id: "audit", label: "Auditoría", icon: History },
  { id: "users", label: "Usuarios", icon: Users },
  { id: "exports", label: "Exportar", icon: FileSpreadsheet, minRole: "ADMIN" },
  { id: "credentials", label: "Configuración", icon: Settings, minRole: "OWNER" }
];

const credentialSettingsSectionIcons: Record<CredentialSettingsSectionId, typeof FileText> = {
  ambiente: Settings,
  mh: KeyRound,
  firmador: ShieldCheck,
  wompi: Cloud,
  emisor: FileText,
  correo: Mail,
  plantillas: Braces
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, disabled: boolean) {
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

export function App() {
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
  const [view, setView] = useState<View>("documents");
  const [documents, setDocuments] = useState<DteDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
  const [emissionEnvironment, setEmissionEnvironment] = useState<EmissionEnvironmentState | null>(null);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateSettings | null>(null);
  const [emailTemplateDraft, setEmailTemplateDraft] = useState<Record<string, EmailTemplateValue>>({});
  const [alertEmailDraft, setAlertEmailDraft] = useState("");
  const [contingency, setContingency] = useState<ContingencyState | null>(null);
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
  const [certificatePreview, setCertificatePreview] = useState<AnnualCertificatePreview | null>(null);
  const [donationIntents, setDonationIntents] = useState<DonationIntentListItem[]>([]);
  const [backups, setBackups] = useState<BackupMonth[]>([]);
  const [backupVerifyByMonth, setBackupVerifyByMonth] = useState<Record<string, BackupVerifyResult>>({});
  const [donorVerifiedDocId, setDonorVerifiedDocId] = useState<string | null>(null);
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

  const selected = useMemo(() => documents.find((document) => document.id === selectedId) ?? documents[0], [documents, selectedId]);
  const selectedUser = useMemo(() => users.find((candidate) => candidate.id === selectedUserId) ?? null, [users, selectedUserId]);
  const pendingInvalidation = useMemo(() => documents.find((document) => document.id === pendingInvalidationId) ?? null, [documents, pendingInvalidationId]);
  const filteredStatus = view === "failures" ? "FAILED" : status;
  const visibleNavItems = navItems.filter((item) => !item.minRole || can(user, item.minRole));

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
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
    document.querySelector(".sidebar nav button.active")?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [view]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void refresh().catch(handleApiFailure);
  }, [token, filteredStatus, debouncedQuery, view, exportStartDate, exportEndDate, certificateYear]);

  // The document list does not carry the donor-data-verified flag (it is a per-CDE
  // indexed lookup on the server), so fetch the selected document's detail to learn it.
  useEffect(() => {
    const documentId = selected?.id;
    if (!token || !documentId) {
      setDonorVerifiedDocId(null);
      return;
    }
    let cancelled = false;
    void api<{ donorDataVerified?: boolean }>(`/api/documents/${documentId}`, token)
      .then((detail) => {
        if (!cancelled) {
          setDonorVerifiedDocId(detail.donorDataVerified ? documentId : null);
        }
      })
      .catch(() => {
        if (!cancelled) setDonorVerifiedDocId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, selected?.id]);

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

  async function fetchDocumentPage(options: { append?: boolean; cursor?: string | null; query?: string; status?: string } = {}) {
    const params = new URLSearchParams();
    const effectiveStatus = options.status ?? filteredStatus;
    const effectiveQuery = options.query ?? debouncedQuery;
    if (effectiveStatus) params.set("status", effectiveStatus);
    if (effectiveQuery) params.set("q", effectiveQuery);
    if (options.cursor) params.set("cursor", options.cursor);
    params.set("limit", String(DOCUMENT_PAGE_SIZE));
    const page = await api<DocumentListPage>(`/api/documents?${params}`, token);
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

  async function refresh() {
    await fetchDocumentPage();
    const contingencyResult = await api<{ contingency: ContingencyState }>("/api/contingency", token);
    setContingency(contingencyResult.contingency);
    if (view === "audit") {
      setAudit((await api<{ audit: AuditRow[] }>("/api/audit", token)).audit);
    }
    if (view === "users" && can(user, "ADMIN")) {
      setUsers((await api<{ users: User[] }>("/api/users", token)).users);
    }
    if (view === "credentials" && can(user, "OWNER")) {
      const [credentialResult, environmentResult, emailTemplateResult, alertEmailResult] = await Promise.all([
        api<{ credentials: CredentialStatus }>("/api/credentials", token),
        api<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment", token),
        api<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates", token),
        api<AlertEmailState>("/api/settings/alert-email", token)
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
      setExportPreview(await api<F960Preview>(`/api/exports/f960?${params}`, token));
      setCertificatePreview(await api<AnnualCertificatePreview>(`/api/certificates/annual?year=${certificateYear}`, token));
      setDonationIntents((await api<{ intents: DonationIntentListItem[] }>("/api/donations/intents", token)).intents);
      setBackups((await api<BackupsGrid>("/api/admin/backups", token)).months);
    }
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

  function logout() {
    localStorage.removeItem("diezmos_token");
    localStorage.removeItem("diezmos_user");
    setToken("");
    setUser(null);
    setAuthNotice("");
    setDocuments([]);
    setSelectedId(null);
    setSelectedUserId(null);
    setUserSettings(emptyUserSettings());
    setPendingInvalidationId(null);
    setEmailEditingId(null);
    setEmailDraft("");
  }

  async function createTestDte() {
    const validationError = quickDteValidationMessage(testInput);
    if (validationError) {
      setToast(validationError);
      return;
    }
    await runAction("test-dte", async () => {
      await api("/api/test/dte", token, { method: "POST", body: testInput });
      setTestInput(emptyTestDteInput());
      setToast("CDE creado. Transmitiendo al Ministerio de Hacienda…");
      await delay(2500);
      await refresh();
    });
  }

  async function openAdvancedDte() {
    await runAction("advanced-template", async () => {
      const result = await api<{ draft: Record<string, unknown> }>("/api/test/dte/advanced-template", token, { method: "POST", body: testInput });
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
      await api("/api/test/dte/advanced", token, { method: "POST", body: { draft } });
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
    const body = action === "invalidate" ? invalidationRequestBody(invalidationForm) : {};
    await runAction(action, async () => {
      const result = await api<{ accepted?: boolean; result?: { estado?: string }; emailSent?: boolean; emailError?: string }>(`/api/documents/${target.id}/${action}`, token, { method: "POST", body });
      setToast(action === "resend" ? "Correo reenviado" : action === "retry" ? "Reintento ejecutado" : invalidationToast(result));
      if (action === "invalidate") setPendingInvalidationId(null);
      await refresh();
    });
  }

  async function saveDocumentEmail(target = selected) {
    if (!target) return;
    const email = emailDraft.trim();
    if (!isValidEmail(email)) {
      setToast("Ingrese un correo válido");
      return;
    }
    await runAction("email", async () => {
      await api(`/api/documents/${target.id}/email`, token, { method: "PATCH", body: { email } });
      setToast("Correo de envío actualizado");
      setEmailEditingId(null);
      setEmailDraft("");
      await refresh();
    });
  }

  async function downloadDocument(format: "pdf" | "json") {
    if (!selected) return;
    await runAction(`download-${format}`, async () => {
      const response = await fetch(`/api/documents/${selected.id}/${format}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
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
      const response = await fetch(`/api/exports/f960.${format}?${exportParams(exportStartDate, exportEndDate)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filenameFromDisposition(response.headers.get("Content-Disposition"), `f960.${format}`);
      link.click();
      URL.revokeObjectURL(href);
      setToast(format === "csv" ? "CSV F960 descargado" : "XLSX de inspección descargado");
    });
  }

  async function verifyBackup(month: string) {
    await runAction(`backup-verify-${month}`, async () => {
      const result = await api<BackupVerifyResult>(`/api/admin/backups/${month}/verify`, token, { method: "POST" });
      setBackupVerifyByMonth((current) => ({ ...current, [month]: result }));
      setToast(result.ok ? `Respaldo de ${month} verificado: íntegro.` : `Respaldo de ${month}: se detectaron discrepancias.`);
    });
  }

  async function downloadBackup(month: string, table: string) {
    await runAction(`backup-download-${month}-${table}`, async () => {
      const response = await fetch(`/api/admin/backups/${month}/download?table=${encodeURIComponent(table)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        table === "manifest" ? `retention-${month}-manifest.json` : `retention-${month}-${table}.ndjson`
      );
      link.click();
      URL.revokeObjectURL(href);
    });
  }

  async function exportBackupMonth(month: string) {
    const confirmed = window.confirm(`¿Desea generar el respaldo del mes ${month}? Se exportarán todas las tablas legales a R2.`);
    if (!confirmed) {
      return;
    }
    await runAction(`backup-export-${month}`, async () => {
      await api(`/api/admin/retention-export?month=${month}`, token, { method: "POST" });
      setBackups((await api<BackupsGrid>("/api/admin/backups", token)).months);
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
      const result = await api<AnnualCertificateSendResult>(`/api/certificates/annual/send?year=${preview.year}`, token, { method: "POST" });
      setToast(`Constancias ${result.year}: ${result.sent} enviadas, ${result.skipped} omitidas, ${result.failed} fallidas`);
      setCertificatePreview(await api<AnnualCertificatePreview>(`/api/certificates/annual?year=${certificateYear}`, token));
    });
  }

  async function createUser() {
    const passwordError = passwordPolicyMessage(newUser.password);
    if (passwordError) {
      setToast(passwordError);
      return;
    }
    await runAction("create-user", async () => {
      const created = await api<{ user: User }>("/api/users", token, { method: "POST", body: newUser });
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
      const result = await api<{ user: User }>(`/api/users/${selectedUserId}`, token, {
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
      await api(`/api/users/${selectedUserId}/password`, token, { method: "POST", body: { password: userSettings.password } });
      setUserSettings((current) => ({ ...current, password: "" }));
      setToast("Contraseña restablecida");
    });
  }

  async function updateCredentials() {
    await runAction("credentials", async () => {
      const result = await api<{ updated: string[]; deleted: string[] }>("/api/credentials", token, { method: "POST", body: credentialInput });
      setToast(`Secretos actualizados: ${result.updated.length}`);
      setCredentialInput(emptyCredentialInput(credentialInput.environment));
      setCredentials((await api<{ credentials: CredentialStatus }>("/api/credentials", token)).credentials);
    });
  }

  async function updateEmissionEnvironment(environment: EmissionEnvironmentState["environment"]) {
    if (emissionEnvironment?.environment === environment && emissionEnvironment.source === "setting") {
      return;
    }
    await runAction("emission-environment", async () => {
      const result = await api<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment", token, {
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
      const result = await api<AlertEmailState>("/api/settings/alert-email", token, {
        method: "PUT",
        body: { alertEmail: alertEmailDraft.trim() }
      });
      applyAlertEmail(result.alertEmail);
      setToast(result.alertEmail ? "Correo de alertas actualizado" : "Alertas operativas desactivadas");
    });
  }

  async function updateEmailTemplates() {
    await runAction("email-templates", async () => {
      const result = await api<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates", token, {
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
      const result = await api<{ updated: string[]; credentials: CredentialStatus }>("/api/credentials/writer-token", token, {
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
      setBusy("");
    }
  }

  async function refreshContingency() {
    await runAction("contingency-refresh", refresh);
  }

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    try {
      await action();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setBusy("");
    }
  }

  if (!token || !user) {
    return (
      <AuthScreen
        notice={authNotice}
        onLogin={login}
        onBootstrap={bootstrap}
        onRequestReset={requestPasswordReset}
        onConfirmReset={confirmPasswordReset}
        bootstrapAvailable={shouldShowBootstrapMode(authBootstrapStatus)}
      />
    );
  }

  function handleApiFailure(error: unknown) {
    if (isApiError(error) && error.status === 401) {
      expireSession();
      return;
    }
    setToast(userFacingErrorMessage(error instanceof Error ? error.message : String(error)));
  }

  function expireSession() {
    localStorage.removeItem("diezmos_token");
    localStorage.removeItem("diezmos_user");
    setToken("");
    setUser(null);
    setDocuments([]);
    setSelectedId(null);
    setAudit([]);
    setUsers([]);
    setCredentials(null);
    setAuthNotice("Su sesión expiró. Inicie sesión de nuevo.");
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem("diezmos_sidebar_collapsed", next ? "true" : "false");
      return next;
    });
  }

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="sidebar-head">
          <div className="brand">
            <ShieldCheck size={24} />
            <div className="brand-text">
              <strong>ExamplePerson1</strong>
              <span>Comprobantes de donación</span>
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
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)} aria-label={item.label} title={item.label}>
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
                    <option value="CONTINGENCY_PENDING">Contingencia</option>
                    <option value="REJECTED">Rechazados</option>
                    <option value="FAILED">Fallidos</option>
                    <option value="INVALIDATED">Invalidados</option>
                  </select>
                )}
                <button className="icon-button" onClick={() => void refresh()} title="Actualizar">
                  <RefreshCw size={17} />
                </button>
              </div>
              <Stats documents={documents} onlyFailed={view === "failures"} />
              <DocumentTable documents={documents} selectedId={selected?.id} onSelect={setSelectedId} />
              <DocumentListFooter
                count={documents.length}
                hasMore={documentsHasMore}
                loading={documentsLoadingMore}
                onLoadMore={loadMoreDocuments}
                emptyMessage={documentListEmptyMessage(view === "failures" ? "failures" : "documents", query)}
              />
            </div>
              <DetailPanel
                selected={selected}
                donorDataVerified={selected?.id === donorVerifiedDocId}
                busy={busy}
                now={now}
                onAction={documentAction}
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
          <ContingencyPanel
            state={contingency}
            busy={busy}
            onRefresh={refreshContingency}
          />
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
          </section>
        )}

        {view === "users" && (
          <section className="single-panel">
            {can(user, "ADMIN") ? (
              <>
                <UserCreateForm input={newUser} busy={busy === "create-user"} onChange={setNewUser} onSubmit={createUser} />
                <UserTable users={users} selectedId={selectedUserId} onSelect={openUserSettings} />
                {selectedUser && (
                  <UserSettingsModal
                    user={selectedUser}
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
              busy={busy === "certificates-send"}
              onYearChange={setCertificateYear}
              onSend={sendAnnualCertificates}
            />
            <BackupsPanel
              months={backups}
              verifyByMonth={backupVerifyByMonth}
              busy={busy}
              onVerify={verifyBackup}
              onDownload={downloadBackup}
              onExport={exportBackupMonth}
            />
            <OnlineDonationsPanel intents={donationIntents} />
          </>
        )}

        {view === "credentials" && (
          <CredentialsPanel
            status={credentials}
            emissionEnvironment={emissionEnvironment}
            emailTemplates={emailTemplates}
            emailTemplateDraft={emailTemplateDraft}
            alertEmailDraft={alertEmailDraft}
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
            onBootstrapWriter={bootstrapCredentialWriter}
            onRefresh={async () => {
              const [credentialResult, environmentResult, emailTemplateResult, alertEmailResult] = await Promise.all([
                api<{ credentials: CredentialStatus }>("/api/credentials", token),
                api<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment", token),
                api<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates", token),
                api<AlertEmailState>("/api/settings/alert-email", token)
              ]);
              setCredentials(credentialResult.credentials);
              setEmissionEnvironment(environmentResult.emissionEnvironment);
              applyEmailTemplates(emailTemplateResult.emailTemplates);
              applyAlertEmail(alertEmailResult.alertEmail);
            }}
          />
        )}
      </main>
      {advancedDteOpen && (
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

function ContingencyPanel({
  state,
  busy,
  onRefresh
}: {
  state: ContingencyState | null;
  busy: string;
  onRefresh: () => Promise<void>;
}) {
  const pendingDocuments = state?.pendingDocuments ?? [];
  const batches = state?.batches ?? [];
  const batchLines = state?.batchLines ?? [];
  const periods = state?.periods ?? [];
  const events = state?.events ?? [];
  const audit = state?.audit ?? [];
  const summary = state?.summary ?? {
    pending: 0,
    open: 0,
    eventAccepted: 0,
    closed: 0,
    failed: 0,
    eventsAccepted: 0,
    eventsRejected: 0,
    batches: 0,
    batchAccepted: 0,
    batchPending: 0,
    batchRejected: 0
  };

  return (
    <section className="contingency-dashboard">
      <div className="contingency-panel">
        <div className="panel-head">
          <div>
            <h2>Historial de contingencias (solo lectura)</h2>
            <p>
              La normativa no contempla contingencia para el CDE: la tabla de validaciones del
              evento de contingencia (campo 35) excluye el tipo 15. Cuando el Ministerio de
              Hacienda no está disponible, el CDE se emite con forma normal, queda
              «En trámite», el donante recibe de inmediato su comprobante transitorio y el
              sistema reintenta la transmisión cada 15 minutos hasta obtener el Sello de
              Recepción. Esta sección conserva los periodos históricos.
            </p>
          </div>
          <button className="icon-button" onClick={() => void onRefresh()} disabled={busy === "contingency-refresh"} title="Actualizar">
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      <div className="stats contingency-stats">
        <Metric label="Pendientes" value={summary.pending} tone="warn" />
        <Metric label="Lotes del Ministerio de Hacienda" value={summary.batches} tone="neutral" />
        <Metric label="CDE aceptados" value={summary.batchAccepted} tone="ok" />
        <Metric label="CDE en lote" value={summary.batchPending} tone="warn" />
        <Metric label="CDE rechazados" value={summary.batchRejected} tone="bad" />
      </div>

      <section className="contingency-panel">
        <div className="panel-head">
          <div>
            <h2>CDE pendientes (histórico)</h2>
            <p>Comprobantes que quedaron en estado de contingencia bajo el modelo anterior; requieren reemisión manual si aún no tienen sello.</p>
          </div>
          <FileText size={20} />
        </div>
        {pendingDocuments.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Estado</th>
                  <th>Código</th>
                  <th>Donante</th>
                  <th className="numeric">Monto</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {pendingDocuments.map((document) => (
                  <tr key={document.id}>
                    <td><StatusPill status={document.status} /></td>
                    <td className="mono">{shortCode(document.codigo_generacion)}</td>
                    <td><StackedCell primary={document.donor_name ?? "—"} secondary={document.donor_email ?? ""} /></td>
                    <td className="numeric">{formatMoneyCents(document.amount_cents)}</td>
                    <td className="numeric">{formatDateTime(document.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<CheckCircle2 size={18} />} text="No hay CDE pendientes de contingencia." />
        )}
      </section>

      <section className="contingency-panel">
        <div className="panel-head">
          <div>
              <h2>Lotes del Ministerio de Hacienda (histórico)</h2>
            <p>Lotes de CDE enviados bajo el modelo anterior de contingencia y el resultado de cada consulta.</p>
          </div>
          <FileText size={20} />
        </div>
        {batches.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Estado</th>
                  <th>Código lote</th>
                  <th>ID envío</th>
                  <th>CDE</th>
                  <th>Consulta</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td><StatusPill status={batch.status} /></td>
                    <td className="mono">{batch.codigo_lote ? shortCode(batch.codigo_lote) : "Pendiente"}</td>
                    <td className="mono">{shortCode(batch.id_envio)}</td>
                    <td>
                      <StackedCell
                        primary={`${batch.accepted_count}/${batch.line_count} aceptados`}
                        secondary={`${batch.pending_count} pendientes, ${batch.rejected_count} rechazados`}
                      />
                    </td>
                    <td className="numeric">{formatDateTime(batch.last_polled_at ?? batch.submitted_at ?? batch.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Clock size={18} />} text="Sin lotes enviados para el periodo activo." />
        )}
        {batchLines.length > 0 && (
          <div className="batch-line-list">
            {batchLines.slice(0, 12).map((line) => (
              <div key={line.id} className="batch-line-row">
                <StatusPill status={line.status} />
                <span className="mono">{shortCode(line.codigo_generacion)}</span>
                <span className="mono">{line.sello_recibido ? shortCode(line.sello_recibido) : "Sin sello DTE"}</span>
                    <span>{line.last_error ? userFacingErrorMessage(line.last_error) : line.mh_estado ?? "Pendiente de consulta"}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="contingency-grid">
        <section className="contingency-panel">
          <div className="panel-head">
            <div>
              <h2>Eventos del Ministerio de Hacienda</h2>
              <p>Eventos de contingencia firmados y transmitidos al Ministerio de Hacienda.</p>
            </div>
            <History size={20} />
          </div>
          {events.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Estado</th>
                    <th>Código</th>
                    <th>Sello</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td><StatusPill status={event.status} /></td>
                      <td className="mono">{shortCode(event.codigo_generacion)}</td>
                      <td className="mono">{event.sello_recibido ? shortCode(event.sello_recibido) : "Pendiente"}</td>
                      <td className="numeric">{formatDateTime(event.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Clock size={18} />} text="Sin eventos de contingencia transmitidos." />
          )}
        </section>

        <section className="contingency-panel">
          <div className="panel-head">
            <div>
              <h2>Periodos</h2>
              <p>Ventanas abiertas, selladas, cerradas o fallidas.</p>
            </div>
            <Clock size={20} />
          </div>
          {periods.length > 0 ? (
            <div className="contingency-periods">
              {periods.map((period) => (
                <div key={period.id} className="contingency-period-row">
                  <StatusPill status={period.status} />
                  <div>
                    <strong>{contingencyTypeLabel(period.tipo_contingencia)}</strong>
                    <span>{period.reason}</span>
                  </div>
                  <span className="numeric">{formatDateTime(period.started_at)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Clock size={18} />} text="Sin periodos registrados." />
          )}
        </section>
      </div>

      <section className="contingency-panel">
        <div className="panel-head">
          <div>
            <h2>Auditoría del periodo</h2>
            <p>Acciones registradas para los periodos históricos de contingencia.</p>
          </div>
          <History size={20} />
        </div>
        {audit.length > 0 ? (
          <div className="contingency-audit-list">
            {audit.slice(0, 8).map((row) => (
              <div key={row.id}>
                <strong>{auditActionLabel(row.action)}</strong>
                <span>{auditSummaryLabel(row.summary)}</span>
                <time>{formatDateTime(row.created_at)}</time>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<AlertTriangle size={18} />} text="Sin auditoría para el periodo activo." />
        )}
      </section>
    </section>
  );
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function ExportPanel({
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

function certificateYearOptions(): number[] {
  const current = new Date().getFullYear();
  return [current, current - 1, current - 2, current - 3];
}

function AnnualCertificatePanel({
  year,
  yearOptions,
  preview,
  busy,
  onYearChange,
  onSend
}: {
  year: string;
  yearOptions: number[];
  preview: AnnualCertificatePreview | null;
  busy: boolean;
  onYearChange: (year: string) => void;
  onSend: () => Promise<void>;
}) {
  const donors = preview?.donors ?? [];
  const withEmail = preview?.withEmail ?? 0;
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
        <button className="primary" disabled={busy || withEmail === 0} onClick={() => void onSend()}>
          <Download size={16} />
          {busy ? "Enviando" : "Enviar constancias"}
        </button>
      </div>
      <div className="export-summary">
        <strong>{preview?.donorCount ?? 0}</strong>
        <span>donantes</span>
        <strong>{withEmail}</strong>
        <span>con correo</span>
        <strong>{preview?.totalLabel ?? "$0.00"}</strong>
        <span>total</span>
      </div>
      <p className="hint">
        Se enviará a los donantes con correo. Los donantes sin correo aparecen en la vista previa pero se omiten al enviar.
      </p>
      <div className="table-scroll export-table certificate-table">
        <table>
          <thead>
            <tr>
              <th>Donante</th>
              <th className="numeric">Donaciones</th>
              <th className="numeric">Total</th>
              <th>Correo</th>
            </tr>
          </thead>
          <tbody>
            {donors.map((donor) => (
              <tr key={donor.donorName + (donor.donorEmail ?? "")}>
                <td>
                  <StackedCell primary={donor.donorName} secondary={donor.donorEmail ?? ""} />
                </td>
                <td className="numeric">{donor.count}</td>
                <td className="numeric">{donor.totalLabel}</td>
                <td>{donor.hasEmail ? "Sí" : "—"}</td>
              </tr>
            ))}
            {donors.length === 0 && (
              <tr>
                <td colSpan={4}>Sin donaciones aceptadas para este año.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

function OnlineDonationsPanel({ intents }: { intents: DonationIntentListItem[] }) {
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
                <td className="numeric">{formatMoneyCents(intent.amount_cents)}</td>
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

function BackupsPanel({
  months,
  verifyByMonth,
  busy,
  onVerify,
  onDownload,
  onExport
}: {
  months: BackupMonth[];
  verifyByMonth: Record<string, BackupVerifyResult>;
  busy: string;
  onVerify: (month: string) => Promise<void>;
  onDownload: (month: string, table: string) => Promise<void>;
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

function CredentialsPanel({
  status,
  emissionEnvironment,
  emailTemplates,
  emailTemplateDraft,
  alertEmailDraft,
  input,
  busy,
  emissionBusy,
  templateBusy,
  alertEmailBusy,
  writerBusy,
  onChange,
  onSubmit,
  onEmailTemplateChange,
  onEmailTemplateSubmit,
  onEmissionEnvironmentChange,
  onAlertEmailChange,
  onAlertEmailSubmit,
  onBootstrapWriter,
  onRefresh
}: {
  status: CredentialStatus | null;
  emissionEnvironment: EmissionEnvironmentState | null;
  emailTemplates: EmailTemplateSettings | null;
  emailTemplateDraft: Record<string, EmailTemplateValue>;
  alertEmailDraft: string;
  input: CredentialFormInput;
  busy: boolean;
  emissionBusy: boolean;
  templateBusy: boolean;
  alertEmailBusy: boolean;
  writerBusy: boolean;
  onChange: (input: CredentialFormInput) => void;
  onSubmit: () => Promise<void>;
  onEmailTemplateChange: (type: string, patch: Partial<EmailTemplateValue>) => void;
  onEmailTemplateSubmit: () => Promise<void>;
  onEmissionEnvironmentChange: (environment: EmissionEnvironmentState["environment"]) => Promise<void>;
  onAlertEmailChange: (value: string) => void;
  onAlertEmailSubmit: () => Promise<void>;
  onBootstrapWriter: (cloudflareToken: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  const groups = status ? Object.entries(status.groups) : [];
  const mhUserSecret = input.environment === "test" ? "MH_USER_TEST" : "MH_USER_PROD";
  const mhPasswordSecret = input.environment === "test" ? "MH_PASSWORD_TEST" : "MH_PASSWORD_PROD";
  const activeMhGroup = input.environment === "test" ? status?.groups.mhTest : status?.groups.mhProduction;
  const webhookUrl = typeof window === "undefined" ? "/webhooks/wompi" : new URL("/webhooks/wompi", window.location.origin).toString();
  const writerConfigured = status?.target.writerConfigured === true;
  const writerMissing = status?.target.writerMissing ?? [];
  const writerNeedsOnlyToken = writerMissing.length === 1 && writerMissing[0] === "CLOUDFLARE_API_TOKEN";
  const signerConfigured = credentialConfigured(status, "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2");
  const certificateExpiry = certificateExpiryStatus(status?.certificateExpiresAt ?? null);
  const [certificateFileError, setCertificateFileError] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [writerCommandCopied, setWriterCommandCopied] = useState(false);
  const [writerToken, setWriterToken] = useState("");
  const [writerTokenError, setWriterTokenError] = useState("");
  const [activeSection, setActiveSection] = useState<CredentialSettingsSectionId>("ambiente");
  const [pendingEmissionEnvironment, setPendingEmissionEnvironment] = useState<EmissionEnvironmentState["environment"] | null>(null);
  const writerSetupCommand = `wrangler secret put CLOUDFLARE_API_TOKEN --env ${status?.target.appEnv || "staging"}`;
  const writerMessage = writerConfigured
    ? "Guardado seguro de credenciales habilitado"
    : writerMissing.length > 0
      ? `No se pueden guardar cambios todavía. Falta ${credentialWriterMissingLabel(writerMissing)}.`
      : "No se pueden guardar cambios todavía.";
  const activeEnvironmentLabel = input.environment === "test" ? "Pruebas 00" : "Producción 01";
  const runtimeEnvironment = credentialRuntimeEnvironment(emissionEnvironment, status?.target.appEnv);
  const activeSectionMeta = credentialSettingsSections.find((section) => section.id === activeSection) ?? credentialSettingsSections[0];
  const activeSectionDescription = credentialSettingsPanelDescription(activeSection, activeEnvironmentLabel);
  async function handleCertificateFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const text = await file.text();
      const trimmed = text.trim();
      if (!trimmed) {
        setCertificateFileError("El archivo seleccionado está vacío.");
        return;
      }
      if (!trimmed.startsWith("<") || !trimmed.includes("CertificadoMH")) {
        setCertificateFileError("El archivo no parece ser el certificado .crt/.xml del Ministerio de Hacienda para firma.");
        return;
      }
      setCertificateFileError("");
      onChange({ ...input, certificateXml: text, certificateFileName: file.name });
    } catch {
      setCertificateFileError("No se pudo leer el archivo seleccionado.");
    }
  }
  async function copyWebhookUrl(): Promise<void> {
    try {
      await copyText(webhookUrl);
      setWebhookCopied(true);
      window.setTimeout(() => setWebhookCopied(false), 1600);
    } catch {
      setWebhookCopied(false);
    }
  }
  async function copyWriterSetupCommand(): Promise<void> {
    try {
      await copyText(writerSetupCommand);
      setWriterCommandCopied(true);
      window.setTimeout(() => setWriterCommandCopied(false), 1600);
    } catch {
      setWriterCommandCopied(false);
    }
  }
  async function submitWriterToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = writerToken.trim();
    if (!trimmed) {
      setWriterTokenError("Ingrese el token API de Cloudflare.");
      return;
    }
    setWriterTokenError("");
    const saved = await onBootstrapWriter(trimmed);
    if (saved) {
      setWriterToken("");
    }
  }
  function requestEmissionEnvironmentChange(environment: EmissionEnvironmentState["environment"]): void {
    if (emissionBusy || runtimeEnvironment.environment === environment) return;
    setPendingEmissionEnvironment(environment);
  }
  async function confirmEmissionEnvironmentChange(): Promise<void> {
    if (!pendingEmissionEnvironment) return;
    const environment = pendingEmissionEnvironment;
    setPendingEmissionEnvironment(null);
    await onEmissionEnvironmentChange(environment);
  }
  return (
    <section className="credential-layout">
      <div className="credential-main-panel">
        <div className="credential-settings-shell">
          <nav className="credential-settings-nav" aria-label="Secciones de credenciales">
            <div className="credential-settings-nav-head">
              <span>Configuración</span>
              <small>Elija una sección para editar solo lo necesario.</small>
            </div>
            {credentialSettingsSections.map((section) => {
              const SectionIcon = credentialSettingsSectionIcons[section.id];
              const sectionState = credentialSectionState(section.id, status);
              return (
                <button
                  className={activeSection === section.id ? "credential-settings-nav-item active" : "credential-settings-nav-item"}
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                >
                  <SectionIcon size={17} />
                  <span>
                    <strong>{section.label}</strong>
                    <small>{section.description}</small>
                  </span>
                  <em className={sectionState}>{sectionState === "ready" ? "Listo" : "Pendiente"}</em>
                </button>
              );
            })}
          </nav>

          <div className="credential-settings-detail">
            {activeSection === "plantillas" ? (
              <EmailTemplateEditor
                settings={emailTemplates}
                draft={emailTemplateDraft}
                busy={templateBusy}
                onChange={onEmailTemplateChange}
                onSubmit={onEmailTemplateSubmit}
              />
            ) : (
              <form
                className="credential-form-panel credential-detail-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onSubmit();
                }}
              >
                <div className="panel-head">
                  <div>
                    <h2>{activeSectionMeta.label}</h2>
                    <p>{activeSectionDescription}</p>
                  </div>
                  <Lock size={20} />
                </div>

                {activeSection === "ambiente" && (
                  <div className="credential-section-content">
                    <div className="credential-runtime-env">
                      <div>
                        <span>Ambiente activo de emisión</span>
                        <strong>{runtimeEnvironment.label}</strong>
                      </div>
                      <p>{runtimeEnvironment.help}</p>
                      <div className="segmented credential-runtime-selector" aria-label="Ambiente activo de emisión">
                        <button
                          type="button"
                          className={runtimeEnvironment.environment === "00" ? "active" : ""}
                          disabled={emissionBusy}
                          onClick={() => requestEmissionEnvironmentChange("00")}
                        >
                          Pruebas 00
                        </button>
                        <button
                          type="button"
                          className={runtimeEnvironment.environment === "01" ? "active" : ""}
                          disabled={emissionBusy}
                          onClick={() => requestEmissionEnvironmentChange("01")}
                        >
                          Producción 01
                        </button>
                      </div>
                      <small>Este cambio afecta únicamente los DTE nuevos. Los documentos ya emitidos conservan su ambiente original.</small>
                    </div>
                    <div className="credential-env-heading">
                      <span>Credenciales API del Ministerio de Hacienda a editar</span>
                      <small>Este selector no cambia el ambiente activo; solo escoge cuál usuario y contraseña del Ministerio de Hacienda desea revisar o rotar.</small>
                    </div>
                    <div className="segmented credential-env">
                      <button type="button" className={input.environment === "test" ? "active" : ""} onClick={() => onChange({ ...input, environment: "test" })}>Pruebas 00</button>
                      <button type="button" className={input.environment === "production" ? "active" : ""} onClick={() => onChange({ ...input, environment: "production" })}>Producción 01</button>
                    </div>
                    <div className={activeMhGroup?.ready ? "credential-form-state ready" : "credential-form-state"}>
                      {activeMhGroup?.ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                      <span>{activeEnvironmentLabel}: {activeMhGroup?.ready ? "credenciales API del Ministerio de Hacienda configuradas" : "credenciales API del Ministerio de Hacienda pendientes"}</span>
                    </div>
                  </div>
                )}

                {activeSection === "mh" && (
                  <div className="credential-section-content">
                    <div className="credential-env-heading">
                      <span>Credenciales API del Ministerio de Hacienda a editar</span>
                      <small>Seleccione el ambiente cuyas credenciales API quiere reemplazar.</small>
                    </div>
                    <div className="segmented credential-env">
                      <button type="button" className={input.environment === "test" ? "active" : ""} onClick={() => onChange({ ...input, environment: "test" })}>Pruebas 00</button>
                      <button type="button" className={input.environment === "production" ? "active" : ""} onClick={() => onChange({ ...input, environment: "production" })}>Producción 01</button>
                    </div>
                    <div className={activeMhGroup?.ready ? "credential-form-state ready" : "credential-form-state"}>
                      {activeMhGroup?.ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                      <span>{activeEnvironmentLabel}: {activeMhGroup?.ready ? "credenciales API del Ministerio de Hacienda configuradas" : "credenciales API del Ministerio de Hacienda pendientes"}</span>
                    </div>
                    <div className="credential-fields">
                      <div className="credential-section-title span-2">
                        <h3>Credenciales API del Ministerio de Hacienda ({activeEnvironmentLabel})</h3>
                        <p>Estos dos campos son los únicos que cambian con el selector de ambiente.</p>
                      </div>
                      <label>
                        <CredentialFieldLabel label="Usuario API del Ministerio de Hacienda" configured={credentialConfigured(status, mhUserSecret)} />
                        <CredentialActiveValue status={status} name={mhUserSecret} />
                        <input value={input.mhUser} onChange={(event) => onChange({ ...input, mhUser: event.target.value })} placeholder={credentialReplacementPlaceholder(status, mhUserSecret, "Nuevo usuario API del Ministerio de Hacienda")} autoComplete="off" />
                      </label>
                      <label>
                        <CredentialFieldLabel label="Contraseña API del Ministerio de Hacienda" configured={credentialConfigured(status, mhPasswordSecret)} />
                        <CredentialActiveValue status={status} name={mhPasswordSecret} />
                        <input value={input.mhPassword} onChange={(event) => onChange({ ...input, mhPassword: event.target.value })} placeholder={credentialReplacementPlaceholder(status, mhPasswordSecret, "Nueva contraseña API del Ministerio de Hacienda")} type="password" autoComplete="new-password" />
                      </label>
                    </div>
                  </div>
                )}

                {activeSection === "firmador" && (
                  <div className="credential-fields">
                    <div className="credential-section-title span-2">
                      <h3>Firmador del Ministerio de Hacienda</h3>
                      <p>Certificado y contraseña usados para firmar los DTE antes de transmitirlos.</p>
                    </div>
                    <div className={`legal-box ${certificateExpiry.tone} span-2`}>
                      <ShieldCheck size={17} />
                      <div>
                        <strong>{certificateExpiry.label}</strong>
                      </div>
                    </div>
                    <div className="credential-field-block span-2">
                      <CredentialFieldLabel label="Certificado firmador del Ministerio de Hacienda (.crt/.xml)" configured={signerConfigured} />
                      <CredentialActiveValue status={status} name="MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2" />
                      <div className="credential-file-row">
                        <label className="file-upload-button">
                          <Upload size={16} />
                          Reemplazar certificado
                          <input
                            className="file-input-hidden"
                            type="file"
                            accept=".crt,.xml,text/xml,application/xml,text/plain"
                            onChange={(event) => void handleCertificateFile(event.currentTarget.files?.[0])}
                          />
                        </label>
                        <span className="credential-file-status">
                          {input.certificateFileName || (signerConfigured ? "Certificado ya configurado; cargue otro archivo solo para rotarlo." : "Sin archivo seleccionado.")}
                        </span>
                      </div>
                      <textarea value={input.certificateXml} onChange={(event) => onChange({ ...input, certificateXml: event.target.value, certificateFileName: "" })} placeholder={credentialReplacementPlaceholder(status, "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2", "Pegue aquí el nuevo certificado .crt/.xml del Ministerio de Hacienda o cargue el archivo")} spellCheck={false} />
                      <small>Este campo es para reemplazar el certificado que el Ministerio de Hacienda entrega para firmar DTE. No se muestra el certificado activo porque contiene material privado de firma.</small>
                      {certificateFileError && <small className="field-error">{certificateFileError}</small>}
                    </div>
                    <label>
                      <CredentialFieldLabel label="Contraseña de llave privada" configured={credentialConfigured(status, "MH_CERT_PASSWORD")} />
                      <CredentialActiveValue status={status} name="MH_CERT_PASSWORD" />
                      <input value={input.certificatePassword} onChange={(event) => onChange({ ...input, certificatePassword: event.target.value })} placeholder={credentialReplacementPlaceholder(status, "MH_CERT_PASSWORD", "Nueva contraseña de llave privada")} type="password" autoComplete="new-password" />
                    </label>
                  </div>
                )}

                {activeSection === "wompi" && (
                  <div className="credential-fields">
                    <div className="credential-section-title span-2">
                      <h3>Webhook entrante de Wompi</h3>
                      <p>Wompi invoca esta URL cuando aprueba un pago; el Worker valida la firma antes de emitir el CDE.</p>
                    </div>
                    <label className="span-2">
                      <CredentialFieldLabel label="Secreto de firma del webhook Wompi" configured={credentialConfigured(status, "WOMPI_API_SECRET")} />
                      <CredentialActiveValue status={status} name="WOMPI_API_SECRET" />
                      <input value={input.wompiSecret} onChange={(event) => onChange({ ...input, wompiSecret: event.target.value })} placeholder={credentialReplacementPlaceholder(status, "WOMPI_API_SECRET", "Nuevo secreto de firma Wompi")} type="password" autoComplete="new-password" />
                    </label>
                    <div className="credential-field-block span-2">
                      <span className="plain-field-label">URL del webhook de Wompi</span>
                      <div className="credential-readonly-row">
                        <div className="credential-readonly-endpoint">
                          <code>{webhookUrl}</code>
                        </div>
                        <button className="endpoint-copy-button" type="button" onClick={() => void copyWebhookUrl()} title="Copiar URL del webhook de Wompi">
                          <Copy size={15} />
                          {webhookCopied ? "Copiado" : "Copiar"}
                        </button>
                      </div>
                      <small>Configure esta URL en Wompi como endpoint de notificación para pagos aprobados.</small>
                    </div>
                  </div>
                )}

                {activeSection === "emisor" && (
                  <div className="credential-fields">
                    <IssuerConfigEditor status={status} input={input} onChange={onChange} />
                  </div>
                )}

                {activeSection === "correo" && (
                  <div className="credential-fields">
                    <div className="credential-section-title span-2">
                      <h3>Correo Cloudflare y respaldo HTTP</h3>
                      <p>
                        El envío principal usa Cloudflare Email Workers. El respaldo es un endpoint HTTPS con POST JSON y
                        Authorization: Bearer; se usa solo si Cloudflare Email no puede entregar el comprobante.
                      </p>
                    </div>
                    <label>
                      <CredentialFieldLabel label="Endpoint HTTPS de respaldo (POST JSON)" configured={credentialConfigured(status, "EMAIL_API_URL")} />
                      <CredentialActiveValue status={status} name="EMAIL_API_URL" />
                      <input value={input.emailApiUrl} onChange={(event) => onChange({ ...input, emailApiUrl: event.target.value })} placeholder={credentialReplacementPlaceholder(status, "EMAIL_API_URL", "https://correo.example/send")} type="url" />
                      <small>Recibe un POST JSON con remitente, destinatario, asunto, texto, HTML y adjuntos PDF/JSON en base64.</small>
                    </label>
                    <label>
                      <CredentialFieldLabel label="Token bearer del respaldo HTTP" configured={credentialConfigured(status, "EMAIL_API_KEY")} />
                      <CredentialActiveValue status={status} name="EMAIL_API_KEY" />
                      <input value={input.emailApiKey} onChange={(event) => onChange({ ...input, emailApiKey: event.target.value })} placeholder={credentialReplacementPlaceholder(status, "EMAIL_API_KEY", "Nuevo token bearer")} type="password" autoComplete="new-password" />
                      <small>Se envía como Authorization: Bearer.</small>
                    </label>
                    <label>
                      <CredentialFieldLabel label="Correo remitente" configured={credentialConfigured(status, "EMAIL_FROM")} />
                      <CredentialActiveValue status={status} name="EMAIL_FROM" />
                      <input value={input.emailFrom} onChange={(event) => onChange({ ...input, emailFrom: event.target.value })} placeholder={credentialReplacementPlaceholder(status, "EMAIL_FROM", "Nuevo correo remitente")} type="email" />
                      <small>Usado como remitente tanto en Cloudflare Email como en el respaldo.</small>
                    </label>
                    <div className="credential-field-block span-2">
                      <div className="credential-section-title">
                        <h3>Alertas operativas</h3>
                      </div>
                      <label>
                        <span className="plain-field-label">Correo para avisos operativos</span>
                        <input
                          value={alertEmailDraft}
                          onChange={(event) => onAlertEmailChange(event.target.value)}
                          placeholder="admin@example.org"
                          type="email"
                        />
                        <small>Recibirá avisos de fallos de emisión, contingencias y eventos estancados.</small>
                      </label>
                      <button
                        className="primary"
                        type="button"
                        disabled={alertEmailBusy}
                        onClick={() => void onAlertEmailSubmit()}
                      >
                        {alertEmailBusy ? "Guardando" : "Guardar correo de alertas"}
                      </button>
                    </div>
                  </div>
                )}

                {activeSection !== "ambiente" && (
                  <div className="credential-actions">
                    <div>
                      <EyeOff size={16} />
                      <span>{writerConfigured ? "Los valores protegidos no se muestran después de guardarse." : "Configure un token API de Cloudflare para guardar cambios desde esta pantalla."}</span>
                    </div>
                    <button className="primary" disabled={busy || !writerConfigured} type="submit">
                      <KeyRound size={16} />
                      {busy ? "Guardando" : "Guardar secretos"}
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      </div>
      <div className="credential-status-panel">
        <div className="panel-head">
          <div>
            <h2>Estado de secretos</h2>
            <p>{status?.target.scriptName ?? "Worker no configurado"} · {status?.target.appEnv ?? "sin ambiente"}</p>
          </div>
          <button className="icon-button" onClick={() => void onRefresh()} title="Actualizar">
            <RefreshCw size={17} />
          </button>
        </div>
        <div className={writerConfigured ? "writer-state ready" : "writer-state"}>
          <Cloud size={17} />
          <div>
            <span>{writerMessage}</span>
            {writerConfigured ? (
              <small>Puede actualizar credenciales desde esta pantalla; se guardarán como secretos del Worker en Cloudflare.</small>
            ) : (
              <small>Las credenciales actuales siguen funcionando; solo falta habilitar cambios desde esta pantalla.</small>
            )}
          </div>
        </div>
        {!writerConfigured && (
          <div className="writer-remedy">
            <div>
              <h3>Habilitar edición desde el panel</h3>
              {writerNeedsOnlyToken ? (
                <p>
                  Pegue el token API de Cloudflare una sola vez para que el Worker lo guarde como secreto y pueda rotar credenciales desde esta pantalla.
                  El token no se muestra ni se guarda en D1.
                </p>
              ) : (
                <p>Antes de activar esta edición faltan datos del Worker: {credentialWriterMissingLabel(writerMissing)}.</p>
              )}
            </div>
            {writerNeedsOnlyToken && (
              <form className="writer-token-form" onSubmit={(event) => void submitWriterToken(event)}>
                <label>
                  <span>Token API de Cloudflare</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={writerToken}
                    onChange={(event) => {
                      setWriterToken(event.target.value);
                      setWriterTokenError("");
                    }}
                    placeholder="Pegar token API"
                  />
                </label>
                <button className="primary" type="submit" disabled={writerBusy || !writerToken.trim()}>
                  <KeyRound size={15} />
                  {writerBusy ? "Activando..." : "Activar edición"}
                </button>
                {writerTokenError && <small className="field-error">{writerTokenError}</small>}
              </form>
            )}
            <details className="writer-terminal-fallback">
              <summary>Usar Wrangler en terminal</summary>
              <div className="writer-command-row">
                <code>{writerSetupCommand}</code>
                <button type="button" onClick={() => void copyWriterSetupCommand()} title="Copiar comando para configurar token">
                  <Copy size={15} />
                  {writerCommandCopied ? "Copiado" : "Copiar"}
                </button>
              </div>
              <small>Ejecute el comando desde la carpeta del proyecto y pegue el token solo en el prompt seguro de Wrangler.</small>
            </details>
          </div>
        )}
        <div className="credential-groups">
          {groups.map(([id, group]) => (
            <div className="credential-group" key={id}>
              <div className="credential-group-title">
                {group.ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <strong>{group.label}</strong>
              </div>
              <ul>
                {group.items.map((item) => (
                  <li key={item.name}>
                    <span>
                      {item.label}
                      {item.displayValue && <small>{credentialStatusDisplayValue(item)}</small>}
                    </span>
                    <strong className={item.configured ? "configured" : ""}>{item.configured ? "Configurado" : "Pendiente"}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      {pendingEmissionEnvironment && (
        <EmissionEnvironmentConfirmDialog
          busy={emissionBusy}
          currentEnvironment={runtimeEnvironment.environment}
          targetEnvironment={pendingEmissionEnvironment}
          onCancel={() => setPendingEmissionEnvironment(null)}
          onConfirm={() => void confirmEmissionEnvironmentChange()}
        />
      )}
    </section>
  );
}

function EmailTemplateEditor({
  settings,
  draft,
  busy,
  onChange,
  onSubmit
}: {
  settings: EmailTemplateSettings | null;
  draft: Record<string, EmailTemplateValue>;
  busy: boolean;
  onChange: (type: string, patch: Partial<EmailTemplateValue>) => void;
  onSubmit: () => Promise<void>;
}) {
  const definitions = settings?.definitions ?? [];
  const placeholders = settings?.placeholders ?? [];
  const complete = definitions.every((definition) => draft[definition.type]?.subject.trim() && draft[definition.type]?.body.trim());
  return (
    <section className="credential-form-panel email-template-panel">
      <div className="panel-head">
        <div>
          <h2>Plantillas de correo</h2>
          <p>Asunto y mensaje para cada correo automático enviado al donante.</p>
        </div>
        <Mail size={20} />
      </div>
      {definitions.length === 0 ? (
        <div className="empty-state">Cargando plantillas de correo.</div>
      ) : (
        <>
          <div className="email-template-guidance">
            <span>Use variables para insertar datos del CDE. Los nuevos tipos de correo aparecerán en esta misma sección.</span>
            <div className="email-template-placeholders" aria-label="Variables disponibles">
              {placeholders.map((placeholder) => <code key={placeholder}>{placeholder}</code>)}
            </div>
          </div>
          <div className="email-template-list">
            {definitions.map((definition) => {
              const value = draft[definition.type] ?? { subject: "", body: "" };
              return (
                <section className="email-template-card" key={definition.type}>
                  <div>
                    <h3>{definition.label}</h3>
                    <p>{definition.description}</p>
                  </div>
                  <label>
                    <span>Asunto</span>
                    <input
                      value={value.subject}
                      onChange={(event) => onChange(definition.type, { subject: event.target.value })}
                      placeholder={definition.defaultSubject}
                    />
                  </label>
                  <label>
                    <span>Cuerpo del correo</span>
                    <textarea
                      value={value.body}
                      onChange={(event) => onChange(definition.type, { body: event.target.value })}
                      placeholder={definition.defaultBody}
                    />
                  </label>
                </section>
              );
            })}
          </div>
          <div className="credential-actions email-template-actions">
            <div>
              <Mail size={16} />
              <span>Estos textos se aplican al próximo envío o reenvío de correo.</span>
            </div>
            <button className="primary" type="button" disabled={busy || !complete} onClick={() => void onSubmit()}>
              <Mail size={16} />
              {busy ? "Guardando" : "Guardar plantillas"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function cloneEmailTemplates(templates: Record<string, EmailTemplateValue>): Record<string, EmailTemplateValue> {
  return Object.fromEntries(
    Object.entries(templates).map(([type, template]) => [
      type,
      {
        subject: template.subject,
        body: template.body
      }
    ])
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function IssuerConfigEditor({
  status,
  input,
  onChange
}: {
  status: CredentialStatus | null;
  input: CredentialFormInput;
  onChange: (input: CredentialFormInput) => void;
}) {
  const activeJson = credentialItem(status, "EMISOR_CONFIG_JSON")?.displayValue ?? "";
  const form = useMemo(() => issuerFormFromConfigJson(input.emisorConfigJson || activeJson), [activeJson, input.emisorConfigJson]);
  const municipalityOptions = getCat013Municipalities(form.departamento);
  const districtOptions = getCat008Districts(form.departamento);
  const configured = credentialConfigured(status, "EMISOR_CONFIG_JSON");
  const update = (patch: Partial<IssuerConfigFormInput>) => {
    const next = { ...form, ...patch };
    onChange({ ...input, emisorConfigJson: issuerConfigJsonFromForm(next) });
  };
  const updateDepartment = (departamento: string) => {
    const municipalities = getCat013Municipalities(departamento);
    const districts = getCat008Districts(departamento);
    update({
      departamento,
      municipio: catalogSelectValue(municipalities, form.municipio) || municipalities[0]?.code || "",
      distrito: catalogSelectValue(districts, form.distrito) || districts[0]?.code || ""
    });
  };
  const updateActivity = (codActividad: string) => {
    update({
      codActividad,
      descActividad: findCatalogOption(CAT019_ACTIVITIES, codActividad)?.label ?? form.descActividad
    });
  };
  return (
    <div className="issuer-config-editor span-2">
      <CredentialFieldLabel label="Configuración del emisor" configured={configured} />
      <div className={configured ? "issuer-config-status ready" : "issuer-config-status"}>
        {configured ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        <span>{configured ? "Datos activos cargados en campos editables" : "Complete los datos del emisor para habilitar emisión real"}</span>
      </div>
      <div className="issuer-config-grid">
        <div className="credential-subsection span-2">
          <h4>Identificación fiscal</h4>
          <p>Información legal del emisor ante el Ministerio de Hacienda.</p>
        </div>
        <label>
          <span>Tipo documento del emisor</span>
          <CatalogSelect value={form.tipoDocumento} options={CAT022_ISSUER_DOCUMENT_TYPES} onChange={(tipoDocumento) => update({ tipoDocumento })} />
          <small>Para emitir CDE, el emisor se identifica con NIT de contribuyente.</small>
        </label>
        <label>
          <span>Número documento</span>
          <input value={form.numDocumento} onChange={(event) => update({ numDocumento: event.target.value })} placeholder="NIT del emisor" inputMode="numeric" maxLength={14} />
        </label>
        <label>
          <span>NRC</span>
          <input value={form.nrc} onChange={(event) => update({ nrc: event.target.value })} placeholder="Opcional" inputMode="numeric" maxLength={8} />
        </label>
        <label>
          <span>Nombre legal</span>
          <input value={form.nombre} onChange={(event) => update({ nombre: event.target.value })} placeholder="Nombre registrado" />
        </label>
        <label>
          <span>Nombre comercial</span>
          <input value={form.nombreComercial} onChange={(event) => update({ nombreComercial: event.target.value })} placeholder="Opcional" />
        </label>
        <label>
          <span>Actividad económica</span>
          <CatalogSelect value={form.codActividad} options={CAT019_ACTIVITIES} onChange={updateActivity} />
        </label>
        <label className="span-2">
          <span>Descripción actividad</span>
          <input value={form.descActividad} onChange={(event) => update({ descActividad: event.target.value })} placeholder="Se completa desde CAT-019 al elegir actividad" />
        </label>

        <div className="credential-subsection span-2">
          <h4>Dirección fiscal</h4>
          <p>Ubicación declarada para el emisor.</p>
        </div>
        <label>
          <span>Departamento</span>
          <CatalogSelect value={form.departamento} options={CAT012_DEPARTMENTS} onChange={updateDepartment} />
        </label>
        <label>
          <span>Municipio</span>
          <CatalogSelect value={form.municipio} options={municipalityOptions} onChange={(municipio) => update({ municipio })} />
        </label>
        <label>
          <span>Distrito</span>
          <CatalogSelect value={form.distrito} options={districtOptions} onChange={(distrito) => update({ distrito })} />
        </label>
        <label className="span-2">
          <span>Complemento de dirección</span>
          <textarea value={form.direccionComplemento} onChange={(event) => update({ direccionComplemento: event.target.value })} placeholder="Dirección completa" />
        </label>

        <div className="credential-subsection span-2">
          <h4>Contacto y control</h4>
          <p>Códigos de establecimiento, punto de venta y numeración CDE.</p>
        </div>
        <label>
          <span>Teléfono</span>
          <input value={form.telefono} onChange={(event) => update({ telefono: event.target.value })} placeholder="Teléfono del emisor" />
        </label>
        <label>
          <span>Correo</span>
          <input value={form.correo} onChange={(event) => update({ correo: event.target.value })} placeholder="Correo del emisor" type="email" />
        </label>
        <label>
          <span>Código establecimiento del Ministerio de Hacienda</span>
          <input value={form.codEstableMH} onChange={(event) => update({ codEstableMH: event.target.value })} placeholder="M001" />
        </label>
        <label>
          <span>Código punto de venta del Ministerio de Hacienda</span>
          <input value={form.codPuntoVentaMH} onChange={(event) => update({ codPuntoVentaMH: event.target.value })} placeholder="P004" />
        </label>
        <label>
          <span>Código establecimiento interno</span>
          <input value={form.codEstable} onChange={(event) => update({ codEstable: event.target.value })} placeholder="Opcional" />
        </label>
        <label>
          <span>Código punto venta interno</span>
          <input value={form.codPuntoVenta} onChange={(event) => update({ codPuntoVenta: event.target.value })} placeholder="Opcional" />
        </label>
        <label className="span-2">
          <span>Prefijo número de control</span>
          <input value={form.controlPrefix} onChange={(event) => update({ controlPrefix: event.target.value })} placeholder="M001P004" />
        </label>

        <div className="credential-subsection span-2">
          <h4>Valores por defecto CDE</h4>
          <p>Se aplican a DTE rápido y a campos no especificados en flujos automáticos.</p>
        </div>
        <label>
          <span>Documento receptor por defecto</span>
          <CatalogSelect value={form.defaultReceptorTipoDocumento} options={CAT022_DOCUMENT_TYPES} onChange={(defaultReceptorTipoDocumento) => update({ defaultReceptorTipoDocumento })} />
        </label>
        <label>
          <span>País receptor por defecto</span>
          <CatalogSelect value={form.defaultCodPais} options={CAT020_COUNTRIES} onChange={(defaultCodPais) => update({ defaultCodPais })} />
        </label>
        <label>
          <span>Tipo donación por defecto</span>
          <CatalogSelect value={form.defaultDonationType} options={CAT026_DONATION_TYPES} onChange={(defaultDonationType) => update({ defaultDonationType })} />
        </label>
        <label>
          <span>Unidad medida por defecto</span>
          <CatalogSelect value={form.defaultUnidadMedida} options={CAT014_UNITS} onChange={(defaultUnidadMedida) => update({ defaultUnidadMedida })} />
        </label>
        <label className="span-2">
          <span>Forma de pago por defecto</span>
          <CatalogSelect value={form.paymentMethodCode} options={CAT017_PAYMENT_FORMS} onChange={(paymentMethodCode) => update({ paymentMethodCode })} />
        </label>

        <div className="credential-subsection span-2">
          <h4>Responsable</h4>
          <p>Persona usada en eventos administrativos como contingencia e invalidación.</p>
        </div>
        <label>
          <span>Nombre responsable</span>
          <input value={form.responsableNombre} onChange={(event) => update({ responsableNombre: event.target.value })} />
        </label>
        <label>
          <span>Tipo documento responsable</span>
          <CatalogSelect value={form.responsableTipoDocumento} options={CAT022_DOCUMENT_TYPES} onChange={(responsableTipoDocumento) => update({ responsableTipoDocumento })} />
        </label>
        <label>
          <span>Número documento responsable</span>
          <input value={form.responsableNumeroDocumento} onChange={(event) => update({ responsableNumeroDocumento: event.target.value })} />
        </label>
        <label>
          <span>Tipo establecimiento</span>
          <input value={form.responsableTipoEstablecimiento} onChange={(event) => update({ responsableTipoEstablecimiento: event.target.value })} placeholder="Casa Matriz, sucursal, etc." />
        </label>
      </div>
    </div>
  );
}

function credentialWriterMissingLabel(names: string[]): string {
  const labels: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "ID de cuenta Cloudflare (CLOUDFLARE_ACCOUNT_ID)",
    CLOUDFLARE_SCRIPT_NAME: "nombre del Worker (CLOUDFLARE_SCRIPT_NAME)",
    CLOUDFLARE_API_TOKEN: "token API de Cloudflare (CLOUDFLARE_API_TOKEN)"
  };
  return names.map((name) => labels[name] ?? name).join(", ");
}

function EmissionEnvironmentConfirmDialog({
  busy,
  currentEnvironment,
  targetEnvironment,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  currentEnvironment: EmissionEnvironmentState["environment"];
  targetEnvironment: EmissionEnvironmentState["environment"];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const targetLabel = environmentLabel(targetEnvironment);
  const isProductionTarget = targetEnvironment === "01";
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
        aria-labelledby="emission-environment-confirm-title"
      >
        <header>
          <div>
            <h2 id="emission-environment-confirm-title">Confirmar cambio de ambiente</h2>
            <p>Este cambio aplica a los próximos CDE generados o recibidos por webhook. Los documentos ya emitidos conservan su ambiente original.</p>
          </div>
          <button className="icon-button" onClick={onCancel} disabled={busy} title="Cerrar">
            <X size={17} />
          </button>
        </header>
        <div className="legal-box warning">
          <AlertTriangle size={17} />
          <div>
            <strong>{isProductionTarget ? "Va a activar emisión en producción" : "Va a cambiar el ambiente activo"}</strong>
            <small>
              {isProductionTarget
                ? "Confirme solo si las credenciales de producción del Ministerio de Hacienda están listas y desea emitir CDE reales."
                : "Confirme si desea que los próximos CDE usen el ambiente de pruebas del Ministerio de Hacienda."}
            </small>
          </div>
        </div>
        <dl className="confirm-facts">
          <dt>Ambiente actual</dt>
          <dd>{environmentLabel(currentEnvironment)}</dd>
          <dt>Nuevo ambiente</dt>
          <dd>{targetLabel}</dd>
        </dl>
        <footer>
          <button onClick={onCancel} disabled={busy}>Cancelar</button>
          <button className={isProductionTarget ? "danger solid" : "primary"} onClick={onConfirm} disabled={busy}>
            <AlertTriangle size={16} />
            {busy ? "Cambiando" : `Confirmar ${targetLabel}`}
          </button>
        </footer>
      </section>
    </div>
  );
}

function credentialRuntimeEnvironment(
  state: EmissionEnvironmentState | null,
  appEnv: string | null | undefined
): { environment: "00" | "01"; label: string; help: string } {
  const fallbackEnvironment = appEnv?.toLowerCase().trim() === "production" ? "01" : "00";
  const environment = state?.environment ?? fallbackEnvironment;
  const label = environmentLabel(environment);
  const source = state?.source ?? "deployment_default";
  return {
    environment,
    label,
    help: source === "setting"
      ? `Los próximos CDE se emitirán contra el Ministerio de Hacienda (${label}). Cambie este valor antes de generar o recibir pagos si necesita otro ambiente.`
      : `Usando ${label} como valor inicial. Guarde una selección aquí para controlar el ambiente activo desde la UI.`
  };
}

function credentialSettingsPanelDescription(section: CredentialSettingsSectionId, activeEnvironmentLabel: string): string {
  const descriptions: Record<CredentialSettingsSectionId, string> = {
    ambiente: "Controle el ambiente que usarán los DTE nuevos y el par de credenciales del Ministerio de Hacienda que desea revisar.",
    mh: `Reemplace el usuario y contraseña API del Ministerio de Hacienda para ${activeEnvironmentLabel}.`,
    firmador: "Rote el certificado firmador y la contraseña de la llave privada cuando el Ministerio de Hacienda entregue nuevos archivos.",
    wompi: "Configure la firma del webhook entrante y copie la URL que debe registrar en Wompi.",
    emisor: "Revise los datos fiscales y catálogos usados para construir cada CDE.",
    correo: "Revise el remitente de Cloudflare Email y el respaldo HTTP operativo.",
    plantillas: "Edite los asuntos y cuerpos de los correos automáticos."
  };
  return descriptions[section];
}

function CredentialFieldLabel({ label, configured }: { label: string; configured: boolean }) {
  return (
    <span className="credential-field-label">
      <span>{label}</span>
      <strong className={configured ? "configured" : ""}>{configured ? "Configurado" : "Pendiente"}</strong>
    </span>
  );
}

function CredentialActiveValue({ status, name, multiline = false }: { status: CredentialStatus | null; name: string; multiline?: boolean }) {
  const item = credentialItem(status, name);
  if (!item?.configured) return null;
  if (item.displayValue) {
    const value = credentialDisplayValue(item, multiline);
    return (
      <div className={multiline ? "credential-active-value multiline" : "credential-active-value"}>
        <span>Valor activo</span>
        {multiline ? <pre>{value}</pre> : <code>{value}</code>}
      </div>
    );
  }
  return (
    <div className="credential-protected-value">
      <EyeOff size={18} />
      <span>Valor protegido configurado; ingrese uno nuevo solo para reemplazarlo.</span>
    </div>
  );
}

function credentialItem(status: CredentialStatus | null, name: string): CredentialStatusItem | null {
  if (!status) return null;
  for (const group of Object.values(status.groups)) {
    const item = group.items.find((candidate) => candidate.name === name);
    if (item) return item;
  }
  return null;
}

function credentialConfigured(status: CredentialStatus | null, name: string): boolean {
  return credentialItem(status, name)?.configured === true;
}

function credentialReplacementPlaceholder(status: CredentialStatus | null, name: string, fallback: string): string {
  return credentialConfigured(status, name) ? "Nuevo valor opcional; deje vacío para conservar" : fallback;
}

function credentialDisplayValue(item: CredentialStatusItem, multiline: boolean): string {
  const value = item.displayValue ?? "";
  if (!multiline) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function credentialStatusDisplayValue(item: CredentialStatusItem): string {
  if (item.name === "EMISOR_CONFIG_JSON") {
    const form = issuerFormFromConfigJson(item.displayValue ?? "");
    const summary = [form.nombre, form.numDocumento, form.controlPrefix].map((part) => part.trim()).filter(Boolean).join(" · ");
    return summary || "Datos del emisor configurados";
  }
  const value = credentialDisplayValue(item, item.name === "EMISOR_CONFIG_JSON");
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
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

function CatalogSelect({
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

function catalogSelectValue(options: readonly CatalogOption[], value: unknown): string {
  const code = normalizeCatalogCode(value);
  return options.some((option) => option.code === code) ? code : "";
}

function AuthScreen({
  notice,
  onLogin,
  onBootstrap,
  onRequestReset,
  onConfirmReset,
  bootstrapAvailable
}: {
  notice?: string;
  onLogin: (email: string, password: string) => Promise<void>;
  onBootstrap: (email: string, name: string, password: string, setupToken: string) => Promise<void>;
  onRequestReset: (email: string) => Promise<void>;
  onConfirmReset: (token: string, password: string) => Promise<void>;
  bootstrapAvailable: boolean;
}) {
  const [resetToken] = useState(() => resetTokenFromSearch(window.location.search));
  const [mode, setMode] = useState<"login" | "bootstrap" | "reset-request" | "reset-confirm">(resetToken ? "reset-confirm" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [localNotice, setLocalNotice] = useState("");

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
        <ShieldCheck size={32} />
        <h1>ExamplePerson1</h1>
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

function Stats({ documents, onlyFailed }: { documents: DteDocument[]; onlyFailed?: boolean }) {
  const counts = countByStatus(documents);
  const fallidos = <Metric label="Fallidos" value={(counts.FAILED ?? 0) + (counts.REJECTED ?? 0)} tone="bad" />;
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

function DocumentTable({ documents, selectedId, onSelect }: { documents: DteDocument[]; selectedId?: string; onSelect: (id: string) => void }) {
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
              <td><StatusPill status={document.status} /></td>
              <td className="mono">{shortCode(document.codigo_generacion)}</td>
              <td><StackedCell primary={document.donor_name ?? "—"} secondary={document.donor_email ?? ""} /></td>
              <td className="numeric">${(document.amount_cents / 100).toFixed(2)}</td>
              <td className="mono">{document.sello_recibido ? shortCode(document.sello_recibido) : "—"}</td>
              <td className="numeric">{formatElSalvadorDate(document.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocumentListFooter({
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

function StackedCell({ primary, secondary }: { primary: string; secondary?: string | null }) {
  return (
    <span className="stacked-cell">
      <span>{primary}</span>
      {secondary && <span className="secondary">{secondary}</span>}
    </span>
  );
}

function DetailPanel({
  selected,
  donorDataVerified,
  busy,
  now,
  onAction,
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
  donorDataVerified?: boolean;
  busy: string;
  now: Date;
  onAction: (action: "resend" | "retry" | "invalidate") => void;
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
  const emailEditing = emailEditingId === selected.id;
  const canRetry = isRetryableDocumentStatus(selected.status);
  const LegalIcon = invalidationWindow.tone === "expired" || invalidationWindow.tone === "warning" ? AlertTriangle : CheckCircle2;
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <StatusPill status={selected.status} />
        <strong>{selected.numero_control}</strong>
      </div>
      {donorDataVerified && (
        <div className="donor-verified-badge">
          <ShieldCheck size={16} />
          <span>Datos del donante verificados en el formulario de donación</span>
        </div>
      )}
      <dl>
        <dt>Código de generación</dt>
        <dd className="mono">{selected.codigo_generacion}</dd>
        <dt>Sello</dt>
        <dd className="mono">{selected.sello_recibido ?? "Pendiente"}</dd>
        <dt>Donante</dt>
        <dd>{selected.donor_name ?? "—"}</dd>
        <dt>Correo de envío</dt>
        <dd>
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
        <button disabled={busy === "resend"} title="Reenviar el comprobante al correo del donante" onClick={() => onAction("resend")}><Mail size={16} />Reenviar correo</button>
        <button disabled={!canRetry || busy === "retry"} title={canRetry ? "Reintentar procesamiento" : "Disponible solo para DTE con fallos o contingencia"} onClick={() => onAction("retry")}><RotateCcw size={16} />Reintentar</button>
        <button className="danger" disabled={!invalidationWindow.canInvalidate || busy === "invalidate"} onClick={() => onInvalidateRequest(selected.id)}><AlertTriangle size={16} />Invalidar</button>
        <button disabled={busy === "download-pdf"} onClick={() => onDownload("pdf")}><Download size={16} />PDF</button>
        <button disabled={busy === "download-json"} onClick={() => onDownload("json")}><Download size={16} />JSON</button>
      </div>
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

function InvalidationConfirmDialog({
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

function UserSettingsModal({
  user,
  input,
  busy,
  onChange,
  onClose,
  onSave,
  onResetPassword
}: {
  user: User;
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
	              <option value="VIEWER">{roleLabel("VIEWER")}</option>
	              <option value="OPERATOR">{roleLabel("OPERATOR")}</option>
	              <option value="ADMIN">{roleLabel("ADMIN")}</option>
	              <option value="OWNER">{roleLabel("OWNER")}</option>
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
  busy,
  onChange,
  onSubmit
}: {
  input: CreateUserInput;
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
	          <option value="VIEWER">{roleLabel("VIEWER")}</option>
	          <option value="OPERATOR">{roleLabel("OPERATOR")}</option>
	          <option value="ADMIN">{roleLabel("ADMIN")}</option>
	          <option value="OWNER">{roleLabel("OWNER")}</option>
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

function StatusPill({ status }: { status: string }) {
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

function isRetryableDocumentStatus(status: string): boolean {
  return ["SIGNED", "REJECTED", "FAILED", "CONTINGENCY_PENDING"].includes(status);
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function passwordPolicyMessage(password: string): string {
  const failures = passwordPolicyFailures(password);
  if (failures.length === 0) return "";
  return `La contraseña debe cumplir: ${failures.map((failure) => failure.label).join(", ")}`;
}

async function api<T>(path: string, token: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
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
    throw new ApiError(response.status, userFacingErrorMessage(String(data.message ?? data.error ?? `HTTP ${response.status}`)));
  }
  return data as T;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function countByStatus(documents: DteDocument[]): Record<string, number> {
  return documents.reduce<Record<string, number>>((acc, document) => {
    acc[document.status] = (acc[document.status] ?? 0) + 1;
    return acc;
  }, {});
}

function shortCode(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function can(user: User | null, role: Role): boolean {
  const rank = { VIEWER: 1, OPERATOR: 2, ADMIN: 3, OWNER: 4 };
  return user ? rank[user.role] >= rank[role] : false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIEW_SUBTITLES: Record<View, string> = {
  documents: "Emita, envíe por correo y administre los comprobantes de donación (CDE).",
  failures: "CDE con errores o rechazos que requieren su atención.",
  contingency: "Historial de contingencias (solo lectura): la normativa no contempla contingencia para el CDE.",
  audit: "Historial de todas las acciones realizadas en el panel.",
  users: "Cree cuentas y asigne roles de acceso al panel.",
  credentials: "Credenciales del Ministerio de Hacienda, Wompi y correo.",
  exports: "Exporte los CDE aceptados para el F960 y control interno."
};

export function viewSubtitle(view: View): string {
  return VIEW_SUBTITLES[view];
}

export function documentListEmptyMessage(view: "documents" | "failures", query: string): string {
  if (view === "failures" && query.trim() === "") return "Sin fallos pendientes. Todo en orden.";
  return "No hay CDE que coincidan con la búsqueda o el filtro.";
}

function contingencyTypeLabel(value: number | string): string {
  const option = contingencyTypeOptions.find((item) => item.value === String(value));
  return option?.label ?? `${value}`;
}

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  return formatElSalvadorDateTime(value);
}

function formatMoneyCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function currentMonthStartValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayDateValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthStart(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  }
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
}

function addMonths(value: Date, offset: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + offset, 1));
}

function calendarDays(month: Date): Array<Date | null> {
  const firstDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const totalDays = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const days: Array<Date | null> = Array.from({ length: firstDay.getUTCDay() }, () => null);
  for (let day = 1; day <= totalDays; day += 1) {
    days.push(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day)));
  }
  return days;
}

function formatDateValue(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function monthLabel(value: Date): string {
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

const contingencyTypeOptions = [
  { value: "1", label: "1 - Internet del emisor" },
  { value: "2", label: "2 - Servicios del Ministerio de Hacienda no disponibles" },
  { value: "3", label: "3 - Sistema del emisor" },
  { value: "4", label: "4 - Firmador no disponible" },
  { value: "5", label: "5 - Otro" }
];

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

function issuerFormFromConfigJson(value: string): IssuerConfigFormInput {
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

function issuerConfigJsonFromForm(form: IssuerConfigFormInput): string {
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

interface IssuerConfigFormInput {
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

interface CredentialFormInput {
  environment: "test" | "production";
  mhUser: string;
  mhPassword: string;
  certificateXml: string;
  certificateFileName: string;
  certificatePassword: string;
  emisorConfigJson: string;
  wompiSecret: string;
  emailApiUrl: string;
  emailApiKey: string;
  emailFrom: string;
}

interface F960Preview {
  rows: F960PreviewRow[];
  rowCount: number;
  amountTotal: string;
}

interface AnnualCertificatePreviewDonor {
  donorName: string;
  donorEmail: string | null;
  hasEmail: boolean;
  count: number;
  totalLabel: string;
  hasTestEnvironment: boolean;
}

interface AnnualCertificatePreview {
  year: number;
  donorCount: number;
  withEmail: number;
  withoutEmail: number;
  totalLabel: string;
  donors: AnnualCertificatePreviewDonor[];
}

interface AnnualCertificateSendResult {
  year: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface F960PreviewRow {
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
    emailApiUrl: "",
    emailApiKey: "",
    emailFrom: ""
  };
}
