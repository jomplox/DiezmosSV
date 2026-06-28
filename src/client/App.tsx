import {
  AlertTriangle,
  CheckCircle2,
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
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AuditRow, ContingencyState, CredentialStatus, CredentialStatusItem, DteDocument, EmailTemplateSettings, EmailTemplateValue, EmissionEnvironmentState, User } from "./types";
import { openNativeDatePicker } from "./datePicker";
import { auditActionLabel, auditSummaryLabel, catalogOptionLabel, entityLabel, environmentLabel, roleLabel, statusLabel, userFacingErrorMessage } from "./displayText";
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

type Role = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";
type View = "documents" | "failures" | "contingency" | "audit" | "users" | "exports" | "credentials";

const navItems: Array<{ id: View; label: string; icon: typeof FileText; minRole?: Role }> = [
  { id: "documents", label: "Documentos", icon: FileText },
  { id: "failures", label: "Fallos", icon: AlertTriangle },
  { id: "contingency", label: "Contingencia", icon: Clock },
  { id: "audit", label: "Auditoría", icon: History },
  { id: "users", label: "Usuarios", icon: Users },
  { id: "exports", label: "Exportar", icon: FileSpreadsheet, minRole: "ADMIN" },
  { id: "credentials", label: "Credenciales", icon: Settings, minRole: "OWNER" }
];

