import { getEmisorConfig, getMhCertificateXml, requireSecret } from "./config";
import { buildAdvancedCdeDocument, buildCdeDocument, buildInvalidacionEvent, cdeDocumentSummary, type InvalidationInput } from "./domain/dteBuilder";
import { signMhDocument } from "./domain/signer";
import { buildTestWompiPayload, type TestWompiInput } from "./domain/testWompi";
import { isApprovedDonation, normalizeWompiWebhook, verifyWompiHash, WompiPayloadError, wompiHashHeader } from "./domain/wompi";
import { AuthError, AuthService, requireRole, type AuthUser, type Role } from "./services/auth";
import { bootstrapCloudflareWriterToken, buildCredentialSecretPatch, CredentialWriterConfigError, credentialStatus, patchCloudflareWorkerSecrets, type CredentialUpdateInput } from "./services/credentials";
import { EmailService } from "./services/email";
import { buildF960Csv, buildF960Selection, buildF960Xlsx, XLSX_MIME, type F960Selection } from "./services/f960";
import { MhClient } from "./services/mhClient";
import { IssuancePipeline } from "./services/pipeline";
import { renderDtePdf } from "./services/pdf";
import { Repository } from "./storage/repository";
import type { Env, IssuanceMessage, MhResponse, WompiWebhook } from "./types";
import { addHours, cdeInvalidationDeadline, isWithinDeadline, nowIso } from "./utils/dates";
import { timingSafeEqual } from "./utils/encoding";
import { jsonResponse, methodNotAllowed, notFound } from "./utils/http";

