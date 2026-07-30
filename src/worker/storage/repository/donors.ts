import type { Ambiente } from "../../types";

export interface DonorExplorerFilters {
  environment: Ambiente;
  documentType?: string;
  documentValue?: string;
  name?: string;
  email?: string;
  minTotalCents?: number;
  maxTotalCents?: number;
  giftType?: "DIEZMO" | "OFRENDA";
  source?: "WOMPI" | "MANUAL";
  limit: number;
  offset: number;
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

interface DonorExplorerSqlRow {
  donor_key: string;
  document_type: string;
  document_number: string;
  donor_name: string;
  donor_email: string | null;
  donor_phone: string | null;
  department: string | null;
  municipality: string | null;
  district: string | null;
  address: string | null;
  country: string | null;
  first_gift_at: string;
  last_gift_at: string;
  gift_count: number;
  total_cents: number;
  diezmo_cents: number;
  ofrenda_cents: number;
  wompi_count: number;
  manual_count: number;
  total_count: number;
}

export async function listDonors(
  db: D1Database,
  filters: DonorExplorerFilters
): Promise<DonorExplorerPage> {
  const documentType = filters.documentType?.trim() ?? "";
  const documentValue = filters.documentValue?.trim() ?? "";
  const name = filters.name?.trim() ?? "";
  const email = filters.email?.trim() ?? "";
  const giftType = filters.giftType ?? "";
  const source = filters.source ?? "";
  const minTotalCents = filters.minTotalCents ?? null;
  const maxTotalCents = filters.maxTotalCents ?? null;
  const result = await db
    .prepare(
      `WITH source AS (
         SELECT
           d.id AS document_id,
           d.amount_cents,
           d.issued_at,
           CASE WHEN d.wompi_event_id IS NULL THEN 'MANUAL' ELSE 'WOMPI' END AS source,
           COALESCE(NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.tipoDocumento')), ''), '') AS document_type,
           COALESCE(NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.numDocumento')), ''), '') AS document_number,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.nombre')), ''),
             NULLIF(TRIM(d.donor_name), ''),
             NULLIF(TRIM(di.donor_name), ''),
             'Sin nombre'
           ) AS donor_name,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.correo')), ''),
             NULLIF(TRIM(d.donor_email), ''),
             NULLIF(TRIM(di.donor_email), '')
           ) AS donor_email,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.telefono')), ''),
             NULLIF(TRIM(di.donor_phone), '')
           ) AS donor_phone,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.direccion.departamento')), ''),
             NULLIF(TRIM(di.direccion_departamento), '')
           ) AS department,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.direccion.municipio')), ''),
             NULLIF(TRIM(di.direccion_municipio), '')
           ) AS municipality,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.direccion.distrito')), ''),
             NULLIF(TRIM(di.direccion_distrito), '')
           ) AS district,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.direccion.complemento')), ''),
             NULLIF(TRIM(di.direccion_complemento), '')
           ) AS address,
           COALESCE(
             NULLIF(TRIM(json_extract(d.plain_json, '$.receptor.codPais')), ''),
             NULLIF(TRIM(di.donor_pais), '')
           ) AS country,
           di.gift_type
         FROM dte_documents d
         LEFT JOIN donation_intents di
           ON di.id = (
             SELECT latest_intent.id
               FROM donation_intents latest_intent
              WHERE latest_intent.document_id = d.id
              ORDER BY latest_intent.created_at DESC, latest_intent.id DESC
              LIMIT 1
           )
         WHERE d.environment = ?
           AND d.status = 'ACCEPTED'
       ),
       identified AS (
         SELECT
           source.*,
           CASE
             WHEN document_type <> '' AND document_number <> '' THEN
               'document:' || document_type || ':' ||
               UPPER(REPLACE(REPLACE(document_number, '-', ''), ' ', ''))
             WHEN donor_email IS NOT NULL THEN 'email:' || LOWER(donor_email)
             ELSE 'record:' || document_id
           END AS donor_key
         FROM source
       ),
       ranked AS (
         SELECT
           identified.*,
           ROW_NUMBER() OVER (
             PARTITION BY donor_key
             ORDER BY issued_at DESC, document_id DESC
           ) AS latest_rank
         FROM identified
       ),
       donors AS (
         SELECT
           donor_key,
           COALESCE(MAX(CASE WHEN latest_rank = 1 THEN document_type END), '') AS document_type,
           COALESCE(MAX(CASE WHEN latest_rank = 1 THEN document_number END), '') AS document_number,
           COALESCE(MAX(CASE WHEN latest_rank = 1 THEN donor_name END), 'Sin nombre') AS donor_name,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN donor_email END),
             MAX(donor_email)
           ) AS donor_email,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN donor_phone END),
             MAX(donor_phone)
           ) AS donor_phone,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN department END),
             MAX(department)
           ) AS department,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN municipality END),
             MAX(municipality)
           ) AS municipality,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN district END),
             MAX(district)
           ) AS district,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN address END),
             MAX(address)
           ) AS address,
           COALESCE(
             MAX(CASE WHEN latest_rank = 1 THEN country END),
             MAX(country)
           ) AS country,
           MIN(issued_at) AS first_gift_at,
           MAX(issued_at) AS last_gift_at,
           COUNT(*) AS gift_count,
           SUM(amount_cents) AS total_cents,
           SUM(CASE WHEN gift_type = 'DIEZMO' THEN amount_cents ELSE 0 END) AS diezmo_cents,
           SUM(CASE WHEN gift_type = 'OFRENDA' THEN amount_cents ELSE 0 END) AS ofrenda_cents,
           SUM(CASE WHEN source = 'WOMPI' THEN 1 ELSE 0 END) AS wompi_count,
           SUM(CASE WHEN source = 'MANUAL' THEN 1 ELSE 0 END) AS manual_count
         FROM ranked
         GROUP BY donor_key
       ),
       filtered AS (
         SELECT *
           FROM donors
          WHERE (? = '' OR document_type = ?)
            AND (
              ? = ''
              OR UPPER(REPLACE(REPLACE(document_number, '-', ''), ' ', ''))
                 LIKE '%' || UPPER(REPLACE(REPLACE(?, '-', ''), ' ', '')) || '%'
            )
            AND (? = '' OR LOWER(donor_name) LIKE '%' || LOWER(?) || '%')
            AND (? = '' OR LOWER(COALESCE(donor_email, '')) LIKE '%' || LOWER(?) || '%')
            AND (? IS NULL OR total_cents >= ?)
            AND (? IS NULL OR total_cents <= ?)
            AND (
              ? = ''
              OR (? = 'DIEZMO' AND diezmo_cents > 0)
              OR (? = 'OFRENDA' AND ofrenda_cents > 0)
            )
            AND (
              ? = ''
              OR (? = 'WOMPI' AND wompi_count > 0)
              OR (? = 'MANUAL' AND manual_count > 0)
            )
       )
       SELECT filtered.*, COUNT(*) OVER () AS total_count
         FROM filtered
        ORDER BY last_gift_at DESC, donor_key ASC
        LIMIT ? OFFSET ?`
    )
    .bind(
      filters.environment,
      documentType,
      documentType,
      documentValue,
      documentValue,
      name,
      name,
      email,
      email,
      minTotalCents,
      minTotalCents,
      maxTotalCents,
      maxTotalCents,
      giftType,
      giftType,
      giftType,
      source,
      source,
      source,
      filters.limit,
      filters.offset
    )
    .all<DonorExplorerSqlRow>();

  const rows = result.results ?? [];
  const donors = rows.map((row): DonorExplorerRow => ({
    key: row.donor_key,
    documentType: row.document_type,
    documentNumber: row.document_number,
    name: row.donor_name,
    email: row.donor_email,
    phone: row.donor_phone,
    department: row.department,
    municipality: row.municipality,
    district: row.district,
    address: row.address,
    country: row.country,
    firstGiftAt: row.first_gift_at,
    lastGiftAt: row.last_gift_at,
    giftCount: Number(row.gift_count),
    totalCents: Number(row.total_cents),
    preferredGiftType:
      Number(row.diezmo_cents) === 0 && Number(row.ofrenda_cents) === 0
        ? null
        : Number(row.diezmo_cents) >= Number(row.ofrenda_cents)
          ? "DIEZMO"
          : "OFRENDA",
    source:
      Number(row.wompi_count) > 0 && Number(row.manual_count) > 0
        ? "MIXED"
        : Number(row.wompi_count) > 0
          ? "WOMPI"
          : "MANUAL"
  }));
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  return {
    donors,
    total,
    limit: filters.limit,
    offset: filters.offset,
    hasMore: filters.offset + donors.length < total
  };
}
