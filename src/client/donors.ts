export interface DonorExplorerFilters {
  documentType: string;
  documentValue: string;
  name: string;
  email: string;
  minAmount: string;
  maxAmount: string;
  giftType: "" | "DIEZMO" | "OFRENDA";
  source: "" | "WOMPI" | "MANUAL";
}

export interface DonorExplorerRow {
  key: string;
  documentType: string;
  documentNumber: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  municipality: string | null;
  district: string | null;
  address: string | null;
  country: string | null;
  firstGiftAt: string;
  lastGiftAt: string;
  giftCount: number;
  totalCents: number;
  preferredGiftType: "DIEZMO" | "OFRENDA" | null;
  source: "WOMPI" | "MANUAL" | "MIXED";
}

export interface DonorExplorerPage {
  donors: DonorExplorerRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface BuildDonorExplorerQueryInput {
  filters: DonorExplorerFilters;
  environment: "00" | "01";
  limit: number;
  offset: number;
}

interface DonorExplorerQueryResult {
  params: URLSearchParams | null;
  error: string | null;
}

function usdAmountToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [whole, decimal = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function buildDonorExplorerQuery(
  input: BuildDonorExplorerQueryInput
): DonorExplorerQueryResult {
  const minTotalCents = input.filters.minAmount.trim()
    ? usdAmountToCents(input.filters.minAmount)
    : undefined;
  const maxTotalCents = input.filters.maxAmount.trim()
    ? usdAmountToCents(input.filters.maxAmount)
    : undefined;
  if (minTotalCents === null || maxTotalCents === null) {
    return {
      params: null,
      error: "Ingrese montos válidos en dólares, con un máximo de dos decimales."
    };
  }
  if (
    minTotalCents !== undefined
    && maxTotalCents !== undefined
    && minTotalCents > maxTotalCents
  ) {
    return {
      params: null,
      error: "El monto desde no puede ser mayor que el monto hasta."
    };
  }

  const params = new URLSearchParams({ environment: input.environment });
  const textFilters: Array<[string, string]> = [
    ["documentType", input.filters.documentType],
    ["documentValue", input.filters.documentValue],
    ["name", input.filters.name],
    ["email", input.filters.email]
  ];
  for (const [name, value] of textFilters) {
    const trimmed = value.trim();
    if (trimmed) params.set(name, trimmed);
  }
  if (minTotalCents !== undefined) params.set("minTotalCents", String(minTotalCents));
  if (maxTotalCents !== undefined) params.set("maxTotalCents", String(maxTotalCents));
  if (input.filters.giftType) params.set("giftType", input.filters.giftType);
  if (input.filters.source) params.set("source", input.filters.source);
  params.set("limit", String(input.limit));
  params.set("offset", String(input.offset));
  return { params, error: null };
}

export function maskDocumentNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "—";
  if (trimmed.length <= 4) return "••••";
  return `${"•".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}
