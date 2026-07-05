import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DONAR_AMOUNT_CHIPS,
  DONAR_FALLBACK_MESSAGE,
  DONAR_INTENT_PATH,
  DONAR_POLL_INTERVAL_MS,
  DONAR_POLL_TIMEOUT_MS,
  DONAR_SCRIPT_TIMEOUT_MS,
  DONAR_THANK_YOU_BODY,
  DONAR_THANK_YOU_TITLE,
  DONAR_WOMPI_SCRIPT_URL,
  donationFormValidationMessage,
  graciasDisplayFromSearch,
  isDonarGraciasPath,
  isDonarPath,
  widgetUrlFrom
} from "../../src/client/donation";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("donar page routing", () => {
  it("recognizes the public donation routes (with and without trailing slash)", () => {
    expect(isDonarPath("/donar")).toBe(true);
    expect(isDonarPath("/donar/")).toBe(true);
    expect(isDonarPath("/donar/gracias")).toBe(false);
    expect(isDonarPath("/documents")).toBe(false);

    expect(isDonarGraciasPath("/donar/gracias")).toBe(true);
    expect(isDonarGraciasPath("/donar/gracias/")).toBe(true);
    expect(isDonarGraciasPath("/donar")).toBe(false);
  });

  it("branches on pathname in App before any session/token check so /donar renders without a session", () => {
    // The public views must be returned above the `if (!token || !user)` auth gate.
    const donarBranch = appSource.indexOf("isDonarPath(");
    const graciasBranch = appSource.indexOf("isDonarGraciasPath(");
    const authGate = appSource.indexOf("if (!token || !user)");
    expect(donarBranch).toBeGreaterThan(-1);
    expect(graciasBranch).toBeGreaterThan(-1);
    expect(authGate).toBeGreaterThan(-1);
    expect(donarBranch).toBeLessThan(authGate);
    expect(graciasBranch).toBeLessThan(authGate);
    // Renders dedicated standalone components.
    expect(appSource).toContain("<DonarPage");
    expect(appSource).toContain("<DonarGraciasPage");
  });
});

describe("donar form validation", () => {
  // Name and email are no longer collected on the form — the donor types them on
  // Wompi's hosted sheet — so the validated input carries only documento, teléfono,
  // dirección, and monto.
  const base = {
    amount: "10.00",
    donorDocumentType: "13" as const,
    donorDocument: "10000001-9",
    donorPhone: "",
    departamento: "06",
    municipio: "23",
    distrito: "14",
    complemento: "San Salvador, El Salvador"
  };

  it("accepts a fully valid DUI donation", () => {
    expect(donationFormValidationMessage(base)).toBe("");
  });

  it("requires an amount of at least $1", () => {
    expect(donationFormValidationMessage({ ...base, amount: "" })).toBe("Ingrese un monto válido en dólares.");
    expect(donationFormValidationMessage({ ...base, amount: "0" })).toBe("El monto mínimo de donación es $1.00.");
    expect(donationFormValidationMessage({ ...base, amount: "0.50" })).toBe("El monto mínimo de donación es $1.00.");
  });

  it("validates the DUI check digit only when the document type is DUI (13)", () => {
    expect(donationFormValidationMessage({ ...base, donorDocument: "04182769-0" })).toBe("Revise el número de DUI.");
    // Type "Otro" (37) skips the DUI check-digit rule.
    expect(donationFormValidationMessage({ ...base, donorDocumentType: "37", donorDocument: "PASAPORTE-123" })).toBe("");
  });

  it("requires the document and the address fields (name/email are collected on Wompi)", () => {
    expect(donationFormValidationMessage({ ...base, donorDocumentType: "37", donorDocument: "  " })).toBe("Ingrese su documento.");
    expect(donationFormValidationMessage({ ...base, departamento: "" })).toBe("Seleccione un departamento.");
    expect(donationFormValidationMessage({ ...base, municipio: "" })).toBe("Seleccione un municipio.");
    expect(donationFormValidationMessage({ ...base, distrito: "" })).toBe("Seleccione un distrito.");
    expect(donationFormValidationMessage({ ...base, complemento: "  " })).toBe("Ingrese su dirección.");
  });
});

