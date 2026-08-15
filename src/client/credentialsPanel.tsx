import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Copy,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Palette,
  RefreshCw,
  ShieldCheck,
  Upload,
  X
} from "lucide-react";
import { type FormEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  STRIPE_US_LEGAL_NAME_MAX_LENGTH,
  STRIPE_US_MAILING_ADDRESS_LINE_MAX_LENGTH,
  STRIPE_US_SIGNER_NAME_MAX_LENGTH,
  STRIPE_US_SIGNER_TITLE_MAX_LENGTH,
  STRIPE_US_TIME_ZONE_OPTIONS,
  STRIPE_US_WEBSITE_MAX_LENGTH
} from "../shared/stripeUsConfiguration";
import type {
  CredentialStatus,
  CredentialStatusItem,
  EmailSenderState,
  EmailTemplateScope,
  EmailTemplateSettings,
  EmailTemplateValue,
  EmissionEnvironmentState,
  StripeAcknowledgmentReconciliationItem,
  StripeSettingsState,
  WompiNotificationSettings
} from "./types";
import {
  type Branding,
  BRANDING_LOGO_ACCEPT,
  BRANDING_LOGO_MAX_BYTES,
  brandingDonorLogoSrc,
  brandingFieldError,
  brandingLogoSrc
} from "./branding";
import {
  certificateExpiryStatus,
  credentialSectionState,
  type CredentialSettingsSectionId,
  credentialSettingsSections
} from "./credentialSettings";
import { environmentLabel, userFacingErrorMessage } from "./displayText";
import {
  CAT012_DEPARTMENTS,
  CAT014_UNITS,
  CAT017_PAYMENT_FORMS,
  CAT019_ACTIVITIES,
  CAT020_COUNTRIES,
  CAT022_DOCUMENT_TYPES,
  CAT022_ISSUER_DOCUMENT_TYPES,
  CAT026_DONATION_TYPES,
  findCatalogOption,
  getCat008Districts,
  getCat013Municipalities
} from "../shared/catalogs";
import {
  api,
  CatalogSelect,
  catalogSelectValue,
  type CredentialFormInput,
  credentialSettingsSectionIcons,
  type IssuerConfigFormInput,
  issuerConfigJsonFromForm,
  issuerFormFromConfigJson,
  useDialogDismiss
} from "./App";

