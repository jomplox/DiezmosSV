import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Clock,
  Download,
  EyeOff,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  History,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  Settings,
  UserPlus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Users
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuditRow, CredentialStatus, DteDocument, User } from "./types";
import { openNativeDatePicker } from "./datePicker";

type Role = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";
type View = "documents" | "failures" | "contingency" | "audit" | "users" | "exports" | "credentials";

const navItems: Array<{ id: View; label: string; icon: typeof FileText; minRole?: Role }> = [
  { id: "documents", label: "Documentos", icon: FileText },
  { id: "failures", label: "Fallos", icon: AlertTriangle },
  { id: "contingency", label: "Contingencia", icon: Clock },
  { id: "audit", label: "Auditoria", icon: History },
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
  const [contingency, setContingency] = useState<Record<string, unknown> | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState("");
  const [exportStartDate, setExportStartDate] = useState(currentMonthStartValue);
  const [exportEndDate, setExportEndDate] = useState(todayDateValue);
  const [exportPreview, setExportPreview] = useState<F960Preview>({
    rows: [],
    rowCount: 0,
    amountTotal: "0.00"
  });
  const [testInput, setTestInput] = useState<TestDteInput>({
    amount: "1.00",
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
  const [credentialInput, setCredentialInput] = useState<CredentialFormInput>(emptyCredentialInput("test"));

  const selected = useMemo(() => documents.find((document) => document.id === selectedId) ?? documents[0], [documents, selectedId]);
  const filteredStatus = view === "failures" ? "FAILED" : status;
  const visibleNavItems = navItems.filter((item) => !item.minRole || can(user, item.minRole));

  useEffect(() => {
    if (!token) {
      return;
    }
    void refresh();
  }, [token, filteredStatus, query, view, exportStartDate, exportEndDate]);

  async function refresh() {
    const params = new URLSearchParams();
    if (filteredStatus) params.set("status", filteredStatus);
    if (query) params.set("q", query);
    const docs = await api<{ documents: DteDocument[] }>(`/api/documents?${params}`, token);
    setDocuments(docs.documents);
    if (!selectedId && docs.documents[0]) setSelectedId(docs.documents[0].id);
    const contingencyResult = await api<{ contingency: Record<string, unknown> | null }>("/api/contingency", token);
    setContingency(contingencyResult.contingency);
    if (view === "audit") {
      setAudit((await api<{ audit: AuditRow[] }>("/api/audit", token)).audit);
    }
    if (view === "users" && can(user, "ADMIN")) {
      setUsers((await api<{ users: User[] }>("/api/users", token)).users);
    }
    if (view === "credentials" && can(user, "OWNER")) {
      setCredentials((await api<{ credentials: CredentialStatus }>("/api/credentials", token)).credentials);
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
    setDocuments([]);
    setSelectedId(null);
  }

  async function createTestDte() {
    if (!testInput.donorDocument.trim()) {
      setToast("Ingrese documento del donante para la prueba");
      return;
    }
    await runAction("test-dte", async () => {
      await api("/api/test/dte", token, { method: "POST", body: testInput });
      setToast("DTE de prueba enviado a cola");
      await delay(2500);
      await refresh();
    });
  }

  async function documentAction(action: "resend" | "retry" | "invalidate") {
    if (!selected) return;
    const body =
      action === "invalidate"
        ? { tipoAnulacion: 2, motivoAnulacion: "Invalidacion solicitada desde panel" }
        : {};
    await runAction(action, async () => {
      await api(`/api/documents/${selected.id}/${action}`, token, { method: "POST", body });
      setToast(action === "resend" ? "Correo reenviado" : action === "retry" ? "Reintento ejecutado" : "Invalidacion transmitida");
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
      setToast(format === "csv" ? "CSV F960 descargado" : "XLSX de inspeccion descargado");
    });
  }

  async function createUser() {
    await runAction("create-user", async () => {
      const created = await api<{ user: User }>("/api/users", token, { method: "POST", body: newUser });
      setToast(`Usuario creado: ${created.user.email}`);
      setNewUser({ name: "", email: "", role: "VIEWER", password: "" });
      await refresh();
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

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    try {
      await action();
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  if (!token || !user) {
    return <AuthScreen onLogin={login} onBootstrap={bootstrap} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <ShieldCheck size={24} />
          <div>
            <strong>ExamplePerson1</strong>
            <span>DTE CDE</span>
          </div>
        </div>
        <nav>
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="profile">
          <span>{user.name}</span>
          <strong>{user.role}</strong>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
            <p>{subtitleFor(view)}</p>
          </div>
          <div className="topbar-actions">
            <div className={contingency ? "contingency-banner open" : "contingency-banner"}>
              <Clock size={16} />
              {contingency ? `Contingencia ${String(contingency.status)}` : "Sin contingencia abierta"}
            </div>
            <button className="icon-button" onClick={logout} title="Cerrar sesion">
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {(view === "documents" || view === "failures") && (
          <>
            {view === "documents" && can(user, "OPERATOR") && (
              <TestDtePanel input={testInput} busy={busy === "test-dte"} onChange={setTestInput} onSubmit={createTestDte} />
            )}
            <section className="document-layout">
              <div className="table-panel">
              <div className="toolbar">
                <label className="search">
                  <Search size={16} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar codigo, donante o correo" />
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
                onAction={documentAction}
                onDownload={downloadDocument}
              />
            </section>
          </>
        )}

        {view === "contingency" && (
          <section className="single-panel">
            <h2>Estado de contingencia</h2>
            <pre>{JSON.stringify(contingency ?? { status: "CLOSED" }, null, 2)}</pre>
            <button className="primary" onClick={async () => { await api("/api/contingency/sweep", token, { method: "POST" }); await refresh(); }}>
              <RefreshCw size={16} />
              Ejecutar barrido
            </button>
          </section>
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
                <UserTable users={users} />
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
            input={credentialInput}
            busy={busy === "credentials"}
            onChange={setCredentialInput}
            onSubmit={updateCredentials}
            onRefresh={async () => setCredentials((await api<{ credentials: CredentialStatus }>("/api/credentials", token)).credentials)}
          />
        )}
      </main>
      {toast && <button className="toast" onClick={() => setToast("")}>{toast}</button>}
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
          {busy === "export-xlsx" ? "Preparando" : "XLSX inspeccion"}
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
            <th>Codigo generacion</th>
            <th>Sello</th>
            <th>Control</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.codigoGeneracion}>
              <td>{row.fechaEmision}</td>
              <td>{row.nombre}<span>{row.correo}</span></td>
              <td className="mono">{row.nit || row.dui || "N/D"}</td>
              <td>${row.monto}</td>
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
  input,
  busy,
  onChange,
  onSubmit,
  onRefresh
}: {
  status: CredentialStatus | null;
  input: CredentialFormInput;
  busy: boolean;
  onChange: (input: CredentialFormInput) => void;
  onSubmit: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const groups = status ? Object.entries(status.groups) : [];
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
        <div className={status?.target.writerConfigured ? "writer-state ready" : "writer-state"}>
          <Cloud size={17} />
          <span>{status?.target.writerConfigured ? "Actualizacion directa activa" : "Falta token Cloudflare para guardar desde aqui"}</span>
        </div>
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
                    <span>{item.label}</span>
                    <strong className={item.configured ? "configured" : ""}>{item.configured ? "Configurado" : "Pendiente"}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

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
            <p>Los valores son write-only en Cloudflare; deje campos en blanco para conservarlos.</p>
          </div>
          <Lock size={20} />
        </div>
        <div className="segmented credential-env">
          <button type="button" className={input.environment === "test" ? "active" : ""} onClick={() => onChange({ ...input, environment: "test" })}>Pruebas 00</button>
          <button type="button" className={input.environment === "production" ? "active" : ""} onClick={() => onChange({ ...input, environment: "production" })}>Produccion 01</button>
        </div>
        <div className="credential-fields">
          <label>
            <span>Usuario MH API</span>
            <input value={input.mhUser} onChange={(event) => onChange({ ...input, mhUser: event.target.value })} placeholder={input.environment === "test" ? "MH_USER_TEST" : "MH_USER_PROD"} autoComplete="off" />
          </label>
          <label>
            <span>Password MH API</span>
            <input value={input.mhPassword} onChange={(event) => onChange({ ...input, mhPassword: event.target.value })} placeholder={input.environment === "test" ? "MH_PASSWORD_TEST" : "MH_PASSWORD_PROD"} type="password" autoComplete="new-password" />
          </label>
          <label className="span-2">
            <span>Certificado XML firmador</span>
            <textarea value={input.certificateXml} onChange={(event) => onChange({ ...input, certificateXml: event.target.value })} placeholder="Se divide automaticamente para Cloudflare" spellCheck={false} />
          </label>
          <label>
            <span>Password llave privada</span>
            <input value={input.certificatePassword} onChange={(event) => onChange({ ...input, certificatePassword: event.target.value })} placeholder="MH_CERT_PASSWORD" type="password" autoComplete="new-password" />
          </label>
          <label>
            <span>Wompi webhook HMAC</span>
            <input value={input.wompiSecret} onChange={(event) => onChange({ ...input, wompiSecret: event.target.value })} placeholder="WOMPI_API_SECRET" type="password" autoComplete="new-password" />
          </label>
          <label className="span-2">
            <span>Emisor config JSON</span>
            <textarea value={input.emisorConfigJson} onChange={(event) => onChange({ ...input, emisorConfigJson: event.target.value })} placeholder="EMISOR_CONFIG_JSON" spellCheck={false} />
          </label>
          <label>
            <span>Fallback email HTTP URL</span>
            <input value={input.emailApiUrl} onChange={(event) => onChange({ ...input, emailApiUrl: event.target.value })} placeholder="EMAIL_API_URL" type="url" />
          </label>
          <label>
            <span>Fallback email API key</span>
            <input value={input.emailApiKey} onChange={(event) => onChange({ ...input, emailApiKey: event.target.value })} placeholder="EMAIL_API_KEY" type="password" autoComplete="new-password" />
          </label>
          <label>
            <span>Email remitente</span>
            <input value={input.emailFrom} onChange={(event) => onChange({ ...input, emailFrom: event.target.value })} placeholder="EMAIL_FROM" type="email" />
          </label>
        </div>
        <div className="credential-actions">
          <div>
            <EyeOff size={16} />
            <span>Los valores enviados no se muestran ni se guardan en D1.</span>
          </div>
          <button className="primary" disabled={busy} type="submit">
            <KeyRound size={16} />
            {busy ? "Guardando" : "Guardar secretos"}
          </button>
        </div>
      </form>
    </section>
  );
}

function TestDtePanel({
  input,
  busy,
  onChange,
  onSubmit
}: {
  input: TestDteInput;
  busy: boolean;
  onChange: (input: TestDteInput) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <section className="test-panel">
      <div>
        <h2>Generar DTE de prueba</h2>
        <p>Ambiente 00 desde una donacion Wompi simulada.</p>
      </div>
      <div className="test-grid">
        <input value={input.amount} onChange={(event) => onChange({ ...input, amount: event.target.value })} placeholder="Monto" inputMode="decimal" />
        <input value={input.donorName} onChange={(event) => onChange({ ...input, donorName: event.target.value })} placeholder="Donante" />
        <input value={input.donorDocument} onChange={(event) => onChange({ ...input, donorDocument: event.target.value })} placeholder="Documento" />
        <input value={input.donorEmail} onChange={(event) => onChange({ ...input, donorEmail: event.target.value })} placeholder="Correo" type="email" />
        <input value={input.donorPhone} onChange={(event) => onChange({ ...input, donorPhone: event.target.value })} placeholder="Telefono" />
        <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
          <FlaskConical size={16} />
          {busy ? "Generando" : "Generar prueba"}
        </button>
      </div>
    </section>
  );
}

function AuthScreen({ onLogin, onBootstrap }: { onLogin: (email: string, password: string) => Promise<void>; onBootstrap: (email: string, name: string, password: string, setupToken: string) => Promise<void> }) {
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
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <ShieldCheck size={32} />
        <h1>ExamplePerson1</h1>
        <div className="segmented">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Ingresar</button>
          <button type="button" className={mode === "bootstrap" ? "active" : ""} onClick={() => setMode("bootstrap")}>Crear owner</button>
        </div>
        {mode === "bootstrap" && <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nombre" />}
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Correo" type="email" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Contrasena" type="password" />
        {mode === "bootstrap" && <input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} placeholder="Token de setup" type="password" />}
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
            <th>Codigo</th>
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
              <td>{document.donor_name ?? "N/D"}<span>{document.donor_email}</span></td>
              <td>${(document.amount_cents / 100).toFixed(2)}</td>
              <td className="mono">{document.sello_recibido ? shortCode(document.sello_recibido) : "N/D"}</td>
              <td>{new Date(document.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailPanel({
  selected,
  busy,
  onAction,
  onDownload
}: {
  selected?: DteDocument;
  busy: string;
  onAction: (action: "resend" | "retry" | "invalidate") => void;
  onDownload: (format: "pdf" | "json") => void;
}) {
  if (!selected) {
    return <aside className="detail-panel empty">Sin documentos.</aside>;
  }
  const plain = JSON.parse(selected.plain_json);
  const canInvalidate = selected.status === "ACCEPTED" && Boolean(selected.sello_recibido);
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <StatusPill status={selected.status} />
        <strong>{selected.numero_control}</strong>
      </div>
      <dl>
        <dt>Codigo generacion</dt>
        <dd className="mono">{selected.codigo_generacion}</dd>
        <dt>Sello</dt>
        <dd className="mono">{selected.sello_recibido ?? "Pendiente"}</dd>
        <dt>Donante</dt>
        <dd>{selected.donor_name ?? "N/D"}</dd>
        <dt>Correo</dt>
        <dd>{selected.donor_email ?? "N/D"}</dd>
        <dt>Ambiente</dt>
        <dd>{selected.environment === "01" ? "Produccion" : "Pruebas"}</dd>
      </dl>
      <div className="legal-box">
        <CheckCircle2 size={17} />
        <span>Ventana legal calculada desde el sello para invalidacion CDE.</span>
      </div>
      <div className="actions">
        <button disabled={busy === "resend"} onClick={() => onAction("resend")}><Mail size={16} />Reenviar</button>
        <button disabled={busy === "retry"} onClick={() => onAction("retry")}><RotateCcw size={16} />Reintentar</button>
        <button className="danger" disabled={!canInvalidate || busy === "invalidate"} onClick={() => onAction("invalidate")}><AlertTriangle size={16} />Invalidar</button>
        <button disabled={busy === "download-pdf"} onClick={() => onDownload("pdf")}><Download size={16} />PDF</button>
        <button disabled={busy === "download-json"} onClick={() => onDownload("json")}><Download size={16} />JSON</button>
      </div>
      <pre>{JSON.stringify(plain.resumen, null, 2)}</pre>
    </aside>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <table>
      <thead><tr><th>Accion</th><th>Entidad</th><th>Resumen</th><th>Fecha</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}><td>{row.action}</td><td>{row.entity_type}</td><td>{row.summary}</td><td>{new Date(row.created_at).toLocaleString()}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function UserTable({ users }: { users: User[] }) {
  return (
    <table>
      <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th></tr></thead>
      <tbody>{users.map((user) => <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{user.role}</td></tr>)}</tbody>
    </table>
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
      <select value={input.role} onChange={(event) => onChange({ ...input, role: event.target.value as Role })}>
        <option value="VIEWER">VIEWER</option>
        <option value="OPERATOR">OPERATOR</option>
        <option value="ADMIN">ADMIN</option>
        <option value="OWNER">OWNER</option>
      </select>
      <input value={input.password} onChange={(event) => onChange({ ...input, password: event.target.value })} placeholder="Contrasena inicial" type="password" />
      <button className="primary" disabled={busy} onClick={() => void onSubmit()}>
        <UserPlus size={16} />
        Crear usuario
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status ${status.toLowerCase()}`}>{status}</span>;
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
    throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
  }
  return data as T;
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
  if (view === "documents") return "Emision, sello, correo y acciones legales por CDE.";
  if (view === "credentials") return "Secretos MH, Wompi y correo para el Worker actual.";
  if (view === "exports") return "Archivos CSV para declaracion y control.";
  return "Operaciones administrativas y trazabilidad.";
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

interface CredentialFormInput {
  environment: "test" | "production";
  mhUser: string;
  mhPassword: string;
  certificateXml: string;
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
    certificatePassword: "",
    emisorConfigJson: "",
    wompiSecret: "",
    emailApiUrl: "",
    emailApiKey: "",
    emailFrom: ""
  };
}
