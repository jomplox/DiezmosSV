import { getEmisorConfig, getMhCertificateXml, requireSecret } from "./config";
import { buildInvalidacionEvent, type InvalidationInput } from "./domain/dteBuilder";
import { signMhDocument } from "./domain/signer";
import { buildTestWompiPayload, type TestWompiInput } from "./domain/testWompi";
import { ambienteFromWompi, isApprovedDonation, verifyWompiHash, wompiHashHeader } from "./domain/wompi";
import { AuthError, AuthService, requireRole, type AuthUser, type Role } from "./services/auth";
import { EmailService } from "./services/email";
import { MhClient } from "./services/mhClient";
import { IssuancePipeline } from "./services/pipeline";
import { renderDtePdf } from "./services/pdf";
import { Repository } from "./storage/repository";
import type { Env, IssuanceMessage, WompiWebhook } from "./types";
import { cdeInvalidationDeadline, isWithinDeadline, nowIso } from "./utils/dates";
import { jsonResponse, methodNotAllowed, notFound } from "./utils/http";

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
        await pipeline.processWompiEvent(message.body.wompiEventId);
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
  const payload = JSON.parse(rawBody) as WompiWebhook;
  const repo = new Repository(env.DB);
  const environment = ambienteFromWompi(payload);
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
    return jsonResponse({ contingency: await repo.getOpenContingency() });
  }

  if (url.pathname === "/api/contingency/sweep" && request.method === "POST") {
    requireRole(user, "OPERATOR");
    return jsonResponse(await new IssuancePipeline(env).runContingencySweep());
  }

  if (url.pathname === "/api/test/dte" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if ((env.APP_ENV ?? "local").toLowerCase() === "production") {
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
    const environment = ambienteFromWompi(payload);
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

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === "PATCH") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json()) as { role?: string; disabled?: boolean; name?: string };
    await repo.updateUser(userMatch[1], body);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_UPDATED", entityType: "user", entityId: userMatch[1], summary: "User updated", metadata: body });
    return jsonResponse({ ok: true });
  }

  return notFound();
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
    return new Response(document.signed_jws ?? document.plain_json, {
      headers: {
        "Content-Type": document.signed_jws ? "application/jose" : "application/json",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.json"`
      }
    });
  }

  if (action === "resend" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const toEmail = body.email ?? document.donor_email;
    if (!toEmail) {
      return jsonResponse({ error: "missing_email" }, { status: 400 });
    }
    const response = await new EmailService(env).sendReceipt(document, toEmail);
    await repo.recordEmailDelivery({ documentId: document.id, toEmail, status: "SENT", providerResponse: response });
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "EMAIL_RESENT", entityType: "dte_document", entityId: document.id, summary: `Resent to ${toEmail}`, metadata: response });
    return jsonResponse({ ok: true });
  }

  if (action === "retry" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (!document.signed_jws) {
      await env.ISSUANCE_QUEUE.send({ wompiEventId: document.wompi_event_id });
      await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRY_ENQUEUED", entityType: "dte_document", entityId: document.id, summary: "Retry queued" });
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
      motivoAnulacion: body.motivoAnulacion ?? "Invalidacion solicitada por operador",
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
    return jsonResponse({ accepted: result.accepted, eventId, deadline, result });
  }

  return methodNotAllowed();
}