describe("donar amount chips", () => {
  it("offers the $5 / $10 / $25 / $50 quick amounts", () => {
    expect(DONAR_AMOUNT_CHIPS).toEqual([5, 10, 25, 50]);
  });
});

describe("donar widget handoff", () => {
  it("feeds the widget urlEnlaceLargo with the esWidget flag appended", () => {
    expect(widgetUrlFrom("https://mock.wompi.sv/enlace-largo/abc?x=1")).toBe(
      "https://mock.wompi.sv/enlace-largo/abc?x=1&esWidget=1"
    );
  });

  it("pins the official Wompi widget script URL", () => {
    expect(DONAR_WOMPI_SCRIPT_URL).toBe("https://pagos.wompi.sv/js/wompi.pagos.js");
  });

  it("polls the public intent status endpoint every ~5s and stops after ~3 minutes", () => {
    expect(DONAR_INTENT_PATH).toBe("/api/donations/intent");
    expect(DONAR_POLL_INTERVAL_MS).toBe(5_000);
    expect(DONAR_POLL_TIMEOUT_MS).toBe(180_000);
    // Script/widget-render fallback timeout is short.
    expect(DONAR_SCRIPT_TIMEOUT_MS).toBeLessThanOrEqual(6_000);
  });

  it("closes the poll with a neutral message that never implies failure", () => {
    expect(DONAR_FALLBACK_MESSAGE).toBe(
      "Si completó el pago, recibirá su comprobante (CDE) por correo electrónico. Puede cerrar esta página."
    );
  });
});

describe("donar thank-you page", () => {
  it("reads identificadorEnlaceComercio, idTransaccion, and monto from the query string for display only", () => {
    const display = graciasDisplayFromSearch("?identificadorEnlaceComercio=DI-1&idTransaccion=TX-9&monto=12.34");
    expect(display.identificadorEnlaceComercio).toBe("DI-1");
    expect(display.idTransaccion).toBe("TX-9");
    expect(display.monto).toBe("12.34");
  });

  it("tolerates a missing query string", () => {
    const display = graciasDisplayFromSearch("");
    expect(display.identificadorEnlaceComercio).toBe("");
    expect(display.idTransaccion).toBe("");
    expect(display.monto).toBe("");
  });

  it("uses the webhook-driven thank-you copy", () => {
    expect(DONAR_THANK_YOU_TITLE).toBe("Su donación fue recibida.");
    expect(DONAR_THANK_YOU_BODY).toBe(
      "Recibirá su comprobante (CDE) por correo cuando el Ministerio de Hacienda lo confirme."
    );
  });
});