export function App() {
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
  const [contingency, setContingency] = useState<ContingencyState | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("diezmos_sidebar_collapsed") === "true");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [toast, setToast] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [pendingInvalidationId, setPendingInvalidationId] = useState<string | null>(null);
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
  const [testInput, setTestInput] = useState<TestDteInput>({
    amount: "",
    donorName: "",
    donorEmail: "",
    donorDocument: "",
    donorPhone: ""
  });
  const [newUser, setNewUser] = useState<CreateUserInput>({
    name: "",
    email: "",
    role: "VIEWER",
    password: ""
  });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettingsInput>(emptyUserSettings());
  const [credentialInput, setCredentialInput] = useState<CredentialFormInput>(emptyCredentialInput("test"));
  const [contingencyInput, setContingencyInput] = useState<ContingencyOpenInput>({
    environment: "00",
    tipoContingencia: "2",
    reason: "MH no disponible"
  });

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
    if (!token) {
      return;
    }
    void refresh().catch(handleApiFailure);
  }, [token, filteredStatus, query, view, exportStartDate, exportEndDate]);

  async function refresh() {
    const params = new URLSearchParams();
    if (filteredStatus) params.set("status", filteredStatus);
    if (query) params.set("q", query);
    const docs = await api<{ documents: DteDocument[] }>(`/api/documents?${params}`, token);
    setDocuments(docs.documents);
    if (!selectedId && docs.documents[0]) setSelectedId(docs.documents[0].id);
    const contingencyResult = await api<{ contingency: ContingencyState }>("/api/contingency", token);
    setContingency(contingencyResult.contingency);
    if (view === "audit") {
      setAudit((await api<{ audit: AuditRow[] }>("/api/audit", token)).audit);
    }
    if (view === "users" && can(user, "ADMIN")) {
      setUsers((await api<{ users: User[] }>("/api/users", token)).users);
    }
    if (view === "credentials" && can(user, "OWNER")) {
      const [credentialResult, environmentResult, emailTemplateResult] = await Promise.all([
        api<{ credentials: CredentialStatus }>("/api/credentials", token),
        api<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment", token),
        api<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates", token)
      ]);
      setCredentials(credentialResult.credentials);
      setEmissionEnvironment(environmentResult.emissionEnvironment);
      applyEmailTemplates(emailTemplateResult.emailTemplates);
    }
    if (view === "exports" && can(user, "ADMIN")) {
      if (exportStartDate && exportEndDate && exportStartDate > exportEndDate) {
        setExportPreview({ rows: [], rowCount: 0, amountTotal: "0.00" });
        setToast("Revise el rango de fechas");
        return;
      }
      const params = exportParams(exportStartDate, exportEndDate);
      setExportPreview(await api<F960Preview>(`/api/exports/f960?${params}`, token));
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
    const amountError = testAmountValidationMessage(testInput.amount);
    if (amountError) {
      setToast(amountError);
      return;
    }
    if (!testInput.donorDocument.trim()) {
      setToast("Ingrese documento del donante para la prueba");
      return;
    }
    const donorDuiError = duiValidationMessage(testInput.donorDocument);
    if (donorDuiError) {
      setToast(donorDuiError);
      return;
    }
    await runAction("test-dte", async () => {
      await api("/api/test/dte", token, { method: "POST", body: testInput });
      setToast("DTE de prueba enviado a cola");
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
      setToast("DTE avanzado enviado a cola");
      setAdvancedDteOpen(false);
      await delay(2500);
      await refresh();
    });
  }

  async function documentAction(action: "resend" | "retry" | "invalidate", target = selected) {
    if (!target) return;
    const body =
      action === "invalidate"
        ? { tipoAnulacion: 2, motivoAnulacion: "Invalidación solicitada desde panel" }
        : {};
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

  async function openContingency() {
    const reason = contingencyInput.reason.trim();
    if (!reason) {
      setToast("Ingrese motivo de contingencia");
      return;
    }
    await runAction("contingency-open", async () => {
      const result = await api<{ contingency: ContingencyState }>("/api/contingency/open", token, {
        method: "POST",
        body: {
          environment: contingencyInput.environment,
          tipoContingencia: Number(contingencyInput.tipoContingencia),
          reason
        }
      });
      setContingency(result.contingency);
      setToast(result.contingency.active ? "Contingencia abierta" : "Contingencia actualizada");
      await refresh();
    });
  }

  async function runContingencySweep() {
    await runAction("contingency-sweep", async () => {
      const result = await api<{ transmitted: number; periodId: string | null }>("/api/contingency/sweep", token, { method: "POST" });
      setToast(result.periodId ? `Barrido ejecutado: ${result.transmitted} DTE aceptado(s)` : "Sin contingencia abierta");
      await refresh();
    });
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
    return <AuthScreen notice={authNotice} onLogin={login} onBootstrap={bootstrap} />;
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
              <span>DTE CDE</span>
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
            <p>{subtitleFor(view)}</p>
          </div>
          <div className="topbar-actions">
            <div className={contingency?.active ? "contingency-banner open" : "contingency-banner"}>
              <Clock size={16} />
              {contingency?.active ? `Contingencia ${statusLabel(contingency.active.status).toLowerCase()}` : "Sin contingencia abierta"}
            </div>
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
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar código, donante o correo" />
                </label>
                <select value={status} onChange={(event) => setStatus(event.target.value)} disabled={view === "failures"}>
                  <option value="">Todos</option>
                  <option value="ACCEPTED">Aceptados</option>
                  <option value="CONTINGENCY_PENDING">Contingencia</option>
                  <option value="REJECTED">Rechazados</option>
                  <option value="FAILED">Fallidos</option>
                  <option value="INVALIDATED">Invalidados</option>
                </select>
                <button className="icon-button" onClick={() => void refresh()} title="Actualizar">
                  <RefreshCw size={17} />
                </button>
              </div>
              <Stats documents={documents} />
              <DocumentTable documents={documents} selectedId={selected?.id} onSelect={setSelectedId} />
            </div>
              <DetailPanel
                selected={selected}
                busy={busy}
                now={now}
                onAction={documentAction}
                onInvalidateRequest={setPendingInvalidationId}
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
            input={contingencyInput}
            busy={busy}
            canManage={can(user, "ADMIN")}
            onInputChange={setContingencyInput}
            onOpen={openContingency}
            onSweep={runContingencySweep}
            onRefresh={refreshContingency}
          />
        )}

        {view === "audit" && (
          <section className="single-panel">
            <div className="toolbar end">
              <button onClick={() => void refresh()}>
                <RefreshCw size={16} />
                Actualizar
              </button>
            </div>
            <AuditTable rows={audit} />
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
          <ExportPanel
            startDate={exportStartDate}
            endDate={exportEndDate}
            preview={exportPreview}
            busy={busy}
            onStartDateChange={setExportStartDate}
            onEndDateChange={setExportEndDate}
            onDownload={downloadF960}
          />
        )}

        {view === "credentials" && (
          <CredentialsPanel
            status={credentials}
            emissionEnvironment={emissionEnvironment}
            emailTemplates={emailTemplates}
            emailTemplateDraft={emailTemplateDraft}
            input={credentialInput}
            busy={busy === "credentials"}
            emissionBusy={busy === "emission-environment"}
            templateBusy={busy === "email-templates"}
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
            onBootstrapWriter={bootstrapCredentialWriter}
            onRefresh={async () => {
              const [credentialResult, environmentResult, emailTemplateResult] = await Promise.all([
                api<{ credentials: CredentialStatus }>("/api/credentials", token),
                api<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment", token),
                api<{ emailTemplates: EmailTemplateSettings }>("/api/settings/email-templates", token)
              ]);
              setCredentials(credentialResult.credentials);
              setEmissionEnvironment(environmentResult.emissionEnvironment);
              applyEmailTemplates(emailTemplateResult.emailTemplates);
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
          onCancel={() => setPendingInvalidationId(null)}
          onConfirm={() => void documentAction("invalidate", pendingInvalidation)}
        />
      )}
      {toast && <button className="toast" onClick={() => setToast("")}>{toast}</button>}
    </div>
  );
}

function ContingencyPanel({
  state,
  input,
  busy,
  canManage,
  onInputChange,
  onOpen,
  onSweep,
  onRefresh
}: {
  state: ContingencyState | null;
  input: ContingencyOpenInput;
  busy: string;
  canManage: boolean;
  onInputChange: (input: ContingencyOpenInput) => void;
  onOpen: () => Promise<void>;
  onSweep: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const active = state?.active ?? null;
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
  const deadline = contingencyDeadline(active);

  return (
    <section className="contingency-dashboard">
      <div className="contingency-grid">
        <div className="contingency-panel">
          <div className="panel-head">
            <div>
              <h2>Estado actual</h2>
              <p>{active ? active.reason : "No hay periodo abierto."}</p>
            </div>
            <StatusPill status={active?.status ?? "CLOSED"} />
          </div>
          <dl className="contingency-facts">
            <dt>Ambiente</dt>
            <dd>{active ? environmentLabel(active.environment) : "N/D"}</dd>
            <dt>Tipo</dt>
            <dd>{active ? contingencyTypeLabel(active.tipo_contingencia) : "N/D"}</dd>
            <dt>Inicio</dt>
            <dd>{formatDateTime(active?.started_at)}</dd>
            <dt>Cierre</dt>
            <dd>{formatDateTime(active?.ended_at)}</dd>
            <dt>Sello evento</dt>
            <dd className="mono">{active?.event_sello ? shortCode(active.event_sello) : "Pendiente"}</dd>
          </dl>
          <div className={`contingency-deadline ${deadline.tone}`}>
            <Clock size={18} />
            <div>
              <strong>{deadline.title}</strong>
              <span>{deadline.detail}</span>
            </div>
          </div>
        </div>

        <form
          className="contingency-panel contingency-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onOpen();
          }}
        >
          <div className="panel-head">
            <div>
              <h2>Apertura manual</h2>
              <p>{canManage ? "Tipo y motivo exigidos antes de emitir en contingencia." : "Requiere rol Administrador o Propietario."}</p>
            </div>
            <Cloud size={20} />
          </div>
          <div className="contingency-form-grid">
            <label>
              <span>Ambiente</span>
              <select
                value={input.environment}
                disabled={!canManage || Boolean(active)}
                onChange={(event) => onInputChange({ ...input, environment: event.target.value as "00" | "01" })}
              >
                <option value="00">Pruebas</option>
                <option value="01">Producción</option>
              </select>
            </label>
            <label>
              <span>Tipo</span>
              <select
                value={input.tipoContingencia}
                disabled={!canManage || Boolean(active)}
                onChange={(event) => onInputChange({ ...input, tipoContingencia: event.target.value })}
              >
                {contingencyTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="span-2">
              <span>Motivo</span>
              <textarea
                value={input.reason}
                disabled={!canManage || Boolean(active)}
                onChange={(event) => onInputChange({ ...input, reason: event.target.value })}
              />
            </label>
          </div>
          <div className="contingency-actions">
            <button type="button" onClick={() => void onRefresh()} disabled={busy === "contingency-refresh"}>
              <RefreshCw size={16} />
              Actualizar
            </button>
            <button type="button" onClick={() => void onSweep()} disabled={!active || busy === "contingency-sweep"}>
              <RefreshCw size={16} />
              Ejecutar barrido
            </button>
            <button className="primary" type="submit" disabled={!canManage || Boolean(active) || busy === "contingency-open"}>
              <CheckCircle2 size={16} />
              Abrir contingencia
            </button>
          </div>
        </form>
      </div>

      <div className="stats contingency-stats">
        <Metric label="Pendientes" value={summary.pending} tone="warn" />
        <Metric label="Lotes MH" value={summary.batches} tone="neutral" />
        <Metric label="CDE aceptados" value={summary.batchAccepted} tone="ok" />
        <Metric label="CDE en lote" value={summary.batchPending} tone="warn" />
        <Metric label="CDE rechazados" value={summary.batchRejected} tone="bad" />
      </div>

      <section className="contingency-panel">
        <div className="panel-head">
          <div>
            <h2>DTE pendientes</h2>
            <p>Documentos locales emitidos para reenvío después del evento.</p>
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
                  <th>Monto</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {pendingDocuments.map((document) => (
                  <tr key={document.id}>
                    <td><StatusPill status={document.status} /></td>
                    <td className="mono">{shortCode(document.codigo_generacion)}</td>
                    <td><StackedCell primary={document.donor_name ?? "N/D"} secondary={document.donor_email ?? ""} /></td>
                    <td className="numeric">{formatMoneyCents(document.amount_cents)}</td>
                    <td className="numeric">{formatDateTime(document.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<CheckCircle2 size={18} />} text="No hay DTE pendientes de contingencia." />
        )}
      </section>

      <section className="contingency-panel">
        <div className="panel-head">
          <div>
            <h2>Lotes MH</h2>
            <p>Envío por /recepcionlote y consulta por código de lote.</p>
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
              <h2>Eventos MH</h2>
              <p>Transmisiones reales a /contingencia.</p>
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
            <p>Acciones registradas para la contingencia activa.</p>
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
            <th>Monto</th>
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
              <td className="mono">{row.nit || row.dui || "N/D"}</td>
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

function CredentialsPanel({
  status,
  emissionEnvironment,
  emailTemplates,
  emailTemplateDraft,
  input,
  busy,
  emissionBusy,
  templateBusy,
  writerBusy,
  onChange,
  onSubmit,
  onEmailTemplateChange,
  onEmailTemplateSubmit,
  onEmissionEnvironmentChange,
  onBootstrapWriter,
  onRefresh
}: {
  status: CredentialStatus | null;
  emissionEnvironment: EmissionEnvironmentState | null;
  emailTemplates: EmailTemplateSettings | null;
  emailTemplateDraft: Record<string, EmailTemplateValue>;
  input: CredentialFormInput;
  busy: boolean;
  emissionBusy: boolean;
  templateBusy: boolean;
  writerBusy: boolean;
  onChange: (input: CredentialFormInput) => void;
  onSubmit: () => Promise<void>;
  onEmailTemplateChange: (type: string, patch: Partial<EmailTemplateValue>) => void;
  onEmailTemplateSubmit: () => Promise<void>;
  onEmissionEnvironmentChange: (environment: EmissionEnvironmentState["environment"]) => Promise<void>;
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
  const [certificateFileError, setCertificateFileError] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [writerCommandCopied, setWriterCommandCopied] = useState(false);
  const [writerToken, setWriterToken] = useState("");
  const [writerTokenError, setWriterTokenError] = useState("");
  const writerSetupCommand = `wrangler secret put CLOUDFLARE_API_TOKEN --env ${status?.target.appEnv || "staging"}`;
  const writerMessage = writerConfigured
    ? "Guardado seguro de credenciales habilitado"
    : writerMissing.length > 0
      ? `No se pueden guardar cambios todavía. Falta ${credentialWriterMissingLabel(writerMissing)}.`
      : "No se pueden guardar cambios todavía.";
  const activeEnvironmentLabel = input.environment === "test" ? "Pruebas 00" : "Producción 01";
  const runtimeEnvironment = credentialRuntimeEnvironment(emissionEnvironment, status?.target.appEnv);
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
        setCertificateFileError("El archivo no parece ser el certificado .crt/.xml de MH para firma.");
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
  return (
    <section className="credential-layout">
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
              <h3>Habilitar edición desde UI</h3>
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

      <div className="credential-main-panel">
        <form
          className="credential-form-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
        <div className="panel-head">
          <div>
            <h2>Actualizar secretos</h2>
            <p>Los valores activos se muestran cuando no son secretos; los protegidos solo se reemplazan.</p>
          </div>
          <Lock size={20} />
        </div>
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
              onClick={() => void onEmissionEnvironmentChange("00")}
            >
              Pruebas 00
            </button>
            <button
              type="button"
              className={runtimeEnvironment.environment === "01" ? "active" : ""}
              disabled={emissionBusy}
              onClick={() => void onEmissionEnvironmentChange("01")}
            >
              Producción 01
            </button>
          </div>
          <small>Este cambio afecta únicamente los DTE nuevos. Los documentos ya emitidos conservan su ambiente original.</small>
        </div>
        <div className="credential-env-heading">
          <span>Usuario y contraseña MH a editar</span>
          <small>Este selector no cambia el ambiente activo; solo escoge cuál par de credenciales MH desea revisar o rotar.</small>
        </div>
        <div className="segmented credential-env">
          <button type="button" className={input.environment === "test" ? "active" : ""} onClick={() => onChange({ ...input, environment: "test" })}>Pruebas 00</button>
          <button type="button" className={input.environment === "production" ? "active" : ""} onClick={() => onChange({ ...input, environment: "production" })}>Producción 01</button>
        </div>
        <div className={activeMhGroup?.ready ? "credential-form-state ready" : "credential-form-state"}>
          {activeMhGroup?.ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{activeEnvironmentLabel}: {activeMhGroup?.ready ? "credenciales API MH configuradas" : "credenciales API MH pendientes"}</span>
        </div>
        <div className="credential-fields">
          <div className="credential-section-title span-2">
            <h3>Credenciales API MH ({activeEnvironmentLabel})</h3>
            <p>Estos dos campos son los únicos que cambian con el selector de ambiente.</p>
          </div>
          <label>
            <CredentialFieldLabel label="Usuario MH API" configured={credentialConfigured(status, mhUserSecret)} />
            <CredentialActiveValue status={status} name={mhUserSecret} />
            <input value={input.mhUser} onChange={(event) => onChange({ ...input, mhUser: event.target.value })} placeholder={credentialReplacementPlaceholder(status, mhUserSecret, "Nuevo usuario MH API")} autoComplete="off" />
          </label>
          <label>
            <CredentialFieldLabel label="Contraseña MH API" configured={credentialConfigured(status, mhPasswordSecret)} />
            <CredentialActiveValue status={status} name={mhPasswordSecret} />
            <input value={input.mhPassword} onChange={(event) => onChange({ ...input, mhPassword: event.target.value })} placeholder={credentialReplacementPlaceholder(status, mhPasswordSecret, "Nueva contraseña MH API")} type="password" autoComplete="new-password" />
          </label>
          <div className="credential-section-title span-2">
            <h3>Firmador MH</h3>
            <p>Certificado y contraseña usados para firmar los DTE antes de transmitirlos.</p>
          </div>
          <div className="credential-field-block span-2">
            <CredentialFieldLabel label="Certificado firmador MH (.crt/.xml)" configured={signerConfigured} />
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
            <textarea value={input.certificateXml} onChange={(event) => onChange({ ...input, certificateXml: event.target.value, certificateFileName: "" })} placeholder={credentialReplacementPlaceholder(status, "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2", "Pegue aquí el nuevo certificado .crt/.xml de MH o cargue el archivo")} spellCheck={false} />
            <small>Este campo es para reemplazar el certificado que MH entrega para firmar DTE. No se muestra el certificado activo porque contiene material privado de firma.</small>
            {certificateFileError && <small className="field-error">{certificateFileError}</small>}
          </div>
          <label>
            <CredentialFieldLabel label="Contraseña de llave privada" configured={credentialConfigured(status, "MH_CERT_PASSWORD")} />
            <CredentialActiveValue status={status} name="MH_CERT_PASSWORD" />
            <input value={input.certificatePassword} onChange={(event) => onChange({ ...input, certificatePassword: event.target.value })} placeholder={credentialReplacementPlaceholder(status, "MH_CERT_PASSWORD", "Nueva contraseña de llave privada")} type="password" autoComplete="new-password" />
          </label>
          <div className="credential-section-title span-2">
            <h3>Wompi</h3>
            <p>Configuración del webhook que Wompi invoca cuando aprueba un pago.</p>
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
            <small>Wompi debe hacer POST aquí cuando aprueba un pago; este Worker valida la firma con el secreto anterior.</small>
          </div>
          <div className="credential-section-title span-2">
            <h3>Emisor</h3>
            <p>Datos fiscales y valores por defecto usados para construir cada CDE.</p>
          </div>
          <IssuerConfigEditor status={status} input={input} onChange={onChange} />
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
            <small>Recibe from, to, subject, text y adjuntos PDF/JSON en base64.</small>
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
        </div>
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
        </form>
        <EmailTemplateEditor
          settings={emailTemplates}
          draft={emailTemplateDraft}
          busy={templateBusy}
          onChange={onEmailTemplateChange}
          onSubmit={onEmailTemplateSubmit}
        />
      </div>
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
          <p>Información legal del emisor ante MH.</p>
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
          <span>Código establecimiento MH</span>
          <input value={form.codEstableMH} onChange={(event) => update({ codEstableMH: event.target.value })} placeholder="M001" />
        </label>
        <label>
          <span>Código punto venta MH</span>
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
      ? `Los próximos CDE se emitirán contra MH ${label}. Cambie este valor antes de generar o recibir pagos si necesita otro ambiente.`
      : `Usando ${label} como valor inicial. Guarde una selección aquí para controlar el ambiente activo desde la UI.`
  };
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
        <h2>DTE Rápido</h2>
        <p>Crea un CDE con los datos básicos de la donación.</p>
      </div>
      <div className="test-grid">
        <input value={input.amount} onChange={(event) => onChange({ ...input, amount: event.target.value })} placeholder="Monto" inputMode="decimal" />
        <input value={input.donorName} onChange={(event) => onChange({ ...input, donorName: event.target.value })} placeholder="Donante" />
        <input value={input.donorDocument} onChange={(event) => onChange({ ...input, donorDocument: event.target.value })} placeholder="Documento" />
        <input value={input.donorEmail} onChange={(event) => onChange({ ...input, donorEmail: event.target.value })} placeholder="Correo" type="email" />
        <input value={input.donorPhone} onChange={(event) => onChange({ ...input, donorPhone: event.target.value })} placeholder="Teléfono" />
        <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
          <FlaskConical size={16} />
          {busy ? "Generando" : "Generar"}
        </button>
        <button disabled={advancedBusy} onClick={() => void onAdvanced()}>
          <Braces size={16} />
          {advancedBusy ? "Preparando" : "DTE avanzado"}
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
  return (
    <div className="modal-backdrop">
      <section className="advanced-dte-modal" role="dialog" aria-modal="true" aria-labelledby="advanced-dte-title">
        <header>
          <div>
            <h2 id="advanced-dte-title">Crear CDE avanzado</h2>
            <p>CDE v2 en ambiente 00 con datos editables antes de transmitir.</p>
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
                <AdvancedField label="País dirección">
                  <CatalogSelect value={form.codPais} options={CAT020_COUNTRIES} onChange={(codPais) => update({ codPais })} />
                </AdvancedField>
                <AdvancedField label="Complemento / dirección completa" span>
                  <textarea value={form.direccionComplemento} onChange={(event) => update({ direccionComplemento: event.target.value })} rows={4} />
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
                  <textarea value={form.descripcion} onChange={(event) => update({ descripcion: event.target.value })} rows={3} />
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
                <AdvancedField label="Apéndice campo">
                  <input value={form.apendiceCampo} onChange={(event) => update({ apendiceCampo: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Apéndice etiqueta">
                  <input value={form.apendiceEtiqueta} onChange={(event) => update({ apendiceEtiqueta: event.target.value })} />
                </AdvancedField>
                <AdvancedField label="Apéndice valor" span>
                  <input value={form.apendiceValor} onChange={(event) => update({ apendiceValor: event.target.value })} />
                </AdvancedField>
              </div>
            )}
            {active.id === "revision" && (
              <div className="advanced-review">
                <dl>
                  <div><dt>Donante</dt><dd>{form.donorName || "N/D"}</dd></div>
                  <div><dt>Documento</dt><dd>{form.donorDocument || "N/D"}</dd></div>
                  <div><dt>Correo</dt><dd>{form.donorEmail || "N/D"}</dd></div>
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
            <button disabled={busy || activeStep === advancedCdeSteps.length - 1} onClick={() => onStepChange(activeStep + 1)}>
              Siguiente
              <ChevronRight size={16} />
            </button>
          </div>
          <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
            <FlaskConical size={16} />
            {busy ? "Generando" : "Generar avanzado"}
          </button>
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
  placeholder
}: {
  value: string;
  options: readonly CatalogOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const selectedValue = catalogSelectValue(options, value);
  return (
    <select value={selectedValue} onChange={(event) => onChange(event.target.value)}>
      {(placeholder || !selectedValue) && <option value="">{placeholder ?? "Seleccione"}</option>}
      {options.map((option) => (
        <option key={`${option.code}-${option.label}`} value={option.code}>
          {option.code} - {catalogOptionLabel(option.label)}
        </option>
      ))}
    </select>
  );
}

function catalogSelectValue(options: readonly CatalogOption[], value: unknown): string {
  const code = normalizeCatalogCode(value);
  return options.some((option) => option.code === code) ? code : "";
}

function AuthScreen({ notice, onLogin, onBootstrap }: { notice?: string; onLogin: (email: string, password: string) => Promise<void>; onBootstrap: (email: string, name: string, password: string, setupToken: string) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            if (mode === "bootstrap") await onBootstrap(email, name, password, setupToken);
            else await onLogin(email, password);
          } catch (err) {
            setError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
          }
        }}
      >
        <ShieldCheck size={32} />
        <h1>ExamplePerson1</h1>
        <div className="segmented">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Ingresar</button>
          <button type="button" className={mode === "bootstrap" ? "active" : ""} onClick={() => setMode("bootstrap")}>Crear propietario</button>
        </div>
        {mode === "bootstrap" && <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nombre" />}
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Correo" type="email" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Contraseña" type="password" />
        {mode === "bootstrap" && <input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} placeholder="Token de configuración" type="password" />}
        {notice && !error && <p className="auth-notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          <KeyRound size={16} />
          Continuar
        </button>
      </form>
    </div>
  );
}

function Stats({ documents }: { documents: DteDocument[] }) {
  const counts = countByStatus(documents);
  return (
    <div className="stats">
      <Metric label="Aceptados" value={counts.ACCEPTED ?? 0} tone="ok" />
      <Metric label="Fallidos" value={(counts.FAILED ?? 0) + (counts.REJECTED ?? 0)} tone="bad" />
      <Metric label="Contingencia" value={counts.CONTINGENCY_PENDING ?? 0} tone="warn" />
      <Metric label="Invalidados" value={counts.INVALIDATED ?? 0} tone="neutral" />
    </div>
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
            <th>Monto</th>
            <th>Sello</th>
            <th>Fecha</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id} className={selectedId === document.id ? "selected" : ""} onClick={() => onSelect(document.id)}>
              <td><StatusPill status={document.status} /></td>
              <td className="mono">{shortCode(document.codigo_generacion)}</td>
              <td><StackedCell primary={document.donor_name ?? "N/D"} secondary={document.donor_email ?? ""} /></td>
              <td className="numeric">${(document.amount_cents / 100).toFixed(2)}</td>
              <td className="mono">{document.sello_recibido ? shortCode(document.sello_recibido) : "N/D"}</td>
              <td className="numeric">{new Date(document.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
    return <aside className="detail-panel empty">Sin documentos.</aside>;
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
      <dl>
        <dt>Código de generación</dt>
        <dd className="mono">{selected.codigo_generacion}</dd>
        <dt>Sello</dt>
        <dd className="mono">{selected.sello_recibido ?? "Pendiente"}</dd>
        <dt>Donante</dt>
        <dd>{selected.donor_name ?? "N/D"}</dd>
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
              <span>{selected.donor_email ?? "N/D"}</span>
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
          <strong>Ventana de invalidación CDE</strong>
          <span>{invalidationWindow.remainingLabel}</span>
          {invalidationWindow.deadlineLabel && <small>Límite: {invalidationWindow.deadlineLabel} hora El Salvador</small>}
        </div>
      </div>
      <div className="actions">
        <button disabled={busy === "resend"} onClick={() => onAction("resend")}><Mail size={16} />Reenviar</button>
        <button disabled={!canRetry || busy === "retry"} title={canRetry ? "Reintentar procesamiento" : "Disponible solo para DTE con fallos o contingencia"} onClick={() => onAction("retry")}><RotateCcw size={16} />Reintentar</button>
        <button className="danger" disabled={!invalidationWindow.canInvalidate || busy === "invalidate"} onClick={() => onInvalidateRequest(selected.id)}><AlertTriangle size={16} />Invalidar</button>
        <button disabled={busy === "download-pdf"} onClick={() => onDownload("pdf")}><Download size={16} />PDF</button>
        <button disabled={busy === "download-json"} onClick={() => onDownload("json")}><Download size={16} />JSON</button>
      </div>
      <div className="json-preview-head">
        <strong>JSON DTE</strong>
        <span>Vista completa del documento emitido.</span>
      </div>
      <pre>{JSON.stringify(plain, null, 2)}</pre>
    </aside>
  );
}

function InvalidationConfirmDialog({
  document,
  busy,
  now,
  onCancel,
  onConfirm
}: {
  document: DteDocument;
  busy: boolean;
  now: Date;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const windowInfo = invalidationWindowInfo(document, now);
  return (
    <div className="modal-backdrop">
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="invalidation-confirm-title">
        <header>
          <div>
            <h2 id="invalidation-confirm-title">Confirmar invalidación</h2>
            <p>Esta acción transmite un evento de invalidación al MH y no se puede deshacer desde el panel.</p>
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
          <dd>{document.donor_name ?? "N/D"}</dd>
        </dl>
        <footer>
          <button onClick={onCancel} disabled={busy}>Cancelar</button>
          <button className="danger solid" onClick={onConfirm} disabled={busy || !windowInfo.canInvalidate}>
            <AlertTriangle size={16} />
            {busy ? "Invalidando" : "Confirmar invalidación"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Acción</th><th>Entidad</th><th>Resumen</th><th>Fecha</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}><td>{auditActionLabel(row.action)}</td><td>{entityLabel(row.entity_type)}</td><td>{auditSummaryLabel(row.summary)}</td><td className="numeric">{new Date(row.created_at).toLocaleString()}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
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
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="user-settings-title">
      <section className="confirm-modal user-settings-modal">
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
            <span>Cuenta inactiva</span>
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
	        <span><b>{roleLabel("ADMIN")}</b>: administra usuarios, exportaciones y apertura de contingencia.</span>
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
      <input value={input.name} onChange={(event) => onChange({ ...input, name: event.target.value })} placeholder="Nombre" />
      <input value={input.email} onChange={(event) => onChange({ ...input, email: event.target.value })} placeholder="Correo" type="email" />
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
      return `Invalidación aceptada por MH${result.result?.estado ? `: ${result.result.estado}` : ""}. Aviso enviado por correo`;
    }
    if (result.emailError) {
      return `Invalidación aceptada por MH; falló el correo: ${result.emailError}`;
    }
    return `Invalidación aceptada por MH${result.result?.estado ? `: ${result.result.estado}` : ""}. Sin correo de envío`;
  }
  return "Invalidación enviada a MH";
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

function subtitleFor(view: View): string {
  if (view === "documents") return "Emisión, sello, correo y acciones legales por CDE.";
  if (view === "contingency") return "Eventos, pendientes, plazos y trazabilidad.";
  if (view === "credentials") return "Secretos MH, Wompi y correo para el Worker actual.";
  if (view === "exports") return "Archivos CSV para declaración y control.";
  return "Operaciones administrativas y trazabilidad.";
}

function contingencyTypeLabel(value: number | string): string {
  const option = contingencyTypeOptions.find((item) => item.value === String(value));
  return option?.label ?? `${value}`;
}

function contingencyDeadline(active: ContingencyState["active"]): { title: string; detail: string; tone: "idle" | "warn" | "ok" | "bad" } {
  if (!active) {
    return {
      title: "Sin ventana activa",
      detail: "No hay DTE pendientes bajo contingencia.",
      tone: "idle"
    };
  }
  if (active.status === "FAILED") {
    return {
      title: "Requiere revisión",
      detail: "El periodo está marcado como fallido.",
      tone: "bad"
    };
  }
  if (active.event_sello && active.transmit_deadline_at) {
    return {
      title: "Evento sellado por MH",
      detail: `Reenvío DTE hasta ${formatDateTime(active.transmit_deadline_at)} hora El Salvador.`,
      tone: "ok"
    };
  }
  if (active.event_deadline_at) {
    return {
      title: "Evento pendiente de sello",
      detail: `Evento vence ${formatDateTime(active.event_deadline_at)} hora El Salvador.`,
      tone: "warn"
    };
  }
  return {
    title: "Contingencia abierta",
    detail: "Sin vencimiento final hasta cierre operativo del periodo.",
    tone: "warn"
  };
}

function formatDateTime(value?: string | null): string {
  if (!value) return "N/D";
  return new Intl.DateTimeFormat("es-SV", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/El_Salvador"
  }).format(new Date(value));
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
  { value: "2", label: "2 - Servicios MH no disponibles" },
  { value: "3", label: "3 - Sistema del emisor" },
  { value: "4", label: "4 - Firmador no disponible" },
  { value: "5", label: "5 - Otro" }
];

interface ContingencyOpenInput {
  environment: "00" | "01";
  tipoContingencia: string;
  reason: string;
}

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
    donorName: "Donante de Prueba",
    donorTipoDocumento: "13",
    donorDocument: "SIN-DOCUMENTO",
    donorNrc: "",
    donorCodActividad: "",
    donorDescActividad: "",
    donorEmail: "donante@example.org",
    donorPhone: "00000000",
    codDomiciliado: "1",
    codPais: "SV",
    departamento: "06",
    municipio: "22",
    distrito: "01",
    direccionComplemento: "Dirección de prueba",
    tipoDonacion: "1",
    cantidad: "1",
    codigo: "DONACION",
    uniMedida: "59",
    descripcion: "Donación de prueba",
    tipoDepreciacion: "0",
    valorUni: "1.00",
    valorTotal: "1.00",
    totalLetras: "",
    pagoCodigo: "01",
    pagoReferencia: "STAGING",
    documentoCodigo: "1",
    documentoDesc: "Referencia Wompi",
    documentoDetalle: "DTE avanzado",
    apendiceCampo: "Aplicativo",
    apendiceEtiqueta: "Aplicativo",
    apendiceValor: "DiezmosSV Staging"
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
    numDocumento: cleanText(form.donorDocument) || "SIN-DOCUMENTO",
    nrc: nullableText(form.donorNrc),
    nombre: cleanText(form.donorName) || "Donante de Prueba",
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
      descripcion: cleanText(form.descripcion) || "Donación de prueba",
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
        referencia: cleanText(form.pagoReferencia) || "STAGING"
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

function validateAdvancedCdeForm(form: AdvancedCdeFormInput): string | null {
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

function testAmountValidationMessage(value: string): string {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? "" : "Ingrese monto mayor que cero";
}

interface TestDteInput {
  amount: string;
  donorName: string;
  donorEmail: string;
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