export function CredentialsPanel({
  status,
  stripeSettings,
  stripeRotationStatusStale,
  stripeAcknowledgmentReconciliation,
  emissionEnvironment,
  emailTemplates,
  emailTemplateDraft,
  emailSender,
  emailSenderDraft,
  emailReplyToDraft,
  wompiNotificationsDraft,
  alertEmailDraft,
  branding,
  token,
  input,
  busy,
  emissionBusy,
  templateBusy,
  emailSenderBusy,
  wompiNotificationsBusy,
  alertEmailBusy,
  writerBusy,
  stripeBusy,
  onChange,
  onSubmit,
  onStripeSubmit,
  onStripeWebhookStage,
  onStripeWebhookPromote,
  onStripeWebhookCancel,
  onStripeAcknowledgmentReconcile,
  onEmailTemplateChange,
  onEmailTemplateSubmit,
  onEmailSenderChange,
  onEmailReplyToChange,
  onEmailSenderSubmit,
  onWompiNotificationsChange,
  onWompiNotificationsSubmit,
  onEmissionEnvironmentChange,
  onAlertEmailChange,
  onAlertEmailSubmit,
  onBrandingSave,
  onBootstrapWriter,
  runAccountOperation,
  onRefresh
}: {
  status: CredentialStatus | null;
  stripeSettings: StripeSettingsState | null;
  stripeRotationStatusStale: boolean;
  stripeAcknowledgmentReconciliation: StripeAcknowledgmentReconciliationItem[];
  emissionEnvironment: EmissionEnvironmentState | null;
  emailTemplates: EmailTemplateSettings | null;
  emailTemplateDraft: Record<string, EmailTemplateValue>;
  emailSender: EmailSenderState | null;
  emailSenderDraft: string;
  emailReplyToDraft: string;
  wompiNotificationsDraft: WompiNotificationSettings;
  alertEmailDraft: string;
  branding: Branding;
  token: string;
  input: CredentialFormInput;
  busy: boolean;
  emissionBusy: boolean;
  templateBusy: boolean;
  emailSenderBusy: boolean;
  wompiNotificationsBusy: boolean;
  alertEmailBusy: boolean;
  writerBusy: boolean;
  stripeBusy: boolean;
  onChange: (input: CredentialFormInput) => void;
  onSubmit: () => Promise<void>;
  onStripeSubmit: () => Promise<void>;
  onStripeWebhookStage: () => Promise<void>;
  onStripeWebhookPromote: () => Promise<void>;
  onStripeWebhookCancel: () => Promise<void>;
  onStripeAcknowledgmentReconcile: (
    id: string,
    resolution: "CONFIRMED_SENT" | "CONFIRMED_NOT_SENT"
  ) => Promise<void>;
  onEmailTemplateChange: (type: string, patch: Partial<EmailTemplateValue>) => void;
  onEmailTemplateSubmit: (scope: EmailTemplateScope) => Promise<void>;
  onEmailSenderChange: (value: string) => void;
  onEmailReplyToChange: (value: string) => void;
  onEmailSenderSubmit: () => Promise<void>;
  onWompiNotificationsChange: (value: WompiNotificationSettings) => void;
  onWompiNotificationsSubmit: () => Promise<void>;
  onEmissionEnvironmentChange: (environment: EmissionEnvironmentState["environment"]) => Promise<void>;
  onAlertEmailChange: (value: string) => void;
  onAlertEmailSubmit: () => Promise<void>;
  onBrandingSave: (next: Branding) => void;
  onBootstrapWriter: (cloudflareToken: string) => Promise<boolean>;
  runAccountOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  onRefresh: () => Promise<void>;
}) {
  const groups = status ? Object.entries(status.groups) : [];
  const mhUserSecret = input.environment === "test" ? "MH_USER_TEST" : "MH_USER_PROD";
  const mhPasswordSecret = input.environment === "test" ? "MH_PASSWORD_TEST" : "MH_PASSWORD_PROD";
  const activeMhGroup = input.environment === "test" ? status?.groups.mhTest : status?.groups.mhProduction;
  const webhookUrl = typeof window === "undefined" ? "/webhooks/wompi" : new URL("/webhooks/wompi", window.location.origin).toString();
  const stripeWebhookUrl = typeof window === "undefined" ? "/webhooks/stripe" : new URL("/webhooks/stripe", window.location.origin).toString();
  const writerConfigured = status?.target.writerConfigured === true;
  const writerMissing = status?.target.writerMissing ?? [];
  const writerNeedsOnlyToken = writerMissing.length === 1 && writerMissing[0] === "CLOUDFLARE_API_TOKEN";
  const signerConfigured = credentialConfigured(status, "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2");
  const certificateExpiry = certificateExpiryStatus(status?.certificateExpiresAt ?? null);
  const [certificateFileError, setCertificateFileError] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [stripeWebhookCopied, setStripeWebhookCopied] = useState(false);
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
  const testEnvironmentAllowed = emissionEnvironment?.allowedEnvironments.includes("00") === true;
  const productionEnvironmentAllowed = emissionEnvironment?.allowedEnvironments.includes("01") === true;
  const activeSectionMeta = credentialSettingsSections.find((section) => section.id === activeSection) ?? credentialSettingsSections[0];
  const activeSectionDescription = credentialSettingsPanelDescription(activeSection, activeEnvironmentLabel);
  async function handleCertificateFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const text = await runAccountOperation(() => file.text());
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
  async function copyStripeWebhookUrl(): Promise<void> {
    try {
      await copyText(stripeWebhookUrl);
      setStripeWebhookCopied(true);
      window.setTimeout(() => setStripeWebhookCopied(false), 1600);
    } catch {
      setStripeWebhookCopied(false);
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
    // Short-circuit only while busy or when the selected value is ALREADY persisted as a
    // setting row (a genuinely redundant save). A value that merely matches the deployment
    // default with no setting row yet must still reach the confirm flow so the owner can
    // persist the default explicitly — guarding on runtimeEnvironment.environment blocked that.
    if (
      emissionBusy ||
      !emissionEnvironment?.allowedEnvironments.includes(environment) ||
      (emissionEnvironment.environment === environment && emissionEnvironment.source === "setting")
    ) return;
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
                  {sectionState !== "unknown" && (
                    <em className={sectionState}>{sectionState === "ready" ? "Listo" : "Pendiente"}</em>
                  )}
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
            ) : activeSection === "marca" ? (
              <BrandingEditor branding={branding} token={token} onSave={onBrandingSave} runAccountOperation={runAccountOperation} />
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
                          disabled={emissionBusy || !testEnvironmentAllowed}
                          onClick={() => requestEmissionEnvironmentChange("00")}
                        >
                          Pruebas 00
                        </button>
                        <button
                          type="button"
                          className={runtimeEnvironment.environment === "01" ? "active" : ""}
                          disabled={emissionBusy || !productionEnvironmentAllowed}
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
                      <button type="button" disabled={!testEnvironmentAllowed} className={input.environment === "test" ? "active" : ""} onClick={() => onChange({ ...input, environment: "test" })}>Pruebas 00</button>
                      <button type="button" disabled={!productionEnvironmentAllowed} className={input.environment === "production" ? "active" : ""} onClick={() => onChange({ ...input, environment: "production" })}>Producción 01</button>
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
                      <button type="button" disabled={!testEnvironmentAllowed} className={input.environment === "test" ? "active" : ""} onClick={() => onChange({ ...input, environment: "test" })}>Pruebas 00</button>
                      <button type="button" disabled={!productionEnvironmentAllowed} className={input.environment === "production" ? "active" : ""} onClick={() => onChange({ ...input, environment: "production" })}>Producción 01</button>
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
                        <small>Contraseña del archivo de firma; es distinta de la contraseña API usada para autenticarse contra Hacienda.</small>
                      </label>
                    </div>
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
                    <div className="credential-section-title span-2">
                      <h3>Avisos de entregas exitosas</h3>
                      <p>Estos valores se incorporan a cada enlace nuevo que genere la aplicación.</p>
                    </div>
                    <label>
                      <span className="plain-field-label">Correos para notificaciones exitosas de Wompi</span>
                      <input
                        value={wompiNotificationsDraft.emailsNotificacion}
                        onChange={(event) => onWompiNotificationsChange({
                          ...wompiNotificationsDraft,
                          emailsNotificacion: event.target.value
                        })}
                        placeholder="tesoreria@example.org, avisos@example.org"
                        type="email"
                        multiple
                      />
                      <small>Wompi enviará avisos operativos a estos correos. Sepárelos con una coma.</small>
                    </label>
                    <label>
                      <span className="plain-field-label">Celulares para SMS exitosos de Wompi</span>
                      <input
                        value={wompiNotificationsDraft.telefonosNotificacion}
                        onChange={(event) => onWompiNotificationsChange({
                          ...wompiNotificationsDraft,
                          telefonosNotificacion: event.target.value
                        })}
                        placeholder="70000000, +50371234567"
                        type="text"
                        inputMode="tel"
                      />
                      <small>Use números móviles de 8 a 15 dígitos; el código de país es opcional.</small>
                    </label>
                    <label className="span-2 wompi-notification-toggle">
                      <input
                        checked={wompiNotificationsDraft.notificarTransaccionCliente}
                        onChange={(event) => onWompiNotificationsChange({
                          ...wompiNotificationsDraft,
                          notificarTransaccionCliente: event.target.checked
                        })}
                        type="checkbox"
                      />
                      <span>Enviar también el correo de Wompi al donante</span>
                    </label>
                    <small className="span-2">
                      Si activa esta opción, el donante recibirá el aviso de Wompi además del correo con su CDE. Los enlaces ya creados no cambian.
                    </small>
                    <button
                      className="primary span-2"
                      type="button"
                      disabled={wompiNotificationsBusy}
                      onClick={() => void onWompiNotificationsSubmit()}
                    >
                      {wompiNotificationsBusy ? "Guardando" : "Guardar notificaciones de Wompi"}
                    </button>
                  </div>
                )}

                {activeSection === "stripe" && (
                  <div className="credential-fields stripe-settings-fields">
                    <div className="credential-section-title span-2">
                      <h3>Configuración operativa de Stripe EE. UU.</h3>
                      <p>La presencia indica Configurado; no prueba que el valor pertenezca a la cuenta correcta de Stripe.</p>
                    </div>
                    <div className="stripe-status-grid span-2">
                      <div><span>APP_ENV</span><strong>{stripeSettings?.operational.appEnv ?? "Sin cargar"}</strong></div>
                      <div><span>Modo Stripe</span><strong>{stripeSettings?.operational.mode ?? "Sin cargar"}</strong></div>
                      <div><span>Proxy local</span><strong>{stripeSettings ? (stripeSettings.operational.localProxyConfigured ? "Configurado" : "No configurado") : "Sin cargar"}</strong></div>
                    </div>
                    <div className="credential-field-block span-2">
                      <span className="plain-field-label">URL del webhook de Stripe</span>
                      <div className="credential-readonly-row">
                        <div className="credential-readonly-endpoint"><code>{stripeWebhookUrl}</code></div>
                        <button className="endpoint-copy-button" type="button" onClick={() => void copyStripeWebhookUrl()} title="Copiar URL del webhook de Stripe">
                          <Copy size={15} />{stripeWebhookCopied ? "Copiado" : "Copiar"}
                        </button>
                      </div>
                    </div>
                    <div className="credential-field-block span-2 stripe-webhook-health">
                      <span className="plain-field-label">Salud observada del webhook</span>
                      {stripeSettings?.webhookHealth.state === "observed" ? (
                        <div>
                          <strong>{stripeSettings.webhookHealth.verifiedByProcessedEvent ? "Verificado por último evento procesado" : "Evento observado sin verificación completa"}</strong>
                          <small>Último evento: {stripeSettings.webhookHealth.eventType} · {stripeSettings.webhookHealth.processingStatus} · {stripeSettings.webhookHealth.lastReceivedAt}</small>
                          <small>Modo del evento: {stripeSettings.webhookHealth.livemodeMatches ? "coincide con el despliegue" : "no coincide con el despliegue"}</small>
                        </div>
                      ) : <strong>Sin eventos recibidos</strong>}
                    </div>
                    <div className="credential-field-block span-2">
                      <div className="credential-section-title">
                        <h3>Constancias inmediatas</h3>
                        <p>Requiere conciliación cuando no se pudo confirmar el resultado del proveedor.</p>
                      </div>
                      {stripeAcknowledgmentReconciliation.length === 0 ? (
                        <small>No hay constancias pendientes de conciliación.</small>
                      ) : stripeAcknowledgmentReconciliation.map((acknowledgment) => (
                        <div className="legal-box" key={acknowledgment.id}>
                          <AlertTriangle size={17} />
                          <div>
                            <strong>
                              Revisión {acknowledgment.revision} · {acknowledgment.kind === "FULL_REFUND"
                                ? "Reembolso total"
                                : acknowledgment.kind === "PARTIAL_REFUND"
                                  ? "Corrección por reembolso"
                                  : "Constancia original"}
                            </strong>
                            <small>
                              Estado {acknowledgment.status} · código {acknowledgment.failureCode} · neto ${(acknowledgment.netAmountCents / 100).toFixed(2)} USD
                            </small>
                            <div className="stripe-rotation-actions">
                              <button
                                className="primary"
                                type="button"
                                disabled={stripeBusy}
                                onClick={() => void onStripeAcknowledgmentReconcile(
                                  acknowledgment.id,
                                  "CONFIRMED_SENT"
                                )}
                              >
                                Confirmar que se envió
                              </button>
                              <button
                                className="secondary"
                                type="button"
                                disabled={stripeBusy}
                                onClick={() => void onStripeAcknowledgmentReconcile(
                                  acknowledgment.id,
                                  "CONFIRMED_NOT_SENT"
                                )}
                              >
                                Confirmar que no se envió
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <small className="span-2">Las credenciales y secretos de reemplazo nunca se precargan y se limpian después de guardarse.</small>
                    <label>
                      <CredentialFieldLabel label="Clave restringida" configured={credentialConfigured(status, "STRIPE_RESTRICTED_KEY")} />
                      <CredentialActiveValue status={status} name="STRIPE_RESTRICTED_KEY" />
                      <input type="password" autoComplete="new-password" value={input.stripeRestrictedKey} onChange={(event) => onChange({ ...input, stripeRestrictedKey: event.target.value })} placeholder="rk_test_… o rk_live_…" />
                    </label>
                    <label>
                      <CredentialFieldLabel label="Clave publicable" configured={credentialConfigured(status, "STRIPE_PUBLISHABLE_KEY")} />
                      <CredentialActiveValue status={status} name="STRIPE_PUBLISHABLE_KEY" />
                      <input type="password" autoComplete="new-password" value={input.stripePublishableKey} onChange={(event) => onChange({ ...input, stripePublishableKey: event.target.value })} placeholder="pk_test_… o pk_live_…" />
                    </label>
                    <label>
                      <CredentialFieldLabel label="Configuración de métodos de entrega" configured={credentialConfigured(status, "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID")} />
                      <CredentialActiveValue status={status} name="STRIPE_PAYMENT_METHOD_CONFIGURATION_ID" />
                      <input type="password" autoComplete="new-password" value={input.stripePaymentMethodConfigurationId} onChange={(event) => onChange({ ...input, stripePaymentMethodConfigurationId: event.target.value })} placeholder="pmc_…" />
                      <small>No verificado por la aplicación.</small>
                    </label>
                    <label>
                      <CredentialFieldLabel label="Configuración del portal" configured={credentialConfigured(status, "STRIPE_BILLING_PORTAL_CONFIGURATION_ID")} />
                      <CredentialActiveValue status={status} name="STRIPE_BILLING_PORTAL_CONFIGURATION_ID" />
                      <input type="password" autoComplete="new-password" value={input.stripeBillingPortalConfigurationId} onChange={(event) => onChange({ ...input, stripeBillingPortalConfigurationId: event.target.value })} placeholder="bpc_…" />
                      <small>No verificado por la aplicación.</small>
                    </label>
                    <label>
                      <CredentialFieldLabel label="Nombre legal" configured={credentialConfigured(status, "STRIPE_US_LEGAL_NAME")} />
                      <input type="text" autoComplete="off" maxLength={STRIPE_US_LEGAL_NAME_MAX_LENGTH} value={input.stripeLegalName} onChange={(event) => onChange({ ...input, stripeLegalName: event.target.value })} />
                    </label>
                    <label>
                      <CredentialFieldLabel label="EIN" configured={credentialConfigured(status, "STRIPE_US_EIN")} />
                      <input type="text" autoComplete="off" inputMode="numeric" value={input.stripeEin} onChange={(event) => onChange({ ...input, stripeEin: event.target.value })} placeholder="12-3456789" />
                    </label>
                    <label className="span-2">
                      <CredentialFieldLabel label="Zona horaria" configured={credentialConfigured(status, "STRIPE_US_TIME_ZONE")} />
                      <select value={input.stripeTimeZone} onChange={(event) => onChange({ ...input, stripeTimeZone: event.target.value })}>
                        <option value="">Seleccione una zona horaria</option>
                        {input.stripeTimeZone && !STRIPE_US_TIME_ZONE_OPTIONS.some((option) => option.value === input.stripeTimeZone) && (
                          <option value={input.stripeTimeZone}>Actual — {input.stripeTimeZone}</option>
                        )}
                        {STRIPE_US_TIME_ZONE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <CredentialFieldLabel label="Teléfono de la organización" configured={credentialConfigured(status, "STRIPE_US_PHONE")} />
                      <input type="tel" autoComplete="off" value={input.stripeOrganizationPhone} onChange={(event) => onChange({ ...input, stripeOrganizationPhone: event.target.value })} placeholder="+1 (000) 000-0000" />
                    </label>
                    <label>
                      <CredentialFieldLabel label="Sitio web" configured={credentialConfigured(status, "STRIPE_US_WEBSITE")} />
                      <input type="url" autoComplete="off" maxLength={STRIPE_US_WEBSITE_MAX_LENGTH} value={input.stripeOrganizationWebsite} onChange={(event) => onChange({ ...input, stripeOrganizationWebsite: event.target.value })} placeholder="https://example.org" />
                    </label>
                    <label className="span-2">
                      <CredentialFieldLabel label="Dirección postal" configured={credentialConfigured(status, "STRIPE_US_MAILING_ADDRESS")} />
                      <textarea value={input.stripeOrganizationMailingAddress} onChange={(event) => onChange({ ...input, stripeOrganizationMailingAddress: event.target.value })} placeholder={"Calle y número\nCiudad, estado, código postal, EE. UU."} rows={4} />
                      <small>Use de 2 a 4 renglones, con hasta {STRIPE_US_MAILING_ADDRESS_LINE_MAX_LENGTH} caracteres por renglón.</small>
                    </label>
                    <label>
                      <CredentialFieldLabel label="Nombre del firmante autorizado" configured={credentialConfigured(status, "STRIPE_US_SIGNER_NAME")} />
                      <input type="text" autoComplete="off" maxLength={STRIPE_US_SIGNER_NAME_MAX_LENGTH} value={input.stripeSignerName} onChange={(event) => onChange({ ...input, stripeSignerName: event.target.value })} />
                    </label>
                    <label>
                      <CredentialFieldLabel label="Cargo del firmante autorizado" configured={credentialConfigured(status, "STRIPE_US_SIGNER_TITLE")} />
                      <input type="text" autoComplete="off" maxLength={STRIPE_US_SIGNER_TITLE_MAX_LENGTH} value={input.stripeSignerTitle} onChange={(event) => onChange({ ...input, stripeSignerTitle: event.target.value })} placeholder="Treasurer" />
                    </label>
                    <div className="credential-field-block span-2">
                      <CredentialFieldLabel label="Secreto activo del webhook" configured={credentialConfigured(status, "STRIPE_WEBHOOK_SECRET")} />
                      <CredentialActiveValue status={status} name="STRIPE_WEBHOOK_SECRET" />
                      <small>Estado solamente. Para rotarlo, prepare primero el secreto siguiente.</small>
                    </div>
                    <label className="span-2">
                      <CredentialFieldLabel label="Secreto siguiente del webhook" configured={credentialConfigured(status, "STRIPE_WEBHOOK_SECRET_NEXT")} />
                      <CredentialActiveValue status={status} name="STRIPE_WEBHOOK_SECRET_NEXT" />
                      <input name="stripe-webhook-secret-next" type="password" autoComplete="new-password" value={input.stripeWebhookSecretNext} onChange={(event) => onChange({ ...input, stripeWebhookSecretNext: event.target.value })} placeholder="whsec_…" />
                    </label>
                    <div className="stripe-rotation-actions span-2">
                      <button className="secondary" type="button" disabled={stripeBusy || stripeRotationStatusStale || !writerConfigured || !input.stripeWebhookSecretNext.trim()} onClick={() => void onStripeWebhookStage()}>Preparar secreto siguiente</button>
                      {credentialConfigured(status, "STRIPE_WEBHOOK_SECRET_NEXT") && (
                        <>
                          <button className="primary" type="button" disabled={stripeBusy || stripeRotationStatusStale || !writerConfigured} onClick={() => void onStripeWebhookPromote()}>Promover secreto preparado</button>
                          <button className="secondary" type="button" disabled={stripeBusy || stripeRotationStatusStale || !writerConfigured} onClick={() => void onStripeWebhookCancel()}>Cancelar secreto preparado</button>
                        </>
                      )}
                    </div>
                    {stripeRotationStatusStale && (
                      <small className="span-2">Rotación guardada; actualice el estado antes de otra acción.</small>
                    )}
                    <div className="legal-box span-2">
                      <ShieldCheck size={17} />
                      <div>
                        <strong>Métodos elegibles y exclusión de BNPL</strong>
                        <small>Se administran en Stripe Dashboard Payment Method Configuration; este panel no simula interruptores del proveedor.</small>
                      </div>
                    </div>
                    <button className="primary span-2" type="button" disabled={stripeBusy || !writerConfigured} onClick={() => void onStripeSubmit()}>
                      {stripeBusy ? "Guardando" : "Guardar configuración de Stripe"}
                    </button>
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
                    <div className="credential-field-block">
                      <CredentialFieldLabel
                        label="Endpoint HTTPS de respaldo (POST JSON)"
                        configured={credentialConfigured(status, "EMAIL_PROVIDER_URL")}
                      />
                      <CredentialActiveValue
                        status={status}
                        name="EMAIL_PROVIDER_URL"
                      />
                      <small>
                        Administrado por el despliegue. Los propietarios pueden rotar el token
                        bearer y el remitente, pero no cambiar el destino.
                      </small>
                    </div>
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
                        <h3>Remitente visible y respuestas</h3>
                      </div>
                      <label>
                        <span className="plain-field-label">Nombre visible del remitente</span>
                        <input
                          value={emailSenderDraft}
                          onChange={(event) => onEmailSenderChange(event.target.value)}
                          disabled={!emailSender || emailSenderBusy}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void onEmailSenderSubmit();
                            }
                          }}
                          placeholder="Nombre que verán los destinatarios"
                          maxLength={80}
                        />
                        <small>Dirección activa: {emailSender?.senderAddress || "Sin correo remitente configurado"}</small>
                      </label>
                      <label>
                        <span className="plain-field-label">Correo para recibir respuestas (Reply-To)</span>
                        <input
                          value={emailReplyToDraft}
                          onChange={(event) => onEmailReplyToChange(event.target.value)}
                          disabled={!emailSender || emailSenderBusy}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void onEmailSenderSubmit();
                            }
                          }}
                          placeholder="respuestas@example.org"
                          type="email"
                          maxLength={254}
                        />
                        <small>Déjelo vacío para que las respuestas lleguen al correo remitente activo.</small>
                      </label>
                      <button
                        className="primary"
                        type="button"
                        disabled={!emailSender || emailSenderBusy}
                        onClick={() => void onEmailSenderSubmit()}
                      >
                        {emailSenderBusy ? "Guardando" : "Guardar remitente"}
                      </button>
                    </div>
                    <div className="credential-field-block span-2">
                      <div className="credential-section-title">
                        <h3>Alertas operativas</h3>
                      </div>
                      <label>
                        <span className="plain-field-label">Correos para avisos operativos</span>
                        <input
                          value={alertEmailDraft}
                          onChange={(event) => onAlertEmailChange(event.target.value)}
                          placeholder="admin@example.org, soporte@example.org"
                          type="email"
                          multiple
                        />
                        <small>Recibirá avisos de fallos de emisión, contingencias y eventos estancados. Separe varios correos con una sola coma (,).</small>
                      </label>
                      <button
                        className="primary"
                        type="button"
                        disabled={alertEmailBusy}
                        onClick={() => void onAlertEmailSubmit()}
                      >
                        {alertEmailBusy ? "Guardando" : "Guardar correos de alertas"}
                      </button>
                    </div>
                  </div>
                )}

                {activeSection !== "ambiente" && activeSection !== "stripe" && (
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

// The "Marca" (white-label) settings section. OWNER-only, like the other sensitive
// sections. Edits the church name + accent color (color picker synced to a hex field)
// and manages the logo (upload with live preview, current-logo preview, remove). On a
// successful name/color save the accent is live-applied through onSave; the logo save
// bumps the version so every <img src="/api/branding/logo?v="> refreshes.
function BrandingEditor({
  branding,
  token,
  onSave,
  runAccountOperation
}: {
  branding: Branding;
  token: string;
  onSave: (next: Branding) => void;
  runAccountOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  const [displayName, setDisplayName] = useState(branding.displayName);
  const [accentColor, setAccentColor] = useState(branding.accentColor);
  const [supportEmail, setSupportEmail] = useState(branding.supportEmail);
  const [logoVersion, setLogoVersion] = useState(branding.logoVersion);
  const [donorLogoVersion, setDonorLogoVersion] = useState(branding.donorLogoVersion);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [donorLogoBusy, setDonorLogoBusy] = useState(false);
  const [donorLogoError, setDonorLogoError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [donorPreviewUrl, setDonorPreviewUrl] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const donorLogoInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the local color hex normalized for the native color input (which only accepts
  // #rrggbb). A partial/invalid value keeps the picker on the last valid color.
  const colorForPicker = /^#[0-9a-fA-F]{6}$/.test(accentColor.trim()) ? accentColor.trim().toLowerCase() : branding.accentColor;
  const currentLogoSrc = brandingLogoSrc(logoVersion);
  const currentDonorLogoSrc = brandingDonorLogoSrc(donorLogoVersion);

  function draftBranding(overrides: Partial<Branding> = {}): Branding {
    return {
      displayName,
      accentColor,
      supportEmail,
      logoVersion,
      donorLogoVersion,
      ...overrides
    };
  }

  async function saveNameAndColor() {
    const validation = brandingFieldError(displayName, accentColor, supportEmail);
    if (validation) {
      setError(validation);
      setNotice("");
      return;
    }
    setError("");
    setSavingText(true);
    try {
      const result = await runAccountOperation(() =>
        api<{ displayName: string; accentColor: string; supportEmail: string }>("/api/settings/branding", token, {
          method: "PUT",
          body: { displayName: displayName.trim(), accentColor: accentColor.trim().toLowerCase(), supportEmail: supportEmail.trim().toLowerCase() }
        })
      );
      setDisplayName(result.displayName);
      setAccentColor(result.accentColor);
      setSupportEmail(result.supportEmail);
      const next = draftBranding({
        displayName: result.displayName,
        accentColor: result.accentColor,
        supportEmail: result.supportEmail
      });
      onSave(next);
      setNotice("Marca actualizada.");
    } catch (err) {
      setError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingText(false);
    }
  }

  async function uploadLogo(file: File) {
    setLogoError("");
    if (file.size > BRANDING_LOGO_MAX_BYTES) {
      setLogoError("El logo no puede superar los 512 KB.");
      return;
    }
    setLogoBusy(true);
    try {
      const data = await runAccountOperation(async () => {
        const response = await fetch("/api/settings/branding/logo", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type },
          body: file
        });
        const result = (await response.json().catch(() => ({}))) as { logoVersion?: string; message?: string; error?: string };
        if (!response.ok) {
          throw new Error(String(result.message ?? result.error ?? `HTTP ${response.status}`));
        }
        return result;
      });
      const nextVersion = data.logoVersion ?? null;
      setLogoVersion(nextVersion);
      setPreviewUrl(null);
      onSave(draftBranding({ logoVersion: nextVersion }));
      setNotice("Logo de administración y correos actualizado.");
    } catch (err) {
      setLogoError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setLogoBusy(false);
      if (logoInputRef.current) {
        logoInputRef.current.value = "";
      }
    }
  }

  async function removeLogo() {
    setLogoError("");
    setLogoBusy(true);
    try {
      await runAccountOperation(() => api<{ ok: true }>("/api/settings/branding/logo", token, { method: "DELETE" }));
      setLogoVersion(null);
      setPreviewUrl(null);
      onSave(draftBranding({ logoVersion: null }));
      setNotice("Logo de administración y correos eliminado.");
    } catch (err) {
      setLogoError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setLogoBusy(false);
    }
  }

  function onPickFile(file: File | undefined) {
    if (!file) return;
    // Local preview via an object URL, replaced/cleared once the upload resolves.
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    void uploadLogo(file);
  }

  async function uploadDonorLogo(file: File) {
    setDonorLogoError("");
    if (file.size > BRANDING_LOGO_MAX_BYTES) {
      setDonorLogoError("El logo no puede superar los 512 KB.");
      return;
    }
    setDonorLogoBusy(true);
    try {
      const data = await runAccountOperation(async () => {
        const response = await fetch("/api/settings/branding/donor-logo", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type },
          body: file
        });
        const result = (await response.json().catch(() => ({}))) as { donorLogoVersion?: string; message?: string; error?: string };
        if (!response.ok) {
          throw new Error(String(result.message ?? result.error ?? `HTTP ${response.status}`));
        }
        return result;
      });
      const nextVersion = data.donorLogoVersion ?? null;
      setDonorLogoVersion(nextVersion);
      setDonorPreviewUrl(null);
      onSave(draftBranding({ donorLogoVersion: nextVersion }));
      setNotice("Logo para donantes actualizado.");
    } catch (err) {
      setDonorLogoError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setDonorLogoBusy(false);
      if (donorLogoInputRef.current) {
        donorLogoInputRef.current.value = "";
      }
    }
  }

  async function removeDonorLogo() {
    setDonorLogoError("");
    setDonorLogoBusy(true);
    try {
      await runAccountOperation(() => api<{ ok: true }>("/api/settings/branding/donor-logo", token, { method: "DELETE" }));
      setDonorLogoVersion(null);
      setDonorPreviewUrl(null);
      onSave(draftBranding({ donorLogoVersion: null }));
      setNotice("Logo para donantes eliminado.");
    } catch (err) {
      setDonorLogoError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setDonorLogoBusy(false);
    }
  }

  function onPickDonorFile(file: File | undefined) {
    if (!file) return;
    setDonorPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    void uploadDonorLogo(file);
  }

  const previewDisplayName = displayName.trim() || "Su organización";
  const previewSupportEmail = supportEmail.trim() || "Correo de soporte";

  return (
    <section className="credential-form-panel branding-panel">
      <div className="panel-head">
        <div>
          <h2>Marca</h2>
          <p>Nombre, color y logo con los que se identifica su organización en el panel y los correos.</p>
        </div>
        <Palette size={20} />
      </div>

      <div className="credential-fields">
        <label>
          <span className="plain-field-label">Nombre de la organización</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Nombre de su organización"
            maxLength={80}
            aria-label="Nombre de la organización"
          />
        </label>

        <div className="credential-field-block">
          <span className="plain-field-label">Color de acento</span>
          <div className="branding-color-row">
            <input
              type="color"
              className="branding-color-swatch"
              value={colorForPicker}
              onChange={(event) => setAccentColor(event.target.value)}
              aria-label="Selector de color de acento"
            />
            <input
              className="branding-color-hex"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
              placeholder="#0f766e"
              aria-label="Color de acento en formato hexadecimal"
            />
          </div>
          <small>Recolorea el panel de administración y el encabezado de los correos.</small>
        </div>

        <label>
          <span className="plain-field-label">Correo de soporte</span>
          <input
            type="email"
            value={supportEmail}
            onChange={(event) => setSupportEmail(event.target.value)}
            placeholder="soporte@su-dominio.org"
            maxLength={100}
            aria-label="Correo de soporte"
          />
          <small>Se muestra en las páginas de donación y en el pie de los correos.</small>
        </label>
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="credential-actions">
        <div>
          <Palette size={16} />
          <span>El color se aplica de inmediato en esta pantalla al guardar.</span>
        </div>
        <button className="primary" type="button" disabled={savingText} onClick={() => void saveNameAndColor()}>
          {savingText ? "Guardando" : "Guardar cambios"}
        </button>
      </div>

      <div className="credential-field-block branding-logo-block">
        <div className="credential-section-title">
          <h3>Logo de administración y correos</h3>
          <p>Se muestra en el inicio de sesión, el panel administrativo y el encabezado de los correos. SVG, PNG o JPG, hasta 512 KB.</p>
        </div>
        <div className="branding-logo-row">
          <div className="branding-logo-preview" aria-hidden={!previewUrl && !currentLogoSrc}>
            {previewUrl ? (
              <img src={previewUrl} alt="Vista previa del logo" />
            ) : currentLogoSrc ? (
              <img src={currentLogoSrc} alt={displayName} />
            ) : (
              <span className="branding-logo-empty">Sin logo</span>
            )}
          </div>
          <div className="branding-logo-controls">
            <label className="file-upload-button">
              <Upload size={16} />
              {logoBusy ? "Subiendo" : currentLogoSrc ? "Reemplazar logo" : "Subir logo"}
              <input
                ref={logoInputRef}
                className="file-input-hidden"
                type="file"
                accept={BRANDING_LOGO_ACCEPT}
                disabled={logoBusy}
                onChange={(event) => onPickFile(event.target.files?.[0])}
              />
            </label>
            {currentLogoSrc && (
              <button type="button" className="danger" disabled={logoBusy} onClick={() => void removeLogo()}>
                Quitar logo
              </button>
            )}
          </div>
        </div>
        {logoError && <p className="field-error">{logoError}</p>}
      </div>

      <div className="credential-field-block branding-logo-block">
        <div className="credential-section-title">
          <h3>Logo para donantes</h3>
          <p>Se muestra solo en la página pública de donación. Use una versión pensada para fondo blanco. SVG, PNG o JPG, hasta 512 KB.</p>
        </div>
        <div className="branding-logo-row">
          <div className="branding-logo-preview" aria-hidden={!donorPreviewUrl && !currentDonorLogoSrc}>
            {donorPreviewUrl ? (
              <img src={donorPreviewUrl} alt="Vista previa del logo para donantes" />
            ) : currentDonorLogoSrc ? (
              <img src={currentDonorLogoSrc} alt={displayName} />
            ) : (
              <span className="branding-logo-empty">Sin logo</span>
            )}
          </div>
          <div className="branding-logo-controls">
            <label className="file-upload-button">
              <Upload size={16} />
              {donorLogoBusy ? "Subiendo" : currentDonorLogoSrc ? "Reemplazar logo" : "Subir logo"}
              <input
                ref={donorLogoInputRef}
                className="file-input-hidden"
                type="file"
                accept={BRANDING_LOGO_ACCEPT}
                disabled={donorLogoBusy}
                onChange={(event) => onPickDonorFile(event.target.files?.[0])}
              />
            </label>
            {currentDonorLogoSrc && (
              <button type="button" className="danger" disabled={donorLogoBusy} onClick={() => void removeDonorLogo()}>
                Quitar logo
              </button>
            )}
          </div>
        </div>
        {donorLogoError && <p className="field-error">{donorLogoError}</p>}
      </div>

      <div className="credential-field-block branding-preview-block">
        <div className="credential-section-title">
          <h3>Vista previa</h3>
          <p>Vista aproximada. Algunos servicios de correo pueden ajustar los colores en modo oscuro.</p>
        </div>
        <div className="branding-preview-grid">
          {/* Correo: a pure div/CSS miniature of the email chrome — NOT an iframe of real
              email HTML. The header bar carries the draft accent; the body and footer are
              grayed placeholders showing the draft name, logo, and support email. */}
          <figure className="branding-preview-card branding-preview-email">
            <div className="branding-preview-frame">
              <div className="branding-preview-email-header" style={{ background: colorForPicker }}>
                {(previewUrl ?? currentLogoSrc) && (
                  <img className="branding-preview-email-logo" src={(previewUrl ?? currentLogoSrc) ?? undefined} alt={previewDisplayName} />
                )}
                <span className="branding-preview-email-name">{previewDisplayName}</span>
              </div>
              <div className="branding-preview-email-body">
                <span className="branding-preview-line" />
                <span className="branding-preview-line branding-preview-line-short" />
              </div>
              <div className="branding-preview-email-footer">{previewSupportEmail}</div>
            </div>
            <figcaption>Así se verá en los correos</figcaption>
          </figure>

          {/* Página de donación: the donor landing card. Monochrome BY DESIGN — the donor
              page is never tinted with the accent, so this mock must not use colorForPicker. */}
          <figure className="branding-preview-card branding-preview-donor">
            <div className="branding-preview-frame branding-preview-donor-card">
              {(donorPreviewUrl ?? currentDonorLogoSrc) ? (
                <img className="branding-preview-donor-logo" src={(donorPreviewUrl ?? currentDonorLogoSrc) ?? undefined} alt={previewDisplayName} />
              ) : (
                <span className="branding-preview-donor-mark">{previewDisplayName}</span>
              )}
              <span className="branding-preview-donor-title">Diezmos y Ofrendas</span>
            </div>
            <figcaption>Así se verá en la página de donación</figcaption>
          </figure>
        </div>
      </div>

      {notice && <p className="auth-notice">{notice}</p>}
    </section>
  );
}

type EmailTemplateBodyFormat = "bold" | "italic" | "underline" | "quote";

export function formatEmailTemplateSelection(
  controlledValue: string,
  selectionStart: number,
  selectionEnd: number,
  format: EmailTemplateBodyFormat
): { value: string; selectionStart: number; selectionEnd: number } {
  // HTML textareas expose every CRLF/CR line ending as LF, and their selection
  // offsets index that normalized value. Apply the same single normalization
  // before slicing a controlled value loaded from storage.
  const value = controlledValue.replace(/\r\n?/g, "\n");
  if (format === "quote") {
    const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const nextLineBreak = value.indexOf("\n", selectionEnd);
    const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const removeQuote = lines.every((line) => /^\s*>\s?/.test(line));
    const replacement = lines
      .map((line) => removeQuote ? line.replace(/^\s*>\s?/, "") : `> ${line}`)
      .join("\n");
    return {
      value: `${value.slice(0, lineStart)}${replacement}${value.slice(lineEnd)}`,
      selectionStart: lineStart,
      selectionEnd: lineStart + replacement.length
    };
  }

  const markers = format === "bold"
    ? ["**", "**"] as const
    : format === "italic"
      ? ["*", "*"] as const
      : ["++", "++"] as const;
  const selected = value.slice(selectionStart, selectionEnd);
  if (!selected) {
    const replacement = `${markers[0]}${markers[1]}`;
    const caret = selectionStart + markers[0].length;
    return {
      value: `${value.slice(0, selectionStart)}${replacement}${value.slice(selectionEnd)}`,
      selectionStart: caret,
      selectionEnd: caret
    };
  }

  const lines = selected.split("\n");
  const replacement = lines
    .map((line) => line ? `${markers[0]}${line}${markers[1]}` : line)
    .join("\n");
  return {
    value: `${value.slice(0, selectionStart)}${replacement}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + (lines[0] ? markers[0].length : 0),
    selectionEnd: selectionStart + replacement.length - (lines.at(-1) ? markers[1].length : 0)
  };
}

function EmailTemplateBodyEditor({
  id,
  templateLabel,
  value,
  placeholder,
  onChange
}: {
  id: string;
  templateLabel: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // role="toolbar" es un solo punto de tabulación: las flechas mueven el foco
  // entre los botones y solo el activo queda alcanzable con Tab.
  const [activeFormatIndex, setActiveFormatIndex] = useState(0);
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    pendingSelectionRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pending.start, pending.end);
  }, [value]);

  const applyFormat = (format: EmailTemplateBodyFormat) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const formatted = formatEmailTemplateSelection(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      format
    );
    pendingSelectionRef.current = {
      start: formatted.selectionStart,
      end: formatted.selectionEnd
    };
    onChange(formatted.value);
  };

  const moveFormatFocus = (step: number) => {
    const buttons = Array.from(toolbarRef.current?.querySelectorAll("button") ?? []);
    if (buttons.length === 0) return;
    const nextIndex = (activeFormatIndex + step + buttons.length) % buttons.length;
    setActiveFormatIndex(nextIndex);
    buttons[nextIndex].focus();
  };

  return (
    <div className="email-template-body-field">
      <div className="email-template-body-head">
        <label htmlFor={id}><span>Cuerpo del correo</span></label>
        <div
          ref={toolbarRef}
          className="email-template-format-toolbar"
          role="toolbar"
          aria-label={`Formato del cuerpo — ${templateLabel}`}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            moveFormatFocus(event.key === "ArrowRight" ? 1 : -1);
          }}
        >
          <button type="button" tabIndex={activeFormatIndex === 0 ? 0 : -1} onFocus={() => setActiveFormatIndex(0)} aria-label={`Negrita — ${templateLabel}`} title="Negrita: **texto**" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("bold")}><strong>B</strong></button>
          <button type="button" tabIndex={activeFormatIndex === 1 ? 0 : -1} onFocus={() => setActiveFormatIndex(1)} aria-label={`Cursiva — ${templateLabel}`} title="Cursiva: *texto*" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("italic")}><em>I</em></button>
          <button type="button" tabIndex={activeFormatIndex === 2 ? 0 : -1} onFocus={() => setActiveFormatIndex(2)} aria-label={`Subrayado — ${templateLabel}`} title="Subrayado: ++texto++" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("underline")}><u>U</u></button>
          <button type="button" tabIndex={activeFormatIndex === 3 ? 0 : -1} onFocus={() => setActiveFormatIndex(3)} aria-label={`Cita — ${templateLabel}`} title="Cita: > texto" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("quote")}>❝</button>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        id={id}
        aria-label={`Cuerpo del correo — ${templateLabel}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <small className="email-template-format-help">Formato: **negrita**, *cursiva*, ++subrayado++ y &gt; cita.</small>
    </div>
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
  onSubmit: (scope: EmailTemplateScope) => Promise<void>;
}) {
  const definitions = settings?.definitions ?? [];
  const legacyPlaceholders = settings?.placeholders ?? [];
  const salvadoranDefinitions = definitions.filter((definition) => isEmailTemplateScope("SV_CDE", definition.scope));
  const usDefinitions = definitions.filter((definition) => isEmailTemplateScope("US_STRIPE", definition.scope));
  // Cada botón guarda solo las plantillas de su país, así que la exigencia de asunto
  // y cuerpo se evalúa por grupo: un cuerpo vacío en EE. UU. no debe bloquear el
  // guardado de El Salvador ni al revés.
  const groupComplete = (group: typeof definitions) => group.every(
    (definition) => draft[definition.type]?.subject.trim() && draft[definition.type]?.body.trim()
  );
  const salvadoranComplete = groupComplete(salvadoranDefinitions);
  const usComplete = groupComplete(usDefinitions);
  const groupPlaceholders = (group: typeof definitions): string[] => Array.from(new Set(
    group.flatMap((definition) => definition.placeholders ?? legacyPlaceholders)
  ));
  const renderTemplateCards = (group: typeof definitions) => (
    <div className="email-template-list">
      {group.map((definition) => {
        const value = draft[definition.type] ?? { subject: "", body: "" };
        const titleId = `email-template-title-${definition.type}`;
        return (
          <section
            className="email-template-card"
            key={definition.type}
            role="region"
            aria-labelledby={titleId}
          >
            <div>
              <h4 id={titleId}>{definition.label}</h4>
              <p>{definition.description}</p>
            </div>
            <label>
              <span>Asunto</span>
              <input
                aria-label={`Asunto — ${definition.label}`}
                value={value.subject}
                onChange={(event) => onChange(definition.type, { subject: event.target.value })}
                placeholder={definition.defaultSubject}
              />
            </label>
            <EmailTemplateBodyEditor
              id={`email-template-body-${definition.type}`}
              templateLabel={definition.label}
              value={value.body}
              onChange={(body) => onChange(definition.type, { body })}
              placeholder={definition.defaultBody}
            />
          </section>
        );
      })}
    </div>
  );
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
          <section className="email-template-country-group" aria-label="Plantillas de El Salvador — CDE">
            <div className="email-template-country-head">
              <div>
                <h3>El Salvador — CDE</h3>
                <p>Mensajes fiscales salvadoreños vinculados al comprobante electrónico.</p>
              </div>
              <span className="email-template-country-badge">Editables</span>
            </div>
            <div className="email-template-guidance">
              <span>Use estas variables solamente en los correos CDE de El Salvador.</span>
              <div className="email-template-placeholders" aria-label="Variables disponibles para El Salvador">
                {groupPlaceholders(salvadoranDefinitions).map((placeholder) => <code key={placeholder}>{placeholder}</code>)}
              </div>
            </div>
            {renderTemplateCards(salvadoranDefinitions)}
            <div className="credential-actions email-template-actions">
              <div>
                <Mail size={16} />
                <span>Estos textos se aplican al próximo envío o reenvío de CDE.</span>
              </div>
              <button className="primary" type="button" disabled={busy || !salvadoranComplete} onClick={() => void onSubmit("SV_CDE")}>
                <Mail size={16} />
                {busy ? "Guardando" : "Guardar plantillas de El Salvador"}
              </button>
            </div>
          </section>

          <section className="email-template-country-group email-template-country-group-us" aria-label="Plantillas de EE. UU. — Stripe 501(c)(3)">
            <div className="email-template-country-head">
              <div>
                <h3>EE. UU. — Stripe 501(c)(3)</h3>
                <p>Constancias estadounidenses separadas de los mensajes CDE salvadoreños.</p>
              </div>
              <span className="email-template-protected-badge"><Lock size={13} />PDF legal protegido</span>
            </div>
            <p className="email-template-protected-note">
              El asunto y cuerpo de estos correos son editables. Los PDF adjuntos de la constancia inmediata y anual conservan su diseño y contenido legal fijo.
            </p>
            <div className="email-template-guidance">
              <span>Use estas variables solamente en los correos de EE. UU.</span>
              <div className="email-template-placeholders" aria-label="Variables disponibles para Estados Unidos">
                {groupPlaceholders(usDefinitions).map((placeholder) => <code key={placeholder}>{placeholder}</code>)}
              </div>
            </div>
            {renderTemplateCards(usDefinitions)}
            <div className="credential-actions email-template-actions">
              <div>
                <Mail size={16} />
                <span>Estos textos se aplican al próximo correo de Stripe que se prepare.</span>
              </div>
              <button className="primary" type="button" disabled={busy || !usComplete} onClick={() => void onSubmit("US_STRIPE")}>
                <Mail size={16} />
                {busy ? "Guardando" : "Guardar plantillas de EE. UU."}
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

// PUT /api/settings/email-templates recibe el país en `scope` y solo las plantillas de ese
// país: el servidor las fusiona sobre lo que tiene guardado en ese instante y valida las
// cinco. Completar aquí el otro grupo con la copia que este panel cargó al abrirse
// revertiría en silencio lo que otra persona propietaria hubiera guardado mientras tanto,
// así que este helper recorta el envío y nunca lo rellena. La partición es la misma que usa
// el editor: cualquier scope inesperado cae del lado salvadoreño en ambos sitios, para que
// ninguna plantilla visible en un grupo quede fuera de su propio guardado.
export function isEmailTemplateScope(scope: EmailTemplateScope, candidate: EmailTemplateScope): boolean {
  return scope === "US_STRIPE" ? candidate === "US_STRIPE" : candidate !== "US_STRIPE";
}

export function scopedEmailTemplates(
  settings: EmailTemplateSettings | null,
  templates: Record<string, EmailTemplateValue>,
  scope: EmailTemplateScope
): Record<string, EmailTemplateValue> {
  return Object.fromEntries(
    (settings?.definitions ?? [])
      .filter((definition) => isEmailTemplateScope(scope, definition.scope) && templates[definition.type])
      .map((definition) => [definition.type, { ...templates[definition.type] }])
  );
}

export function cloneEmailTemplates(templates: Record<string, EmailTemplateValue>): Record<string, EmailTemplateValue> {
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
  const form = useMemo(() => issuerFormFromConfigJson(input.emisorConfigJson), [input.emisorConfigJson]);
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
        <span>{configured ? "Configuración protegida; complete todos los campos para reemplazarla" : "Complete los datos del emisor para habilitar emisión real"}</span>
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
          <p>Códigos de establecimiento, punto de venta y numeración CDE. Hacienda y el emisor usan campos parecidos, pero cada uno alimenta una parte distinta del DTE.</p>
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
          <small>Identificador oficial del establecimiento autorizado por el Ministerio de Hacienda.</small>
        </label>
        <label>
          <span>Código punto de venta del Ministerio de Hacienda</span>
          <input value={form.codPuntoVentaMH} onChange={(event) => update({ codPuntoVentaMH: event.target.value })} placeholder="P004" />
          <small>Identificador oficial del punto de venta o terminal reconocido por el Ministerio de Hacienda.</small>
        </label>
        <label>
          <span>Código establecimiento interno</span>
          <input value={form.codEstable} onChange={(event) => update({ codEstable: event.target.value })} placeholder="Opcional" />
          <small>Código propio del emisor para agrupar documentos por sede interna; puede coincidir con el código MH si no manejan otro.</small>
        </label>
        <label>
          <span>Código punto de venta interno</span>
          <input value={form.codPuntoVenta} onChange={(event) => update({ codPuntoVenta: event.target.value })} placeholder="Opcional" />
          <small>Código propio del emisor para la caja, terminal o flujo interno que genera el CDE; no reemplaza el código MH.</small>
        </label>
        <label className="span-2">
          <span>Prefijo número de control</span>
          <input value={form.controlPrefix} onChange={(event) => update({ controlPrefix: event.target.value })} placeholder="M001P004" />
          <small>Prefijo usado para construir el número de control del CDE; normalmente combina establecimiento y punto de venta internos.</small>
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
    help: state?.locked
      ? `Este despliegue está bloqueado a ${label}; el ambiente no puede cambiarse desde la aplicación.`
      : source === "setting"
        ? `Los próximos CDE se emitirán contra el Ministerio de Hacienda (${label}).`
        : `Usando ${label} como valor inicial.`
  };
}

function credentialSettingsPanelDescription(section: CredentialSettingsSectionId, activeEnvironmentLabel: string): string {
  const descriptions: Record<CredentialSettingsSectionId, string> = {
    ambiente: "Controle el ambiente que usarán los DTE nuevos y el par de credenciales del Ministerio de Hacienda que desea revisar.",
    mh: `Administre el usuario API de ${activeEnvironmentLabel} y el certificado firmador usado para firmar DTE antes de transmitirlos.`,
    wompi: "Configure la firma, el webhook y los avisos que se incorporarán a cada enlace nuevo de Wompi.",
    stripe: "Administre presencia, rotación segura y salud observada de Stripe para el carril de EE. UU.",
    emisor: "Revise los datos fiscales y catálogos usados para construir cada CDE.",
    correo: "Revise el remitente de Cloudflare Email y el respaldo HTTP operativo.",
    plantillas: "Edite los asuntos y cuerpos de los correos automáticos.",
    marca: "Personalice el nombre, color y logo con los que se identifica su organización."
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
