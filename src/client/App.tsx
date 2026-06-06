import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  History,
  KeyRound,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Users
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AuditRow, DteDocument, User } from "./types";

type View = "documents" | "failures" | "contingency" | "audit" | "users";

const navItems: Array<{ id: View; label: string; icon: typeof FileText }> = [
  { id: "documents", label: "Documentos", icon: FileText },
  { id: "failures", label: "Fallos", icon: AlertTriangle },
  { id: "contingency", label: "Contingencia", icon: Clock },
  { id: "audit", label: "Auditoria", icon: History },
  { id: "users", label: "Usuarios", icon: Users }
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
  const [contingency, setContingency] = useState<Record<string, unknown> | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [toast, setToast] = useState("");

  const selected = useMemo(() => documents.find((document) => document.id === selectedId) ?? documents[0], [documents, selectedId]);
  const filteredStatus = view === "failures" ? "FAILED" : status;

  useEffect(() => {
    if (!token) {
      return;
    }
    void refresh();
  }, [token, filteredStatus, query]);

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
  }

  async function login(email: string, password: string) {
    const result = await api<{ user: User; token: string }>("/api/auth/login", "", { method: "POST", body: { email, password } });
    localStorage.setItem("diezmos_token", result.token);
    localStorage.setItem("diezmos_user", JSON.stringify(result.user));
    setToken(result.token);
    setUser(result.user);
  }

  async function bootstrap(email: string, name: string, password: string) {
    await api("/api/auth/bootstrap-owner", "", { method: "POST", body: { email, name, password } });
    await login(email, password);
  }

  async function documentAction(action: "resend" | "retry" | "invalidate") {
    if (!selected) return;
    const body =
      action === "invalidate"
        ? { tipoAnulacion: 2, motivoAnulacion: "Invalidacion solicitada desde panel" }
        : {};
    await api(`/api/documents/${selected.id}/${action}`, token, { method: "POST", body });
    setToast(action === "resend" ? "Correo reenviado" : action === "retry" ? "Reintento ejecutado" : "Invalidacion transmitida");
    await refresh();
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
          {navItems.map((item) => {
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
            <p>{view === "documents" ? "Emision, sello, correo y acciones legales por CDE." : "Operaciones administrativas y trazabilidad."}</p>
          </div>
          <div className={contingency ? "contingency-banner open" : "contingency-banner"}>
            <Clock size={16} />
            {contingency ? `Contingencia ${String(contingency.status)}` : "Sin contingencia abierta"}
          </div>
        </header>

        {(view === "documents" || view === "failures") && (
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
            <DetailPanel selected={selected} onAction={documentAction} />
          </section>
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
            {can(user, "ADMIN") ? <UserTable users={users} /> : <p>No tiene permisos para administrar usuarios.</p>}
          </section>
        )}
      </main>
      {toast && <button className="toast" onClick={() => setToast("")}>{toast}</button>}
    </div>
  );
}

function AuthScreen({ onLogin, onBootstrap }: { onLogin: (email: string, password: string) => Promise<void>; onBootstrap: (email: string, name: string, password: string) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            if (mode === "bootstrap") await onBootstrap(email, name, password);
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

function DetailPanel({ selected, onAction }: { selected?: DteDocument; onAction: (action: "resend" | "retry" | "invalidate") => void }) {
  if (!selected) {
    return <aside className="detail-panel empty">Sin documentos.</aside>;
  }
  const plain = JSON.parse(selected.plain_json);
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
        <button onClick={() => onAction("resend")}><Mail size={16} />Reenviar</button>
        <button onClick={() => onAction("retry")}><RotateCcw size={16} />Reintentar</button>
        <button className="danger" onClick={() => onAction("invalidate")}><AlertTriangle size={16} />Invalidar</button>
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

function StatusPill({ status }: { status: string }) {
  return <span className={`status ${status.toLowerCase()}`}>{status}</span>;
}

async function api<T>(path: string, token: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {})
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

type Role = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";