describe("donar page source contract", () => {
  it("labels the form fields in usted-form Spanish", () => {
    expect(appSource).toContain("Haga su donación");
    expect(appSource).toContain("Tipo de documento");
    expect(appSource).toContain("Teléfono (opcional)");
    expect(appSource).toContain("Departamento");
    expect(appSource).toContain("Municipio");
    expect(appSource).toContain("Distrito");
    expect(appSource).toContain("Dirección");
    expect(appSource).toContain("Monto");
  });

  it("no longer collects name or email on the form (both are entered on Wompi's sheet)", () => {
    // Wompi's hosted sheet requires and asks only for name + email, so the form
    // must not render those fields — and must tell the donor what comes next.
    expect(appSource).not.toContain("Nombre completo");
    expect(appSource).not.toContain("Correo electrónico");
    expect(appSource).toContain("Su nombre y correo se ingresan al pagar con Wompi.");
  });

  it("wires cascading municipio/distrito selects to the department-scoped catalog helpers", () => {
    expect(appSource).toContain("getCat013Municipalities(");
    expect(appSource).toContain("getCat008Districts(");
  });

  it("auto-formats and check-digit-validates the DUI on blur via the shared helpers", () => {
    expect(appSource).toContain("formatDui(");
    expect(appSource).toContain("isValidDui(");
    expect(appSource).toContain("onBlur=");
    // The "Revise el número de DUI." copy lives in donationFormValidationMessage.
    expect(donationFormValidationMessage).toBeTypeOf("function");
  });

  it("disables the submit button while preparing the payment", () => {
    expect(appSource).toContain("Preparando el pago…");
  });

  it("loads the Wompi widget script only from the donar view and renders the widget button", () => {
    expect(appSource).toContain("DONAR_WOMPI_SCRIPT_URL");
    expect(appSource).toContain("wompi_button_widget");
    expect(appSource).toContain('"data-render", "widget"');
    expect(appSource).toContain('"data-url-pago"');
  });

  it("falls back to a full-page redirect to urlEnlace when the widget cannot render", () => {
    expect(appSource).toContain("window.location.href");
    expect(appSource).toContain("urlEnlace");
  });

  it("auto-clicks the rendered Wompi button so the modal opens immediately after submit", () => {
    // The effect that renders the widget div must poll/observe the host for the
    // button Wompi injects and click it once, so form → modal needs no extra click.
    const widgetEffect = appSource.indexOf("wompi_button_widget");
    expect(widgetEffect).toBeGreaterThan(-1);
    // Auto-click looks for the button in the host and invokes .click() on it.
    expect(appSource).toContain('host.querySelector("button")');
    const clickCall = appSource.indexOf(".click()", widgetEffect);
    expect(clickCall).toBeGreaterThan(-1);
    // The auto-click poll reuses the existing short script/render timeout budget.
    expect(appSource).toContain("DONAR_SCRIPT_TIMEOUT_MS");
  });

  it("guards the auto-click with a ref so it never double-fires", () => {
    // A dedicated ref (initialized false) latches once the button is clicked.
    expect(appSource).toContain("autoClickedRef");
    expect(appSource).toContain("useRef(false)");
    // The guard is checked before clicking and set true after, so re-observing the
    // (still-present) button does not re-open the modal.
    const guardCheck = appSource.indexOf("autoClickedRef.current");
    expect(guardCheck).toBeGreaterThan(-1);
  });

  it("keeps the manual backup button and 'Continúe aquí' link visible", () => {
    // The modal can be closed and reopened, so the manual path stays on screen.
    expect(appSource).toContain("¿No se abre el pago? Continúe aquí");
  });

  it("ships donation styles reusing the auth/card visual language", () => {
    expect(stylesSource).toContain(".donar-");
  });

  it("enforces the postMessage origin on the DONAR_COMPLETED_MESSAGE listener", () => {
    // The gracias page inside the modal iframe is same-origin, so the listener must
    // reject messages whose origin differs from window.location.origin — otherwise the
    // Wompi widget iframe (which holds window.parent) could spoof the thank-you state.
    const listenerStart = appSource.indexOf("function onMessage(event: MessageEvent)");
    expect(listenerStart).toBeGreaterThan(-1);
    const completedCheck = appSource.indexOf("DONAR_COMPLETED_MESSAGE", listenerStart);
    expect(completedCheck).toBeGreaterThan(-1);
    const originCheck = appSource.indexOf("event.origin !== window.location.origin", listenerStart);
    expect(originCheck).toBeGreaterThan(-1);
    // The origin guard must appear before (or with) the message check, inside the listener.
    expect(originCheck).toBeLessThan(completedCheck);
  });

  it("posts the completed message to the same origin, never the wildcard target", () => {
    const senderStart = appSource.indexOf("window.parent.postMessage(DONAR_COMPLETED_MESSAGE");
    expect(senderStart).toBeGreaterThan(-1);
    const senderCall = appSource.slice(senderStart, senderStart + 120);
    expect(senderCall).toContain("window.location.origin");
    expect(senderCall).not.toContain('"*"');
  });
});
