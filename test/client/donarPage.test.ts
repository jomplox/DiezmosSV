import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DONAR_AMOUNT_CHIPS,
  DONAR_DOMESTIC_DEPARTMENTS,
  DONAR_FALLBACK_MESSAGE,
  DONAR_FOREIGN_COUNTRIES,
  DONAR_FOREIGN_GEOGRAPHY_CODE,
  DONAR_INTENT_PATH,
  DONAR_POLL_INTERVAL_MS,
  DONAR_POLL_TIMEOUT_MS,
  DONAR_SCRIPT_TIMEOUT_MS,
  DONAR_THANK_YOU_BODY,
  DONAR_THANK_YOU_TITLE,
  DONAR_WOMPI_SCRIPT_URL,
  GIVEBUTTER_ACCOUNT_ID,
  GIVEBUTTER_CAMPAIGN,
  GIVEBUTTER_ESCAPE_HATCH,
  GIVEBUTTER_FALLBACK_CTA,
  GIVEBUTTER_FALLBACK_HINT,
  GIVEBUTTER_INTRO,
  GIVEBUTTER_MONTHLY_LABEL,
  GIVEBUTTER_RENDER_TIMEOUT_MS,
  GIVEBUTTER_SCRIPT_URL,
  GIVEBUTTER_US_COUNTRY_CODE,
  donationFormValidationMessage,
  donationIntentBody,
  givebutterHostedUrl,
  givebutterPrefillParams,
  isUsDonation,
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
    donorName: "",
    donorPhone: "",
    foreignResident: false,
    pais: "",
    departamento: "06",
    municipio: "23",
    distrito: "14",
    complemento: "San Salvador, El Salvador"
  };

  it("accepts a fully valid DUI donation", () => {
    expect(donationFormValidationMessage(base)).toBe("");
  });

  it("validates the empresa NIT format (14 digits) and requires the razón social", () => {
    const nitBase = { ...base, donorDocumentType: "36" as const, donorDocument: "0614-280390-112-1", donorName: "Empresa Ejemplo, S.A. de C.V." };
    expect(donationFormValidationMessage(nitBase)).toBe("");
    // Unhyphenated 14-digit input is also valid (format-only, no check digit).
    expect(donationFormValidationMessage({ ...nitBase, donorDocument: "06142803901121" })).toBe("");
    // Donor-facing copy frames the 36 type as the empresa's NIT.
    expect(donationFormValidationMessage({ ...nitBase, donorDocument: "0614280390112" })).toBe("Ingrese el NIT de la empresa (14 dígitos).");
    // Razón social is required for Empresa (36) only, capped at 200 characters.
    expect(donationFormValidationMessage({ ...nitBase, donorName: "  " })).toBe("Ingrese la razón social.");
    expect(donationFormValidationMessage({ ...nitBase, donorName: "x".repeat(201) })).toBe("La razón social no debe exceder 200 caracteres.");
    // Non-empresa types never require a razón social.
    expect(donationFormValidationMessage({ ...base, donorName: "" })).toBe("");
  });

  it("bounds pasaporte and carnet de residente documents to 5-30 characters", () => {
    for (const donorDocumentType of ["03", "02"] as const) {
      expect(donationFormValidationMessage({ ...base, donorDocumentType, donorDocument: "AB123456" })).toBe("");
      expect(donationFormValidationMessage({ ...base, donorDocumentType, donorDocument: "A123" })).toBe(
        "Ingrese su documento (entre 5 y 30 caracteres)."
      );
      expect(donationFormValidationMessage({ ...base, donorDocumentType, donorDocument: "X".repeat(31) })).toBe(
        "Ingrese su documento (entre 5 y 30 caracteres)."
      );
    }
  });

  it("caps the dirección at the MH schema's 200-character complemento limit", () => {
    // fe-cd-v2 caps receptor direccion.complemento at 200; a longer address would
    // take the donor's payment and then fail schema validation at CDE build time.
    expect(donationFormValidationMessage({ ...base, complemento: "x".repeat(200) })).toBe("");
    expect(donationFormValidationMessage({ ...base, complemento: "x".repeat(201) })).toBe(
      "La dirección no debe exceder 200 caracteres."
    );
  });

  it("requires a país instead of the departamento/municipio/distrito on the foreign path", () => {
    const foreign = { ...base, foreignResident: true, pais: "US", departamento: "", municipio: "", distrito: "", complemento: "742 Evergreen Terrace, Springfield" };
    expect(donationFormValidationMessage(foreign)).toBe("");
    expect(donationFormValidationMessage({ ...foreign, pais: "" })).toBe("Seleccione su país de residencia.");
    // The dirección (complemento) is still required — it carries the foreign address.
    expect(donationFormValidationMessage({ ...foreign, complemento: "  " })).toBe("Ingrese su dirección.");
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

describe("donar intent body", () => {
  const base = {
    amount: " 10.00 ",
    donorDocumentType: "13" as const,
    donorDocument: "10000001-9",
    donorName: "",
    donorPhone: "",
    foreignResident: false,
    pais: "",
    departamento: "06",
    municipio: "23",
    distrito: "14",
    complemento: "San Salvador"
  };

  it("sends the donor-chosen geography and omits pais/donorName on the domestic path", () => {
    expect(donationIntentBody(base)).toEqual({
      amount: "10.00",
      donorDocumentType: "13",
      donorDocument: "10000001-9",
      donorName: undefined,
      donorPhone: undefined,
      departamento: "06",
      municipio: "23",
      distrito: "14",
      pais: undefined,
      complemento: "San Salvador"
    });
  });

  it("includes the razón social only for NIT (36) donors", () => {
    const body = donationIntentBody({ ...base, donorDocumentType: "36", donorDocument: "0614-280390-112-1", donorName: " Empresa Ejemplo, S.A. de C.V. " });
    expect(body.donorName).toBe("Empresa Ejemplo, S.A. de C.V.");
    // A stray razón social on a non-NIT type is never sent.
    expect(donationIntentBody({ ...base, donorName: "Ignorada" }).donorName).toBeUndefined();
  });

  it("sends the 00/00/00 geography plus the CAT-020 país on the foreign path", () => {
    const body = donationIntentBody({ ...base, foreignResident: true, pais: "US", departamento: "", municipio: "", distrito: "", complemento: "742 Evergreen Terrace" });
    expect(body.departamento).toBe(DONAR_FOREIGN_GEOGRAPHY_CODE);
    expect(body.municipio).toBe(DONAR_FOREIGN_GEOGRAPHY_CODE);
    expect(body.distrito).toBe(DONAR_FOREIGN_GEOGRAPHY_CODE);
    expect(body.pais).toBe("US");
    expect(body.complemento).toBe("742 Evergreen Terrace");
  });

  it("offers every CAT-020 country except El Salvador for the foreign residence select", () => {
    expect(DONAR_FOREIGN_COUNTRIES.length).toBeGreaterThan(100);
    expect(DONAR_FOREIGN_COUNTRIES.some((option) => option.code === "SV")).toBe(false);
    expect(DONAR_FOREIGN_COUNTRIES.some((option) => option.code === "US")).toBe(true);
  });

  it("keeps the 00 pseudo-department out of the domestic departamento choices", () => {
    // "Otro (Para extranjeros)" is reachable only through the extranjero toggle;
    // offering it as a domestic departamento would trip the foreign-path server
    // validation without a país.
    expect(DONAR_DOMESTIC_DEPARTMENTS.some((option) => option.code === DONAR_FOREIGN_GEOGRAPHY_CODE)).toBe(false);
    expect(DONAR_DOMESTIC_DEPARTMENTS.some((option) => option.code === "06")).toBe(true);
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

  it("offers the five CAT-022 document types with donor-facing labels in the agreed order", () => {
    // Donor-facing labeling: CAT-022 "36" shows as "Empresa" on /donar, NOT "NIT" —
    // many natural persons still hold legacy personal NITs and a literal "NIT"
    // option would bait them into the razón-social requirement. The stored code
    // stays "36"; the admin quick-CDE keeps the raw CAT022_DOCUMENT_TYPES labels.
    // Order: DUI, Empresa, Otro, Pasaporte, Carnet de Residente.
    const donarStart = appSource.indexOf("function DonarPage");
    expect(donarStart).toBeGreaterThan(-1);
    const donarSource = appSource.slice(donarStart);
    let previous = -1;
    for (const option of ['value="13">DUI<', 'value="36">Empresa<', 'value="37">Otro<', 'value="03">Pasaporte<', 'value="02">Carnet de Residente<']) {
      const at = donarSource.indexOf(option);
      expect(at, `missing or out of order: ${option}`).toBeGreaterThan(previous);
      previous = at;
    }
    // The bait label never appears on the donor-facing select.
    expect(donarSource).not.toContain('value="36">NIT<');
  });

  it("auto-formats a valid 14-digit NIT on blur, mirroring the DUI blur behavior", () => {
    expect(appSource).toContain("formatNit(");
    expect(appSource).toContain("isValidNitFormat(");
  });

  it("presents the empresa field pair: NIT de la empresa + required razón social", () => {
    const donarSource = appSource.slice(appSource.indexOf("function DonarPage"));
    // The document input is labeled "NIT de la empresa" while Empresa is selected...
    expect(donarSource).toContain("NIT de la empresa");
    // ...alongside the required razón social, both keyed on the 36 document type.
    expect(donarSource).toContain("Razón social");
    expect(donarSource).toContain('donorDocumentType === "36"');
  });

  it("wires the extranjero toggle above the address block, swapping geography for a país select", () => {
    const donarSource = appSource.slice(appSource.indexOf("function DonarPage"));
    expect(donarSource).toContain("Resido en el extranjero");
    // Checked → the país select (CAT-020 minus SV) replaces departamento/municipio/distrito.
    expect(donarSource).toContain("DONAR_FOREIGN_COUNTRIES");
    expect(donarSource).toContain("País");
    expect(donarSource).toContain("foreignResident");
    // The toggle renders BEFORE the address selects in the form markup.
    const toggleAt = donarSource.indexOf("Resido en el extranjero");
    const departamentoAt = donarSource.indexOf("<span>Departamento</span>");
    expect(toggleAt).toBeGreaterThan(-1);
    expect(departamentoAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeLessThan(departamentoAt);
  });

  it("submits the intent body through the shared donationIntentBody helper", () => {
    expect(appSource).toContain("donationIntentBody(");
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

describe("givebutter constants", () => {
  it("pins the FMCE account id and example-campaign campaign", () => {
    expect(GIVEBUTTER_ACCOUNT_ID).toBe("000000");
    expect(GIVEBUTTER_CAMPAIGN).toBe("example-campaign");
  });

  it("pins the official Givebutter widget script URL scoped to the account", () => {
    expect(GIVEBUTTER_SCRIPT_URL).toBe("https://widgets.givebutter.com/latest.umd.cjs?acct=000000");
    expect(GIVEBUTTER_SCRIPT_URL).toContain(`acct=${GIVEBUTTER_ACCOUNT_ID}`);
  });

  it("routes only US residents to Givebutter (CAT-020 código US)", () => {
    expect(GIVEBUTTER_US_COUNTRY_CODE).toBe("US");
  });

  it("uses the same short render-probe budget as the Wompi fallback", () => {
    expect(GIVEBUTTER_RENDER_TIMEOUT_MS).toBeLessThanOrEqual(6_000);
  });
});

describe("givebutter US-path detection", () => {
  const base = { foreignResident: false, pais: "" };

  it("activates only when the donor is a foreign resident in the US", () => {
    expect(isUsDonation({ foreignResident: true, pais: "US" })).toBe(true);
    // Foreign but not US → stays on the Wompi + CDE path.
    expect(isUsDonation({ foreignResident: true, pais: "MX" })).toBe(false);
    // US selected but extranjero unchecked (impossible via UI, guarded anyway).
    expect(isUsDonation({ foreignResident: false, pais: "US" })).toBe(false);
    expect(isUsDonation(base)).toBe(false);
  });
});

describe("givebutter prefill and hosted-url helpers", () => {
  it("writes amount and (when monthly) frequency=monthly for the widget URL prefill", () => {
    expect(givebutterPrefillParams({ amount: "25.00", monthly: false })).toEqual({ amount: "25" });
    expect(givebutterPrefillParams({ amount: "25", monthly: true })).toEqual({ amount: "25", frequency: "monthly" });
    // A blank/invalid amount contributes no amount param.
    expect(givebutterPrefillParams({ amount: "", monthly: false })).toEqual({});
    expect(givebutterPrefillParams({ amount: "0", monthly: true })).toEqual({ frequency: "monthly" });
    // Cents are preserved.
    expect(givebutterPrefillParams({ amount: "12.50", monthly: false })).toEqual({ amount: "12.5" });
  });

  it("builds the hosted-page fallback link with the slug and prefill query", () => {
    expect(givebutterHostedUrl({ amount: "25.00", monthly: false })).toBe(
      "https://givebutter.com/example-campaign?amount=25"
    );
    expect(givebutterHostedUrl({ amount: "25", monthly: true })).toBe(
      "https://givebutter.com/example-campaign?amount=25&frequency=monthly"
    );
    // No amount yet → bare slug URL (still valid).
    expect(givebutterHostedUrl({ amount: "", monthly: false })).toBe("https://givebutter.com/example-campaign");
    // The slug is used in the hosted URL (definitely works per Givebutter share URLs).
    expect(givebutterHostedUrl({ amount: "10", monthly: false })).toContain(GIVEBUTTER_CAMPAIGN);
  });
});

describe("givebutter donar page source contract", () => {
  const donarSource = appSource.slice(appSource.indexOf("function DonarPage"));

  it("collapses the SV fiscal fields when the US Givebutter path is active", () => {
    // The form branches on isUsDonation(form): documento/razón social/teléfono/
    // dirección must NOT render for a US resident (only monto + monthly + widget).
    expect(donarSource).toContain("isUsDonation(");
  });

  it("shows the FMCE explanation and the example-campaign giving form", () => {
    expect(appSource).toContain("GIVEBUTTER_INTRO");
    expect(GIVEBUTTER_INTRO).toContain("Friends of Misión ExampleOrganization");
    expect(GIVEBUTTER_INTRO).toContain("501(c)(3)");
    // The embedded custom element targets the campaign.
    expect(donarSource).toContain("givebutter-giving-form");
    expect(donarSource).toContain("GIVEBUTTER_CAMPAIGN");
  });

  it("injects the Givebutter script only for the US path, once per page load", () => {
    expect(appSource).toContain("GIVEBUTTER_SCRIPT_URL");
    // Guarded like the Wompi injection: a querySelector check prevents a second tag.
    expect(appSource).toContain('script[src="${GIVEBUTTER_SCRIPT_URL}"]');
  });

  it("prefills the amount/frequency into the page URL via history.replaceState", () => {
    expect(appSource).toContain("givebutterPrefillParams(");
    expect(appSource).toContain("history.replaceState");
  });

  it("removes the prefill params when leaving the US path (clean unmount)", () => {
    // The effect cleanup restores the URL so the fiscal fields / Wompi path is clean.
    expect(appSource).toContain("GIVEBUTTER_RENDER_TIMEOUT_MS");
  });

  it("renders the mandatory hosted-page fallback link with the slug URL", () => {
    expect(appSource).toContain("givebutterHostedUrl(");
    expect(appSource).toContain("GIVEBUTTER_FALLBACK_CTA");
    expect(appSource).toContain("GIVEBUTTER_FALLBACK_HINT");
    // Opens in a new tab.
    expect(donarSource).toContain('target="_blank"');
  });

  it("offers a Donación mensual toggle mapping to frequency=monthly", () => {
    expect(appSource).toContain("GIVEBUTTER_MONTHLY_LABEL");
    expect(GIVEBUTTER_MONTHLY_LABEL).toBe("Donación mensual");
  });

  it("offers the escape hatch back to the SV fiscal (CDE) form", () => {
    expect(appSource).toContain("GIVEBUTTER_ESCAPE_HATCH");
    expect(GIVEBUTTER_ESCAPE_HATCH).toContain("CDE");
  });

  it("leaves the Wompi intent path untouched (non-US donors still submit an intent)", () => {
    // The non-US path still posts a donation intent through the shared helpers.
    expect(donarSource).toContain("donationIntentBody(");
    expect(donarSource).toContain("DONAR_INTENT_PATH");
    // No Givebutter-specific backend endpoint is introduced.
    expect(appSource).not.toContain("/api/givebutter");
  });
});