const BOOTSTRAP_OWNER_TOKEN_HEADER = "X-Bootstrap-Owner-Token";
const EMISSION_ENVIRONMENT_SETTING = "emission_environment";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      if (url.pathname === "/webhooks/wompi") {
        return await handleWompiWebhook(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof AuthError) {
        return jsonResponse({ error: "auth_error", message: error.message }, { status: error.status });
      }
      return jsonResponse({ error: "internal_error", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },

  async queue(batch: MessageBatch<IssuanceMessage>, env: Env): Promise<void> {
    const pipeline = new IssuancePipeline(env);
    for (const message of batch.messages) {
      try {
        if (message.body.advancedDocumentId) {
          await pipeline.processDteDocument(message.body.advancedDocumentId);
        } else if (message.body.wompiEventId) {
          await pipeline.processWompiEvent(message.body.wompiEventId);
        } else {
          throw new Error("Issuance message did not include a target id");
        }
        message.ack();
      } catch (error) {
        console.error("Issuance message failed", error);
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await new IssuancePipeline(env).runContingencySweep();
  }
};

async function handleWompiWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const rawBody = await request.text();
  const valid = await verifyWompiHash(rawBody, wompiHashHeader(request), requireSecret(env, "WOMPI_API_SECRET"));
  if (!valid) {
    return jsonResponse({ error: "invalid_wompi_hash" }, { status: 401 });
  }
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid_wompi_payload", message: "El webhook Wompi no contiene JSON válido" }, { status: 400 });
  }
  let payload: WompiWebhook;
  try {
    payload = normalizeWompiWebhook(parsedPayload);
  } catch (error) {
    if (error instanceof WompiPayloadError) {
      return jsonResponse({ error: "invalid_wompi_payload", message: error.message }, { status: 400 });
    }
    throw error;
  }
  const repo = new Repository(env.DB);
  const environment = await activeEmissionEnvironment(repo, env);
  const headers = Object.fromEntries([...request.headers.entries()].filter(([key]) => key.toLowerCase() !== "authorization"));
  const { record, inserted } = await repo.insertWompiEvent(payload, rawBody, headers, environment);
  await repo.createAudit({
    action: inserted ? "WOMPI_RECEIVED" : "WOMPI_DUPLICATE",
    entityType: "wompi_event",
    entityId: record.id,
    summary: `${payload.IdTransaccion} ${payload.ResultadoTransaccion}`
  });
  if (inserted && isApprovedDonation(payload)) {
    await env.ISSUANCE_QUEUE.send({ wompiEventId: record.id });
  }
  return jsonResponse({ ok: true, wompiEventId: record.id, inserted, queued: inserted && isApprovedDonation(payload) }, { status: inserted ? 202 : 200 });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const repo = new Repository(env.DB);
  const auth = new AuthService(env);
  const user = await auth.authenticate(request);

  if (url.pathname === "/api/health") {
    return jsonResponse({ ok: true, appEnv: env.APP_ENV ?? "unknown", now: nowIso() });
  }

  if (url.pathname === "/api/auth/bootstrap-owner" && request.method === "POST") {
    if (!hasValidBootstrapOwnerToken(request, env)) {
      return jsonResponse({ error: "bootstrap_token_required" }, { status: 403 });
    }
    const body = (await request.json()) as { email: string; name: string; password: string };
    const owner = await auth.bootstrapOwner(body);
    await repo.createAudit({ action: "OWNER_BOOTSTRAPPED", entityType: "user", entityId: owner.id, summary: owner.email });
    return jsonResponse({ user: owner }, { status: 201 });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = (await request.json()) as { email: string; password: string };
    const result = await auth.login(body.email, body.password);
    await repo.createAudit({ actorType: "USER", actorId: result.user.id, action: "LOGIN", entityType: "user", entityId: result.user.id, summary: result.user.email });
    return jsonResponse(result);
  }

  if (url.pathname === "/api/documents" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({
      documents: await repo.listDteDocuments({
        status: url.searchParams.get("status"),
        q: url.searchParams.get("q"),
        limit: Number(url.searchParams.get("limit") ?? 50)
      })
    });
  }

  if (url.pathname === "/api/credentials") {
    return handleCredentialsRoute(request, env, repo, user);
  }

  if (url.pathname === "/api/credentials/writer-token") {
    return handleCredentialWriterTokenRoute(request, env, repo, user);
  }

  if (url.pathname === "/api/settings/emission-environment") {
    return handleEmissionEnvironmentRoute(request, env, repo, user);
  }

  if (url.pathname === "/api/exports/f960" && request.method === "GET") {
    requireRole(user, "ADMIN");
    const selection = await f960Selection(repo, url);
    if (selection instanceof Response) return selection;
    return jsonResponse(selection);
  }

  if (url.pathname === "/api/exports/f960.csv" && request.method === "GET") {
    const actor = requireRole(user, "ADMIN");
    const selection = await f960Selection(repo, url);
    if (selection instanceof Response) return selection;
    await auditExport(repo, actor, "F960_EXPORTED", selection.csvFilename, selection.rowCount);
    return new Response(buildF960Csv(selection), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${selection.csvFilename}"`
      }
    });
  }

  if (url.pathname === "/api/exports/f960.xlsx" && request.method === "GET") {
    const actor = requireRole(user, "ADMIN");
    const selection = await f960Selection(repo, url);
    if (selection instanceof Response) return selection;
    await auditExport(repo, actor, "F960_INSPECTION_EXPORTED", selection.xlsxFilename, selection.rowCount);
    return new Response(buildF960Xlsx(selection), {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${selection.xlsxFilename}"`
      }
    });
  }

  const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/([^/]+))?$/);
  if (documentMatch) {
    return handleDocumentRoute(request, env, repo, user, documentMatch[1], documentMatch[2]);
  }

  if (url.pathname === "/api/audit" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ audit: await repo.listAudit(url.searchParams.get("entityType") ?? undefined, url.searchParams.get("entityId") ?? undefined) });
  }

  if (url.pathname === "/api/contingency" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ contingency: await contingencyState(repo) });
  }

  if (url.pathname === "/api/contingency/open" && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json().catch(() => ({}))) as { environment?: unknown; tipoContingencia?: unknown; reason?: unknown };
    const environment = body.environment === "01" ? "01" : body.environment === "00" ? "00" : null;
    if (!environment) {
      return jsonResponse({ error: "invalid_contingency_environment" }, { status: 400 });
    }
    const tipoContingencia = Number(body.tipoContingencia);
    if (!Number.isInteger(tipoContingencia) || tipoContingencia < 1 || tipoContingencia > 5) {
      return jsonResponse({ error: "invalid_contingency_type" }, { status: 400 });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return jsonResponse({ error: "missing_contingency_reason", message: "Configure el tipo y motivo de contingencia antes de emitir DTE en contingencia." }, { status: 400 });
    }
    const existing = await repo.getOpenContingency(environment);
    const periodId = await repo.openContingency(environment, reason, tipoContingencia);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: existing ? "CONTINGENCY_OPEN_REUSED" : "CONTINGENCY_OPENED",
      entityType: "contingency_period",
      entityId: periodId,
      summary: reason,
      metadata: { environment, tipoContingencia }
    });
    return jsonResponse({ contingency: await contingencyState(repo) }, { status: existing ? 200 : 201 });
  }

  if (url.pathname === "/api/contingency/sweep" && request.method === "POST") {
    requireRole(user, "OPERATOR");
    return jsonResponse(await new IssuancePipeline(env).runContingencySweep());
  }

  if (url.pathname === "/api/test/dte" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (isProduction(env)) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const input = (await request.json().catch(() => ({}))) as TestWompiInput;
    const donorDocument = input.donorDocument?.trim();
    if (!donorDocument) {
      return jsonResponse({ error: "missing_donor_document" }, { status: 400 });
    }
    let payload;
    try {
      payload = buildTestWompiPayload({ ...input, donorDocument });
    } catch (error) {
      return jsonResponse({ error: "invalid_test_payload", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const rawBody = JSON.stringify(payload);
    const environment = await activeEmissionEnvironment(repo, env);
    const { record, inserted } = await repo.insertWompiEvent(payload, rawBody, { source: "admin_test_generation" }, environment);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: inserted ? "TEST_WOMPI_CREATED" : "TEST_WOMPI_DUPLICATE",
      entityType: "wompi_event",
      entityId: record.id,
      summary: payload.IdTransaccion
    });
    if (inserted) {
      await env.ISSUANCE_QUEUE.send({ wompiEventId: record.id });
    }
    return jsonResponse({ ok: true, wompiEventId: record.id, queued: inserted, transactionId: payload.IdTransaccion }, { status: inserted ? 202 : 200 });
  }

  if (url.pathname === "/api/test/dte/advanced-template" && request.method === "POST") {
    requireRole(user, "OPERATOR");
    if (isProduction(env)) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const input = (await request.json().catch(() => ({}))) as TestWompiInput;
    try {
      const payload = buildTestWompiPayload(input, { defaultAmount: "1.00" });
      const environment = await activeEmissionEnvironment(repo, env);
      const draft = buildCdeDocument(payload, getEmisorConfig(env), { sequence: 1, environment });
      return jsonResponse({ draft, sections: ["identificacion", "emisor", "receptor", "otrosDocumentos", "cuerpoDocumento", "resumen", "apendice"] });
    } catch (error) {
      return jsonResponse({ error: "invalid_advanced_template", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  if (url.pathname === "/api/test/dte/advanced" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (isProduction(env)) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { draft?: unknown };
    const config = getEmisorConfig(env);
    const environment = await activeEmissionEnvironment(repo, env);
    let document: Record<string, unknown>;
    try {
      buildAdvancedCdeDocument(body.draft, config, { sequence: 1, environment });
      const sequence = await repo.nextControlSequence(environment, config.controlPrefix);
      document = buildAdvancedCdeDocument(body.draft, config, { sequence, environment });
    } catch (error) {
      return jsonResponse({ error: "invalid_advanced_cde", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const summary = cdeDocumentSummary(document);
    const syntheticWompi = advancedCdeWompiPayload(document, summary);
    const { record: wompiEvent } = await repo.insertWompiEvent(
      syntheticWompi,
      JSON.stringify(syntheticWompi),
      { source: "admin_advanced_generation" },
      summary.environment
    );
    const dte = await repo.createDteDocument({
      wompiEventId: wompiEvent.id,
      environment: summary.environment,
      codigoGeneracion: summary.codigoGeneracion,
      numeroControl: summary.numeroControl,
      plainJson: document,
      donorEmail: summary.donorEmail,
      donorName: summary.donorName,
      amountCents: summary.amountCents,
      issuedAt: nowIso()
    });
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "ADVANCED_CDE_CREATED",
      entityType: "dte_document",
      entityId: dte.id,
      summary: dte.numero_control,
      metadata: { source: "admin_advanced_generation" }
    });
    await env.ISSUANCE_QUEUE.send({ advancedDocumentId: dte.id });
    return jsonResponse({ ok: true, documentId: dte.id, queued: true, numeroControl: dte.numero_control, codigoGeneracion: dte.codigo_generacion }, { status: 202 });
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    requireRole(user, "ADMIN");
    return jsonResponse({ users: await repo.listUsers() });
  }

  if (url.pathname === "/api/users" && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json()) as { email: string; name: string; role: Role; password: string };
    const created = await auth.createUser(body);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_CREATED", entityType: "user", entityId: created.id, summary: created.email });
    return jsonResponse({ user: created }, { status: 201 });
  }

  const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (passwordMatch && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== "string" || !body.password) {
      return jsonResponse({ error: "missing_user_password", message: "Ingrese nueva contraseña" }, { status: 400 });
    }
    try {
      await auth.resetUserPassword(passwordMatch[1], body.password);
    } catch (error) {
      return jsonResponse({ error: "invalid_user_password", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_PASSWORD_RESET", entityType: "user", entityId: passwordMatch[1], summary: "Contraseña restablecida por administrador" });
    return jsonResponse({ ok: true });
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === "PATCH") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json().catch(() => ({}))) as { role?: unknown; disabled?: unknown; name?: unknown; email?: unknown };
    const patch = userPatchInput(body);
    if (patch instanceof Response) return patch;
    const updated = await repo.updateUser(userMatch[1], patch);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_UPDATED", entityType: "user", entityId: userMatch[1], summary: "Usuario actualizado", metadata: patch });
    return jsonResponse({ user: updated });
  }

  return notFound();
}

function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "local").toLowerCase() === "production";
}

async function handleEmissionEnvironmentRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null): Promise<Response> {
  if (request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ emissionEnvironment: await emissionEnvironmentState(repo, env) });
  }
  if (request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = requireRole(user, "OWNER");
  const body = (await request.json().catch(() => ({}))) as { environment?: unknown };
  const environment = ambienteValue(body.environment);
  if (!environment) {
    return jsonResponse({ error: "invalid_emission_environment", message: "Seleccione Pruebas 00 o Producción 01." }, { status: 400 });
  }
  await repo.setSetting(EMISSION_ENVIRONMENT_SETTING, environment, actor.id);
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "EMISSION_ENVIRONMENT_UPDATED",
    entityType: "app_setting",
    entityId: EMISSION_ENVIRONMENT_SETTING,
    summary: environment === "01" ? "Ambiente de emisión cambiado a Producción 01" : "Ambiente de emisión cambiado a Pruebas 00",
    metadata: { environment }
  });
  return jsonResponse({ ok: true, emissionEnvironment: await emissionEnvironmentState(repo, env) });
}

