import { ChevronRight, RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { formatElSalvadorDateTime } from "../shared/legalWindows";
import { formatCents } from "../shared/money";
import { statusLabel } from "./displayText";
import type { DonationLedgerPage, DonationLedgerRow } from "./types";

const PAGE_SIZE = 50;

interface DonationFilters {
  q: string;
  lane: "" | "SV" | "US";
  from: string;
  to: string;
}

const EMPTY_FILTERS: DonationFilters = { q: "", lane: "", from: "", to: "" };

const LANES = {
  SV: { flag: "🇸🇻", label: "El Salvador", title: "El Salvador · CDE" },
  US: { flag: "🇺🇸", label: "EE. UU.", title: "EE. UU. · 501(c)(3)" }
} as const;

const ACKNOWLEDGMENT_LABELS: Record<NonNullable<DonationLedgerRow["acknowledgmentStatus"]>, string> = {
  SENT: "Agradecimiento enviado",
  PENDING: "Agradecimiento en curso",
  PROCESSING: "Agradecimiento en curso",
  FAILED: "Agradecimiento por revisar",
  REVIEW: "Agradecimiento por revisar",
  SUPPRESSED: "Histórico, sin agradecimiento"
};

function filterParams(filters: DonationFilters, cursor: string | null): URLSearchParams {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.lane) params.set("lane", filters.lane);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (cursor) params.set("cursor", cursor);
  return params;
}

function giftTypeLabel(row: DonationLedgerRow): string {
  const type = row.giftType === "DIEZMO" ? "Diezmo" : row.giftType === "OFRENDA" ? "Ofrenda" : "—";
  return row.frequency === "MONTHLY" ? `${type} · Mensual` : type;
}

function ReceiptCell({ row }: { row: DonationLedgerRow }) {
  if (row.lane === "SV") {
    if (!row.documentStatus) return <span className="stacked-cell"><span>Comprobante pendiente</span></span>;
    return (
      <span className="stacked-cell">
        <span className={`status ${row.documentStatus.toLowerCase()}`}>{statusLabel(row.documentStatus).toUpperCase()}</span>
        <small className="mono">{row.numeroControl ?? "—"}</small>
      </span>
    );
  }
  return (
    <span className="stacked-cell">
      <span>{row.acknowledgmentStatus ? ACKNOWLEDGMENT_LABELS[row.acknowledgmentStatus] : "Sin agradecimiento"}</span>
      {row.giftStatus === "REFUNDED" && <small>Reembolsada</small>}
      {row.giftStatus === "PARTIALLY_REFUNDED" && <small>Reembolso parcial de {formatCents(row.refundedAmountCents)}</small>}
    </span>
  );
}

export function DonationsTable({ donations }: { donations: DonationLedgerRow[] }) {
  return (
    <div className="donor-table-scroll">
      <table aria-label="Donaciones" className="donations-table">
        <thead>
          <tr>
            <th>País</th>
            <th>Fecha</th>
            <th>Donante</th>
            <th>Tipo</th>
            <th className="numeric">Monto</th>
            <th>Comprobante</th>
          </tr>
        </thead>
        <tbody>
          {donations.map((row) => {
            const lane = LANES[row.lane];
            return (
              <tr key={row.id}>
                <td>
                  <span className={`lane-badge ${row.lane.toLowerCase()}`} title={lane.title}>
                    <span aria-hidden="true">{lane.flag}</span> {lane.label}
                  </span>
                </td>
                <td>{formatElSalvadorDateTime(row.receivedAt)}</td>
                <td>
                  <span className="stacked-cell">
                    <strong>{row.donorName ?? "—"}</strong>
                    {row.donorEmail && <small>{row.donorEmail}</small>}
                  </span>
                </td>
                <td>{giftTypeLabel(row)}</td>
                <td className="numeric"><strong>{formatCents(row.amountCents)}</strong></td>
                <td><ReceiptCell row={row} /></td>
              </tr>
            );
          })}
          {donations.length === 0 && (
            <tr>
              <td colSpan={6}>No hay donaciones que coincidan con los filtros.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface DonationsViewProps {
  loadPage: (params: URLSearchParams) => Promise<DonationLedgerPage>;
  onError: (error: unknown) => void;
}

export function DonationsView(props: DonationsViewProps) {
  const [draft, setDraft] = useState<DonationFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<DonationFilters>(EMPTY_FILTERS);
  const [donations, setDonations] = useState<DonationLedgerRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestVersion = useRef(0);
  const loadPageRef = useRef(props.loadPage);
  const onErrorRef = useRef(props.onError);
  loadPageRef.current = props.loadPage;
  onErrorRef.current = props.onError;

  function load(filters: DonationFilters, cursor: string | null) {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setLoading(true);
    setError("");
    void loadPageRef.current(filterParams(filters, cursor))
      .then((page) => {
        if (requestVersion.current !== version) return;
        setDonations((current) => (cursor ? [...current, ...page.donations] : page.donations));
        setNextCursor(page.nextCursor);
      })
      .catch((loadError) => {
        if (requestVersion.current !== version) return;
        setError("No se pudieron cargar las donaciones. Intente de nuevo.");
        onErrorRef.current(loadError);
      })
      .finally(() => {
        if (requestVersion.current === version) setLoading(false);
      });
  }

  useEffect(() => {
    load(applied, null);
  }, [applied, refreshVersion]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setError("La fecha inicial no puede ser posterior a la final.");
      return;
    }
    setApplied({ ...draft });
    setRefreshVersion((current) => current + 1);
  }

  function clearFilters() {
    setDraft({ ...EMPTY_FILTERS });
    setApplied({ ...EMPTY_FILTERS });
    setRefreshVersion((current) => current + 1);
  }

  return (
    <div className="donors-view">
      <form className="single-panel donor-filters" onSubmit={applyFilters}>
        <div className="panel-head donor-filter-head">
          <div>
            <h2>Buscar donaciones</h2>
            <p>Las fechas están en hora de El Salvador.</p>
          </div>
        </div>
        <div className="donor-filter-grid">
          <label>
            <span>Buscar</span>
            <input
              value={draft.q}
              onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
              placeholder="Nombre, correo o número de control"
              autoComplete="off"
              maxLength={200}
            />
          </label>
          <label>
            <span>País</span>
            <select
              value={draft.lane}
              onChange={(event) => setDraft((current) => ({ ...current, lane: event.target.value as DonationFilters["lane"] }))}
            >
              <option value="">Todos</option>
              <option value="SV">El Salvador</option>
              <option value="US">EE. UU.</option>
            </select>
          </label>
          <label>
            <span>Desde</span>
            <input
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            />
          </label>
          <label>
            <span>Hasta</span>
            <input
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            />
          </label>
        </div>
        <div className="donor-filter-actions">
          {error && <p className="donor-filter-error" role="alert">{error}</p>}
          <button type="button" className="donor-clear-button" onClick={clearFilters}>
            Limpiar filtros
          </button>
          <button type="submit" className="primary">
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            Actualizar
          </button>
        </div>
      </form>

      <section className="table-panel donor-results-panel" aria-busy={loading}>
        <DonationsTable donations={donations} />
        <div className="document-list-footer donations-footer">
          <span>{donations.length > 0 ? `Mostrando ${donations.length} ${donations.length === 1 ? "donación" : "donaciones"}` : loading ? "Cargando donaciones…" : ""}</span>
          {nextCursor && (
            <button type="button" onClick={() => load(applied, nextCursor)} disabled={loading}>
              <ChevronRight size={16} />
              {loading ? "Cargando" : "Cargar más"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
