import {
  CalendarDays,
  CircleDollarSign,
  HeartHandshake,
  IdCard,
  ListChecks,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Route,
  X
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  CAT012_DEPARTMENTS,
  CAT020_COUNTRIES,
  CAT022_DOCUMENT_TYPES,
  findCatalogOption
} from "../shared/catalogs";
import { formatElSalvadorDateTime } from "../shared/legalWindows";
import { formatCents } from "../shared/money";
import {
  buildDonorExplorerQuery,
  maskDocumentNumber,
  type DonorExplorerFilters,
  type DonorExplorerPage,
  type DonorExplorerRow
} from "./donors";

const PAGE_SIZE = 25;

const EMPTY_FILTERS: DonorExplorerFilters = {
  documentType: "",
  documentValue: "",
  name: "",
  email: "",
  minAmount: "",
  maxAmount: "",
  giftType: "",
  source: ""
};

interface DonorsViewProps {
  environment: "00" | "01";
  loadPage: (params: URLSearchParams) => Promise<DonorExplorerPage>;
  onError: (error: unknown) => void;
}

export function DonorsView(props: DonorsViewProps) {
  const [draft, setDraft] = useState<DonorExplorerFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<DonorExplorerFilters>(EMPTY_FILTERS);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<DonorExplorerPage | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterError, setFilterError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestVersion = useRef(0);
  const loadPageRef = useRef(props.loadPage);
  const onErrorRef = useRef(props.onError);
  loadPageRef.current = props.loadPage;
  onErrorRef.current = props.onError;

  const selected = useMemo(
    () => page?.donors.find((donor) => donor.key === selectedKey) ?? null,
    [page, selectedKey]
  );

  useEffect(() => {
    const query = buildDonorExplorerQuery({
      filters: applied,
      environment: props.environment,
      limit: PAGE_SIZE,
      offset: pageIndex * PAGE_SIZE
    });
    if (!query.params) {
      setFilterError(query.error ?? "Revise los filtros.");
      setLoading(false);
      return;
    }
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setLoading(true);
    setFilterError("");
    void loadPageRef.current(query.params)
      .then((nextPage) => {
        if (requestVersion.current !== version) return;
        setPage(nextPage);
        setSelectedKey((current) =>
          current && nextPage.donors.some((donor) => donor.key === current)
            ? current
            : nextPage.donors[0]?.key ?? null
        );
      })
      .catch((error) => {
        if (requestVersion.current !== version) return;
        setPage(null);
        setSelectedKey(null);
        setFilterError("No se pudieron cargar los donantes. Intente de nuevo.");
        onErrorRef.current(error);
      })
      .finally(() => {
        if (requestVersion.current === version) setLoading(false);
      });
  }, [applied, pageIndex, props.environment, refreshVersion]);

  function updateFilter<K extends keyof DonorExplorerFilters>(
    key: K,
    value: DonorExplorerFilters[K]
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = buildDonorExplorerQuery({
      filters: draft,
      environment: props.environment,
      limit: PAGE_SIZE,
      offset: 0
    });
    if (!query.params) {
      setFilterError(query.error ?? "Revise los filtros.");
      return;
    }
    setFilterError("");
    setPageIndex(0);
    setApplied({ ...draft });
    setRefreshVersion((current) => current + 1);
  }

  function clearFilters() {
    setDraft({ ...EMPTY_FILTERS });
    setApplied({ ...EMPTY_FILTERS });
    setPageIndex(0);
    setFilterError("");
    setRefreshVersion((current) => current + 1);
  }

  function selectWithKeyboard(event: KeyboardEvent<HTMLTableRowElement>, key: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedKey(key);
    }
  }

  const resultStart = page && page.total > 0 ? page.offset + 1 : 0;
  const resultEnd = page ? Math.min(page.offset + page.donors.length, page.total) : 0;

  return (
    <div className="donors-view">
      <form className="single-panel donor-filters" onSubmit={applyFilters}>
        <div className="panel-head donor-filter-head">
          <div>
            <h2>Buscar donantes</h2>
            <p>
              Solo se incluyen CDE aceptados del ambiente de{" "}
              {props.environment === "00" ? "pruebas" : "producción"}.
            </p>
          </div>
        </div>
        <div className="donor-filter-grid">
          <label>
            <span>Tipo de documento</span>
            <select
              value={draft.documentType}
              onChange={(event) => updateFilter("documentType", event.target.value)}
            >
              <option value="">Todos</option>
              {CAT022_DOCUMENT_TYPES.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Número de documento</span>
            <input
              value={draft.documentValue}
              onChange={(event) => updateFilter("documentValue", event.target.value)}
              placeholder="Buscar documento"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Nombre</span>
            <input
              value={draft.name}
              onChange={(event) => updateFilter("name", event.target.value)}
              placeholder="Buscar nombre"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Correo</span>
            <input
              value={draft.email}
              onChange={(event) => updateFilter("email", event.target.value)}
              placeholder="Buscar correo"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Total desde</span>
            <span className="donor-money-input">
              <span aria-hidden="true">$</span>
              <input
                value={draft.minAmount}
                onChange={(event) => updateFilter("minAmount", event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                aria-label="Total desde"
              />
            </span>
          </label>
          <label>
            <span>Total hasta</span>
            <span className="donor-money-input">
              <span aria-hidden="true">$</span>
              <input
                value={draft.maxAmount}
                onChange={(event) => updateFilter("maxAmount", event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                aria-label="Total hasta"
              />
            </span>
          </label>
          <label>
            <span>Tipo de entrega</span>
            <select
              value={draft.giftType}
              onChange={(event) => updateFilter(
                "giftType",
                event.target.value as DonorExplorerFilters["giftType"]
              )}
            >
              <option value="">Todos</option>
              <option value="DIEZMO">Diezmo</option>
              <option value="OFRENDA">Ofrenda</option>
            </select>
          </label>
          <label>
            <span>Origen</span>
            <select
              value={draft.source}
              onChange={(event) => updateFilter(
                "source",
                event.target.value as DonorExplorerFilters["source"]
              )}
            >
              <option value="">Todos</option>
              <option value="WOMPI">En línea (Wompi)</option>
              <option value="MANUAL">Manual</option>
            </select>
          </label>
        </div>
        <div className="donor-filter-actions">
          {filterError && <p className="donor-filter-error" role="alert">{filterError}</p>}
          <button type="button" className="donor-clear-button" onClick={clearFilters}>
            Limpiar filtros
          </button>
          <button type="submit" className="primary">
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            Actualizar
          </button>
        </div>
      </form>

      <div className={selected ? "donor-explorer-layout has-detail" : "donor-explorer-layout"}>
        <section className="table-panel donor-results-panel" aria-busy={loading}>
          <div className="donor-results-head">
            <div>
              <h2>Resultados</h2>
              <p>{page ? `${page.total} donante${page.total === 1 ? "" : "s"}` : "Cargando donantes…"}</p>
            </div>
            {loading && <span className="donor-loading">Actualizando…</span>}
          </div>
          <div className="donor-table-scroll">
            <table aria-label="Donantes">
              <thead>
                <tr>
                  <th>Donante</th>
                  <th>Contacto</th>
                  <th>Ubicación</th>
                  <th>Actividad</th>
                  <th className="numeric">Total entregado</th>
                  <th>Última entrega</th>
                </tr>
              </thead>
              <tbody>
                {page?.donors.map((donor) => (
                  <tr
                    key={donor.key}
                    className={selectedKey === donor.key ? "selected" : ""}
                    aria-selected={selectedKey === donor.key}
                    tabIndex={0}
                    onClick={() => setSelectedKey(donor.key)}
                    onKeyDown={(event) => selectWithKeyboard(event, donor.key)}
                  >
                    <td>
                      <span className="stacked-cell">
                        <strong>{donor.name}</strong>
                        <small>{documentTypeLabel(donor.documentType)} · {maskDocumentNumber(donor.documentNumber)}</small>
                      </span>
                    </td>
                    <td>
                      <span className="stacked-cell">
                        <span>{donor.email ?? "Sin correo"}</span>
                        <small>{donor.phone ?? "Sin teléfono"}</small>
                      </span>
                    </td>
                    <td>{locationLabel(donor)}</td>
                    <td>
                      <span className="stacked-cell">
                        <strong>{donor.giftCount} {donor.giftCount === 1 ? "entrega" : "entregas"}</strong>
                        <small>{giftTypeLabel(donor.preferredGiftType)} · {sourceLabel(donor.source)}</small>
                      </span>
                    </td>
                    <td className="numeric"><strong>{formatCents(donor.totalCents)}</strong></td>
                    <td>{formatElSalvadorDateTime(donor.lastGiftAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && page?.donors.length === 0 && (
            <div className="donor-empty" role="status">
              <strong>No se encontraron donantes.</strong>
              <span>Ajuste o limpie los filtros para ver resultados.</span>
            </div>
          )}
          <footer className="donor-pagination">
            <span>
              {page
                ? `Mostrando ${resultStart} a ${resultEnd} de ${page.total} donantes`
                : "Preparando resultados…"}
            </span>
            <div>
              <button
                type="button"
                disabled={loading || pageIndex === 0}
                onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              >
                Anterior
              </button>
              <button
                type="button"
                disabled={loading || !page?.hasMore}
                onClick={() => setPageIndex((current) => current + 1)}
              >
                Siguiente
              </button>
            </div>
          </footer>
        </section>

        {selected && (
          <aside className="detail-panel donor-detail-panel" aria-label={`Detalle de ${selected.name}`}>
            <header>
              <div>
                <p>Detalle del donante</p>
                <h2>{selected.name}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Cerrar detalle"
                title="Cerrar detalle"
                onClick={() => setSelectedKey(null)}
              >
                <X size={17} />
              </button>
            </header>
            <dl>
              <Detail icon={<IdCard size={17} />} label="Documento">
                {documentTypeLabel(selected.documentType)} · {selected.documentNumber || "—"}
              </Detail>
              <Detail icon={<Mail size={17} />} label="Correo">{selected.email ?? "—"}</Detail>
              <Detail icon={<Phone size={17} />} label="Teléfono">{selected.phone ?? "—"}</Detail>
              <Detail icon={<MapPin size={17} />} label="Ubicación">{fullLocationLabel(selected)}</Detail>
              <Detail icon={<CalendarDays size={17} />} label="Primera entrega">
                {formatElSalvadorDateTime(selected.firstGiftAt)}
              </Detail>
              <Detail icon={<CalendarDays size={17} />} label="Última entrega">
                {formatElSalvadorDateTime(selected.lastGiftAt)}
              </Detail>
              <Detail icon={<ListChecks size={17} />} label="Entregas">{selected.giftCount}</Detail>
              <Detail icon={<CircleDollarSign size={17} />} label="Total entregado">
                {formatCents(selected.totalCents)}
              </Detail>
              <Detail icon={<HeartHandshake size={17} />} label="Tipo preferido">
                {giftTypeLabel(selected.preferredGiftType)}
              </Detail>
              <Detail icon={<Route size={17} />} label="Origen">{sourceLabel(selected.source)}</Detail>
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}

function Detail(props: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt>{props.icon}<span>{props.label}</span></dt>
      <dd>{props.children}</dd>
    </div>
  );
}

function documentTypeLabel(value: string): string {
  return findCatalogOption(CAT022_DOCUMENT_TYPES, value)?.label ?? (value || "Sin documento");
}

function giftTypeLabel(value: DonorExplorerRow["preferredGiftType"]): string {
  if (value === "DIEZMO") return "Diezmo";
  if (value === "OFRENDA") return "Ofrenda";
  return "Sin clasificar";
}

function sourceLabel(value: DonorExplorerRow["source"]): string {
  if (value === "WOMPI") return "En línea";
  if (value === "MANUAL") return "Manual";
  return "En línea y manual";
}

function locationLabel(donor: DonorExplorerRow): string {
  if (donor.country && donor.country !== "SV") {
    return findCatalogOption(CAT020_COUNTRIES, donor.country)?.label ?? donor.country;
  }
  return donor.department
    ? findCatalogOption(CAT012_DEPARTMENTS, donor.department)?.label ?? donor.department
    : "Sin ubicación";
}

function fullLocationLabel(donor: DonorExplorerRow): string {
  const location = locationLabel(donor);
  return donor.address ? `${donor.address} · ${location}` : location;
}