async function activeEmissionEnvironment(repo: Repository, env: Env): Promise<"00" | "01"> {
  const configured = ambienteValue(await repo.getSetting(EMISSION_ENVIRONMENT_SETTING));
  return configured ?? defaultEmissionEnvironment(env);
}

async function emissionEnvironmentState(repo: Repository, env: Env): Promise<{ environment: "00" | "01"; source: "setting" | "deployment_default"; appEnv: string }> {
  const configured = ambienteValue(await repo.getSetting(EMISSION_ENVIRONMENT_SETTING));
  return {
    environment: configured ?? defaultEmissionEnvironment(env),
    source: configured ? "setting" : "deployment_default",
    appEnv: env.APP_ENV ?? "local"
  };
}

function defaultEmissionEnvironment(env: Env): "00" | "01" {
  return isProduction(env) ? "01" : "00";
}

function ambienteValue(value: unknown): "00" | "01" | null {
  if (value === "00" || value === "test" || value === "staging") return "00";
  if (value === "01" || value === "production" || value === "prod") return "01";
  return null;
}

function userPatchInput(body: { role?: unknown; disabled?: unknown; name?: unknown; email?: unknown }): Response | { role?: Role; disabled?: boolean; name?: string; email?: string } {
  const patch: { role?: Role; disabled?: boolean; name?: string; email?: string } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "invalid_user_name", message: "Ingrese nombre del usuario" }, { status: 400 });
    }
    patch.name = body.name.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== "string" || !body.email.trim() || !body.email.includes("@")) {
      return jsonResponse({ error: "invalid_user_email", message: "Ingrese correo válido" }, { status: 400 });
    }
    patch.email = body.email.trim().toLowerCase();
  }
  if (body.role !== undefined) {
    if (!isRole(body.role)) {
      return jsonResponse({ error: "invalid_user_role", message: "Seleccione un rol válido" }, { status: 400 });
    }
    patch.role = body.role;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") {
      return jsonResponse({ error: "invalid_user_disabled", message: "Estado de usuario inválido" }, { status: 400 });
    }
    patch.disabled = body.disabled;
  }
  return patch;
}

function isRole(value: unknown): value is Role {
  return value === "VIEWER" || value === "OPERATOR" || value === "ADMIN" || value === "OWNER";
}

async function contingencyState(repo: Repository): Promise<Record<string, unknown>> {
  const activeRaw = await repo.getOpenContingency();
  const periodsRaw = await repo.listContingencyPeriods();
  const pendingDocuments = activeRaw
    ? await repo.listContingencyDocuments(String(activeRaw.id))
    : await repo.listDteDocuments({ status: "CONTINGENCY_PENDING", limit: 100 });
  const batches = activeRaw ? await repo.listContingencyBatches(String(activeRaw.id)) : await repo.listContingencyBatches();
  const batchLines = activeRaw ? await repo.listContingencyBatchLines({ periodId: String(activeRaw.id) }) : await repo.listContingencyBatchLines();
  const events = await repo.listDteEventsByType("CONTINGENCIA");
  const periods = periodsRaw.map(contingencyPeriodView);
  const active = activeRaw ? contingencyPeriodView(activeRaw) : null;
  const countPeriodStatus = (status: string) => periods.filter((period) => period.status === status).length;
  return {
    active,
    pendingDocuments,
    batches,
    batchLines,
    periods,
    events,
    audit: active ? await repo.listAudit("contingency_period", String(active.id)) : [],
    summary: {
      pending: pendingDocuments.length,
      open: countPeriodStatus("OPEN"),
      eventAccepted: countPeriodStatus("EVENT_ACCEPTED"),
      closed: countPeriodStatus("CLOSED"),
      failed: countPeriodStatus("FAILED"),
      eventsAccepted: events.filter((event) => event.status === "ACCEPTED").length,
      eventsRejected: events.filter((event) => event.status === "REJECTED").length,
      batches: batches.length,
      batchAccepted: batchLines.filter((line) => line.status === "ACCEPTED").length,
      batchRejected: batchLines.filter((line) => line.status === "REJECTED" || line.status === "MANUAL_REVIEW").length,
      batchPending: batchLines.filter((line) => !["ACCEPTED", "REJECTED", "MANUAL_REVIEW"].includes(String(line.status))).length
    }
  };
}

function contingencyPeriodView(period: Record<string, unknown>): Record<string, unknown> {
  const endedAt = typeof period.ended_at === "string" ? period.ended_at : null;
  return {
    ...period,
    tipo_contingencia: Number(period.tipo_contingencia ?? 1),
    event_deadline_at: endedAt ? addHours(endedAt, 24) : null
  };
}

function advancedCdeWompiPayload(
  document: Record<string, unknown>,
  summary: ReturnType<typeof cdeDocumentSummary>
): WompiWebhook {
  const receptor = isRecord(document.receptor) ? document.receptor : {};
  const direccion = isRecord(receptor.direccion) ? receptor.direccion : {};
  const firstItem = Array.isArray(document.cuerpoDocumento) && isRecord(document.cuerpoDocumento[0]) ? document.cuerpoDocumento[0] : {};
  return {
    IdCuenta: "example-worker-advanced",
    FechaTransaccion: new Date().toISOString(),
    Monto: (summary.amountCents / 100).toFixed(2),
    IdTransaccion: `ADV-${crypto.randomUUID()}`,
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: "ADVANCED",
    IdIntentoPago: crypto.randomUUID(),
    Cantidad: numberValue(firstItem.cantidad, 1),
    EsProductiva: summary.environment === "01",
    Aplicativo: {
      Nombre: "DiezmosSV DTE Avanzado",
      Url: "https://worker.example.invalid/",
      Id: "example-worker-advanced"
    },
    EnlacePago: {
      Id: 1,
      IdentificadorEnlaceComercio: "DTE Avanzado",
      NombreProducto: stringValue(firstItem.descripcion) ?? "DTE avanzado",
      DescripcionProducto: "Generación avanzada desde panel"
    },
    Cliente: {
      DocumentoIdentidad: stringValue(receptor.numDocumento) ?? "SIN-DOCUMENTO",
      Nombre: summary.donorName ?? "Donante",
      Apellidos: "",
      Direccion: stringValue(direccion.complemento) ?? "",
      EMail: summary.donorEmail ?? "",
      Celular: stringValue(receptor.telefono) ?? "",
      CodigoPais: stringValue(receptor.codPais) ?? "SV"
    },
    EsInternacional: stringValue(receptor.codPais) !== "SV",
    IdExterno: summary.codigoGeneracion
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mhRejectionMessage(result: MhResponse): string {
  const raw = isRecord(result.raw) ? result.raw : {};
  const code = typeof raw.codigoMsg === "string" ? raw.codigoMsg : "";
  const description = typeof raw.descripcionMsg === "string" ? raw.descripcionMsg : "";
  const rawMessage = [code, description].filter(Boolean).join(": ");
  if (rawMessage) {
    return rawMessage;
  }
  if (result.observaciones.length > 0) {
    return result.observaciones.join("; ");
  }
  return result.estado || "Invalidación rechazada por MH";
}

function isRetryableDocumentStatus(status: string): boolean {
  return ["SIGNED", "REJECTED", "FAILED", "CONTINGENCY_PENDING"].includes(status);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function handleCredentialsRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null): Promise<Response> {
  const actor = requireRole(user, "OWNER");
  if (request.method === "GET") {
    return jsonResponse({ credentials: credentialStatus(env) });
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const input = (await request.json()) as CredentialUpdateInput;
  if (input.environment !== "test" && input.environment !== "production") {
    return jsonResponse({ error: "invalid_credential_environment" }, { status: 400 });
  }
  const patch = buildCredentialSecretPatch(input);
  if (Object.keys(patch).length === 0) {
    return jsonResponse({ error: "no_credentials_supplied" }, { status: 400 });
  }
  try {
    const result = await patchCloudflareWorkerSecrets(env, patch);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "CREDENTIALS_UPDATED",
      entityType: "credentials",
      entityId: input.environment,
      summary: input.environment === "production" ? "Secretos de producción actualizados" : "Secretos de pruebas actualizados",
      metadata: { updated: result.updated, deleted: result.deleted }
    });
    return jsonResponse({ ok: true, updated: result.updated, deleted: result.deleted });
  } catch (error) {
    if (error instanceof CredentialWriterConfigError) {
      return jsonResponse({ error: "credential_writer_not_configured", message: error.message }, { status: 503 });
    }
    return jsonResponse({ error: "credential_update_failed", message: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

async function handleCredentialWriterTokenRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null): Promise<Response> {
  const actor = requireRole(user, "OWNER");
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return jsonResponse({ error: "cloudflare_token_required", message: "Ingrese el token API de Cloudflare." }, { status: 400 });
  }
  try {
    const result = await bootstrapCloudflareWriterToken(env, token);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "CLOUDFLARE_WRITER_ENABLED",
      entityType: "credentials",
      entityId: env.CLOUDFLARE_SCRIPT_NAME ?? "worker",
      summary: "Edición de secretos desde UI habilitada",
      metadata: { updated: result.updated }
    });
    return jsonResponse({ ok: true, updated: result.updated, credentials: credentialStatus({ ...env, CLOUDFLARE_API_TOKEN: token }) });
  } catch (error) {
    if (error instanceof CredentialWriterConfigError) {
      return jsonResponse({ error: "credential_writer_not_configured", message: error.message }, { status: 503 });
    }
    return jsonResponse({ error: "cloudflare_token_rejected", message: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

async function handleDocumentRoute(
  request: Request,
  env: Env,
  repo: Repository,
  user: AuthUser | null,
  documentId: string,
  action?: string
): Promise<Response> {
  const document = await repo.getDteDocument(documentId);
  if (!document) {
    return notFound();
  }

  if (!action && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ document, audit: await repo.listAudit("dte_document", document.id) });
  }

  if (action === "pdf" && request.method === "GET") {
    requireRole(user, "VIEWER");
    const pdf = await renderDtePdf(document);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.pdf"`
      }
    });
  }

  if (action === "json" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return new Response(document.plain_json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.json"`
      }
    });
  }

  if (action === "email" && request.method === "PATCH") {
    const actor = requireRole(user, "OPERATOR");
    const body = (await request.json()) as { email?: string };
    const email = normalizeEmail(body.email);
    if (!email) {
      return jsonResponse({ error: "invalid_email", message: "Ingrese un correo válido." }, { status: 400 });
    }
    await repo.updateDocumentDonorEmail(document.id, email);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "DTE_EMAIL_UPDATED",
      entityType: "dte_document",
      entityId: document.id,
      summary: `Correo de envío actualizado a ${email}`,
      metadata: { previousEmail: document.donor_email, email }
    });
    return jsonResponse({ document: await repo.getDteDocument(document.id) });
  }

  if (action === "resend" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const toEmail = body.email ?? document.donor_email;
    if (!toEmail) {
      return jsonResponse({ error: "missing_email" }, { status: 400 });
    }
    try {
      const response = await new EmailService(env).sendReceipt(document, toEmail);
      await repo.recordEmailDelivery({ documentId: document.id, toEmail, status: "SENT", providerResponse: response });
      await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "EMAIL_RESENT", entityType: "dte_document", entityId: document.id, summary: `Reenviado a ${toEmail}`, metadata: response });
      return jsonResponse({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repo.recordEmailDelivery({ documentId: document.id, toEmail, status: "FAILED", providerResponse: { error: message } });
      await repo.createAudit({
        actorType: "USER",
        actorId: actor.id,
        action: "EMAIL_RESEND_FAILED",
        entityType: "dte_document",
        entityId: document.id,
        summary: message,
        metadata: { toEmail }
      });
      return jsonResponse({ error: "email_send_failed", message }, { status: 502 });
    }
  }

  if (action === "retry" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (!isRetryableDocumentStatus(document.status)) {
      return jsonResponse(
        {
          error: "document_not_retryable",
          message: "Este DTE no tiene fallos pendientes para reintentar."
        },
        { status: 409 }
      );
    }
    if (!document.signed_jws) {
      await env.ISSUANCE_QUEUE.send({ wompiEventId: document.wompi_event_id });
      await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRY_ENQUEUED", entityType: "dte_document", entityId: document.id, summary: "Reintento en cola" });
      return jsonResponse({ ok: true, queued: true });
    }
    const result = await new MhClient(env).transmitDte({
      ambiente: document.environment,
      version: 2,
      tipoDte: document.tipo_dte,
      codigoGeneracion: document.codigo_generacion,
      signedJws: document.signed_jws
    });
    await repo.updateDocumentMhResult(document.id, {
      status: result.accepted ? "ACCEPTED" : "REJECTED",
      sello: result.selloRecibido,
      mhEstado: result.estado,
      observaciones: result.observaciones,
      acceptedAt: result.accepted ? nowIso() : null
    });
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRIED", entityType: "dte_document", entityId: document.id, summary: result.estado, metadata: result.raw });
    return jsonResponse({ ok: true, result });
  }

  if (action === "invalidate" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (document.status !== "ACCEPTED" || !document.sello_recibido || !document.accepted_at) {
      return jsonResponse({ error: "document_not_accepted" }, { status: 409 });
    }
    const deadline = cdeInvalidationDeadline(document.accepted_at);
    if (!isWithinDeadline(deadline)) {
      return jsonResponse({ error: "outside_legal_window", deadline }, { status: 409 });
    }
    const body = (await request.json()) as Partial<InvalidationInput>;
    if (body.tipoAnulacion === 1 && !body.codigoGeneracionR) {
      return jsonResponse({ error: "replacement_required_for_tipo_1" }, { status: 400 });
    }
    const config = getEmisorConfig(env);
    const input: InvalidationInput = {
      tipoAnulacion: body.tipoAnulacion ?? 2,
      motivoAnulacion: body.motivoAnulacion ?? "Invalidación solicitada por operador",
      nombreResponsable: body.nombreResponsable ?? config.responsable.nombre,
      tipDocResponsable: body.tipDocResponsable ?? config.responsable.tipoDocumento,
      numDocResponsable: body.numDocResponsable ?? config.responsable.numeroDocumento,
      nombreSolicita: body.nombreSolicita ?? actor.name,
      tipDocSolicita: body.tipDocSolicita ?? config.responsable.tipoDocumento,
      numDocSolicita: body.numDocSolicita ?? config.responsable.numeroDocumento,
      codigoGeneracionR: body.codigoGeneracionR ?? null
    };
    const eventDocument = buildInvalidacionEvent(document, config, input);
    const signedJws = await signMhDocument(eventDocument, getMhCertificateXml(env), requireSecret(env, "MH_CERT_PASSWORD"));
    const eventId = await repo.createDteEvent({
      documentId: document.id,
      eventType: "INVALIDACION",
      environment: document.environment,
      codigoGeneracion: (eventDocument.identificacion as { codigoGeneracion: string }).codigoGeneracion,
      plainJson: eventDocument,
      signedJws,
      legalDeadlineAt: deadline,
      createdBy: actor.id
    });
    const result = await new MhClient(env).transmitInvalidacion({ ambiente: document.environment, version: 3, signedJws });
    await repo.updateDteEventResult(eventId, {
      status: result.accepted ? "ACCEPTED" : "REJECTED",
      sello: result.selloRecibido,
      mhEstado: result.estado,
      observaciones: result.observaciones,
      acceptedAt: result.accepted ? nowIso() : null
    });
    if (result.accepted) {
      await repo.markDocumentInvalidated(document.id);
    }
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: result.accepted ? "DTE_INVALIDATED" : "DTE_INVALIDATION_REJECTED",
      entityType: "dte_document",
      entityId: document.id,
      summary: result.estado,
      metadata: result.raw
    });
    const responseBody = { accepted: result.accepted, eventId, deadline, result };
    if (!result.accepted) {
      return jsonResponse(
        {
          ...responseBody,
          error: "invalidation_rejected",
          message: mhRejectionMessage(result)
        },
        { status: 409 }
      );
    }
    return jsonResponse(responseBody);
  }

  return methodNotAllowed();
}

async function f960Selection(repo: Repository, url: URL): Promise<F960Selection | Response> {
  try {
    return buildF960Selection(await repo.listAcceptedDteDocumentsForExport(), {
      period: url.searchParams.get("period"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate")
    });
  } catch (error) {
    return jsonResponse({ error: "invalid_export_filter", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function auditExport(repo: Repository, actor: AuthUser, action: string, filename: string, rowCount: number): Promise<void> {
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action,
    entityType: "export",
    entityId: filename,
    summary: `${rowCount} filas exportadas`
  });
}

function hasValidBootstrapOwnerToken(request: Request, env: Env): boolean {
  const expected = env.BOOTSTRAP_OWNER_TOKEN?.trim();
  const supplied = request.headers.get(BOOTSTRAP_OWNER_TOKEN_HEADER)?.trim();
  return Boolean(expected && supplied && timingSafeEqual(supplied, expected));
}
