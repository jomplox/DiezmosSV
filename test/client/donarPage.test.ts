import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DONAR_AMOUNT_CHIPS,
  DONAR_BACK_LABEL,
  DONAR_CONTINUE_LABEL,
  DONAR_DOMESTIC_DEPARTMENTS,
  DONAR_EDIT_LABEL,
  DONAR_FALLBACK_MESSAGE,
  DONAR_FOREIGN_COUNTRIES,
  DONAR_FOREIGN_GEOGRAPHY_CODE,
  DONAR_HERO_PLACEHOLDER,
  DONAR_INTENT_PATH,
  DONAR_POLL_INTERVAL_MS,
  DONAR_POLL_TIMEOUT_MS,
  DONAR_SCRIPT_TIMEOUT_MS,
  DONAR_STEP_COUNT_SV,
  DONAR_STEP_COUNT_US,
  DONAR_THANK_YOU_BODY,
  DONAR_THANK_YOU_TITLE,
  DONAR_WIDGET_DELAYED_MESSAGE,
  DONAR_WIDGET_FALLBACK_CTA,
  DONAR_WIDGET_LOADING_MESSAGE,
  DONAR_WOMPI_CHECKOUT_ORIGIN,
  GIVEBUTTER_ACCOUNT_ID,
  GIVEBUTTER_CAMPAIGN,
  GIVEBUTTER_ENGLISH_NOTICE,
  GIVEBUTTER_FALLBACK_CTA,
  GIVEBUTTER_FALLBACK_HINT,
  GIVEBUTTER_FREQ_MONTHLY_LABEL,
  GIVEBUTTER_FREQ_ONCE_LABEL,
  GIVEBUTTER_INTRO,
  GIVEBUTTER_MONTHLY_LABEL,
  GIVEBUTTER_RENDER_TIMEOUT_MS,
  GIVEBUTTER_SCRIPT_URL,
  GIVEBUTTER_US_COUNTRY_CODE,
  DONAR_CHANGE_DOOR_LABEL,
  DONAR_DOOR_EEUU_DESC,
  DONAR_DOOR_EEUU_LABEL,
  DONAR_DOOR_SV_DESC,
  DONAR_DOOR_SV_LABEL,
  DONAR_GIFT_TYPE_LABEL,
  DONAR_LANDING_HEADING,
  DONAR_LANDING_SUBTITLE,
  DONAR_LANDING_UNIFIER,
  DONAR_ROUTE_PARAM,
  donarAmountDisplay,
  donarDatosPath,
  donarStepIndicator,
  doorFromSearch,
  routeParamForDoor,
  donationAmountValidationMessage,
  donationDatosBody,
  donationDraftBody,
  donationFormValidationMessage,
  donationIntentBody,
  donationStep1ValidationMessage,
  donationStep2ValidationMessage,
  draftMatchesForm,
  givebutterHostedUrl,
  givebutterPrefillParams,
  isUsDonation,
  graciasDisplayFromSearch,
  isDonarGraciasPath,
  isDonarPath,
  widgetUrlFrom
} from "../../src/client/donation";

// The donor-facing wizard lives in its own module (src/client/donarPage.tsx);
// App.tsx keeps only the thin path branch that mounts it. Source-contract
// assertions read whichever file now owns the markup.
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const donarSource = readFileSync(resolve(import.meta.dirname, "../../src/client/donarPage.tsx"), "utf8");
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

  it("keeps App.tsx as the thin mount: the wizard lives in the extracted donarPage module", () => {
    // The components are imported from the dedicated module...
    expect(appSource).toContain('from "./donarPage"');
    // ...and no longer defined inline in App.tsx.
    expect(appSource).not.toContain("function DonarPage");
    expect(appSource).not.toContain("function DonarThankYou");
    expect(appSource).not.toContain("function DonarGraciasPage");
    expect(donarSource).toContain("function DonarPage");
    expect(donarSource).toContain("function DonarThankYou");
    expect(donarSource).toContain("function DonarGraciasPage");
  });
});

describe("donar form validation", () => {
  // Name and email are no longer collected on the form — the donor types them on
  // Wompi's hosted sheet — so the validated input carries only documento, teléfono,
  // dirección, and monto.
  const base = {
    amount: "10.00",
    giftType: "DIEZMO" as const,
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

  it("requires the donor to choose diezmo or ofrenda first", () => {
    expect(donationFormValidationMessage({ ...base, giftType: "" })).toBe("Seleccione si es diezmo u ofrenda.");
    expect(donationFormValidationMessage({ ...base, giftType: "OFRENDA" })).toBe("");
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

  describe("per-step split (wizard)", () => {
    it("step 1 validates only the gift type and the amount", () => {
      expect(donationStep1ValidationMessage({ giftType: "", amount: "10.00" })).toBe("Seleccione si es diezmo u ofrenda.");
      expect(donationStep1ValidationMessage({ giftType: "DIEZMO", amount: "" })).toBe("Ingrese un monto válido en dólares.");
      expect(donationStep1ValidationMessage({ giftType: "DIEZMO", amount: "0.50" })).toBe("El monto mínimo de donación es $1.00.");
      expect(donationStep1ValidationMessage({ giftType: "OFRENDA", amount: "5.00" })).toBe("");
    });

    it("the amount rule is reusable alone (US Paso 1 has no gift type)", () => {
      expect(donationAmountValidationMessage("")).toBe("Ingrese un monto válido en dólares.");
      expect(donationAmountValidationMessage("abc")).toBe("Ingrese un monto válido en dólares.");
      expect(donationAmountValidationMessage("0.99")).toBe("El monto mínimo de donación es $1.00.");
      expect(donationAmountValidationMessage("1")).toBe("");
      expect(donationAmountValidationMessage("125.00")).toBe("");
    });

    it("step 2 validates identity + address and ignores the step-1 fields", () => {
      // Amount/giftType are already locked by Paso 1: garbage there must not block Paso 2.
      const step2Valid = { ...base, amount: "", giftType: "" as const };
      expect(donationStep2ValidationMessage(step2Valid)).toBe("");
      expect(donationStep2ValidationMessage({ ...step2Valid, donorDocument: "04182769-0" })).toBe("Revise el número de DUI.");
      expect(donationStep2ValidationMessage({ ...step2Valid, departamento: "" })).toBe("Seleccione un departamento.");
      expect(donationStep2ValidationMessage({ ...step2Valid, complemento: " " })).toBe("Ingrese su dirección.");
    });

    it("the full validator is exactly step 1 then step 2 (messages and order unchanged)", () => {
      const samples = [
        base,
        { ...base, giftType: "" as const },
        { ...base, amount: "0" },
        { ...base, donorDocument: "04182769-0" },
        { ...base, departamento: "" },
        { ...base, complemento: "  " },
        { ...base, foreignResident: true, pais: "", departamento: "", municipio: "", distrito: "" }
      ];
      for (const sample of samples) {
        expect(donationFormValidationMessage(sample)).toBe(
          donationStep1ValidationMessage(sample) || donationStep2ValidationMessage(sample)
        );
      }
    });
  });
});

describe("donar amount chips", () => {
  it("offers the $5 / $10 / $25 / $50 quick amounts", () => {
    expect(DONAR_AMOUNT_CHIPS).toEqual([5, 10, 25, 50]);
  });
});

describe("donar wizard helpers", () => {
  it("labels the steps as 'Paso n de m'", () => {
    expect(donarStepIndicator(1, 3)).toBe("Paso 1 de 3");
    expect(donarStepIndicator(2, 3)).toBe("Paso 2 de 3");
    expect(donarStepIndicator(2, 2)).toBe("Paso 2 de 2");
  });

  it("counts 3 SV steps (monto, datos, pago) and 2 US steps (monto, Givebutter)", () => {
    expect(DONAR_STEP_COUNT_SV).toBe(3);
    expect(DONAR_STEP_COUNT_US).toBe(2);
  });

  it("formats the summary amount as a two-decimal dollar figure", () => {
    expect(donarAmountDisplay("125")).toBe("$125.00");
    expect(donarAmountDisplay("12.5")).toBe("$12.50");
    expect(donarAmountDisplay(" 25.00 ")).toBe("$25.00");
    // Only rendered after Paso 1 validates, but degrade gracefully anyway.
    expect(donarAmountDisplay("")).toBe("$0.00");
  });

  it("pins the wizard chrome labels", () => {
    expect(DONAR_CONTINUE_LABEL).toBe("Continuar");
    expect(DONAR_BACK_LABEL).toBe("← Atrás");
    expect(DONAR_EDIT_LABEL).toBe("Editar");
    expect(DONAR_HERO_PLACEHOLDER).toBe("0.00");
    // US Paso 1 segmented control: Única | Mensual.
    expect(GIVEBUTTER_FREQ_ONCE_LABEL).toBe("Única");
    expect(GIVEBUTTER_FREQ_MONTHLY_LABEL).toBe("Mensual");
  });
});

describe("donar intent body", () => {
  const base = {
    amount: " 10.00 ",
    giftType: "DIEZMO" as const,
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
      giftType: "DIEZMO",
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

  it("omits giftType when none is chosen (legacy / US callers)", () => {
    expect(donationIntentBody({ ...base, giftType: "" }).giftType).toBeUndefined();
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

describe("donar premint (background draft + datos completion)", () => {
  const base = {
    amount: " 10.00 ",
    giftType: "DIEZMO" as const,
    donorDocumentType: "13" as const,
    donorDocument: "10000001-9",
    donorName: "",
    donorPhone: "70001122",
    foreignResident: false,
    pais: "",
    departamento: "06",
    municipio: "23",
    distrito: "14",
    complemento: "San Salvador"
  };

  it("the draft body carries only the trimmed amount + gift type (no donor data)", () => {
    expect(donationDraftBody(base)).toEqual({ amount: "10.00", giftType: "DIEZMO" });
    // No document/address keys: the server treats this as a draft create.
    expect(donationDraftBody(base)).not.toHaveProperty("donorDocument");
    expect(donationDraftBody(base)).not.toHaveProperty("departamento");
  });

  it("the draft body omits giftType when none is chosen (never sends an empty string)", () => {
    expect(donationDraftBody({ amount: "25", giftType: "" }).giftType).toBeUndefined();
  });

  it("the datos body carries the donor fiscal data ONLY (no amount, no giftType)", () => {
    const body = donationDatosBody(base);
    expect(body).not.toHaveProperty("amount");
    expect(body).not.toHaveProperty("giftType");
    // Same field mapping as the full intent body minus amount/giftType.
    expect(body).toMatchObject({
      donorDocumentType: "13",
      donorDocument: "10000001-9",
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "San Salvador"
    });
  });

  it("the datos body mirrors the full body's NIT razón social and foreign-path rules", () => {
    const nit = donationDatosBody({ ...base, donorDocumentType: "36", donorDocument: "0614-280390-112-1", donorName: " Empresa " });
    expect(nit.donorName).toBe("Empresa");
    const foreign = donationDatosBody({ ...base, foreignResident: true, pais: "US", departamento: "", municipio: "", distrito: "" });
    expect(foreign).toMatchObject({ departamento: DONAR_FOREIGN_GEOGRAPHY_CODE, pais: "US" });
  });

  it("builds the datos path from the intent id", () => {
    expect(donarDatosPath("di_abc123")).toBe("/api/donations/intent/di_abc123/datos");
  });

  it("treats a draft as fresh only when both the amount and the gift type still match", () => {
    const draft = { amount: "10.00", giftType: "DIEZMO" as const };
    expect(draftMatchesForm(draft, base)).toBe(true);
    // Edited amount → stale (abandon and full-POST).
    expect(draftMatchesForm(draft, { ...base, amount: "20.00" })).toBe(false);
    // Switched Diezmo → Ofrenda → stale.
    expect(draftMatchesForm(draft, { ...base, giftType: "OFRENDA" })).toBe(false);
  });
});

describe("donar premint source contract", () => {
  it("mints the draft link in the background on the SV Paso 1→2 transition", () => {
    // The background mint fires inside continueFromMonto (the else / SV branch), posting
    // only the draft body, and must NOT block the step change.
    expect(donarSource).toContain("mintDraftIntent(");
    expect(donarSource).toContain("donationDraftBody(");
    // Fire-and-forget: no await on the draft create, errors swallowed.
    expect(donarSource).toContain("void donarApi");
    expect(donarSource).toContain("setDraftIntent(");
  });

  it("completes via the datos endpoint on Paso 2 submit, with a full-POST fallback", () => {
    // Fast path: a matching draft → datos call, reuse its link, advance immediately.
    expect(donarSource).toContain("draftMatchesForm(draftIntent, form)");
    expect(donarSource).toContain("donarDatosPath(draftIntent.intent.intentId)");
    expect(donarSource).toContain("donationDatosBody(form)");
    // Fallback: no usable draft → the existing full-body POST still works.
    expect(donarSource).toContain("donationIntentBody(form)");
  });

  it("abandons a stale draft when the donor edits the amount or tipo (no extra deactivation call)", () => {
    // Atrás from Paso 2 and Editar from Paso 3 both clear the held draft; the sweep
    // expires its link. There is no new deactivation call in the client.
    expect(donarSource).toContain("setDraftIntent(null)");
    expect(donarSource).not.toContain("deactivate");
  });

  it("keeps the Paso 2 submit copy exactly as before", () => {
    // The premint must not touch any donor-facing copy.
    expect(donarSource).toContain("Preparando su entrega…");
    expect(donarSource).toContain("Continuar con su diezmo");
    expect(donarSource).toContain("Continuar con su ofrenda");
  });
});

describe("donar widget handoff", () => {
  it("feeds the widget urlEnlaceLargo with the esWidget flag appended", () => {
    expect(widgetUrlFrom("https://mock.wompi.sv/enlace-largo/abc?x=1")).toBe(
      "https://mock.wompi.sv/enlace-largo/abc?x=1&esWidget=1"
    );
  });

  it("polls the public intent status endpoint every ~5s and stops after ~3 minutes", () => {
    expect(DONAR_INTENT_PATH).toBe("/api/donations/intent");
    expect(DONAR_POLL_INTERVAL_MS).toBe(5_000);
    expect(DONAR_POLL_TIMEOUT_MS).toBe(180_000);
    // Script/widget-render fallback timeout is short.
    expect(DONAR_SCRIPT_TIMEOUT_MS).toBeLessThanOrEqual(6_000);
  });

  it("closes the poll with a neutral message that never implies failure", () => {
    // Entrega framing: these are diezmos y ofrendas, never "pagos".
    expect(DONAR_FALLBACK_MESSAGE).toBe(
      "Si completó su entrega, recibirá su comprobante de donación por correo electrónico. Puede cerrar esta página."
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

  it("uses the webhook-driven thank-you copy with a religious blessing", () => {
    expect(DONAR_THANK_YOU_TITLE).toBe("Dios le bendiga. Su aportación fue recibida.");
    // User-centered wording: "comprobante de donación", no CDE initials, no "pago".
    expect(DONAR_THANK_YOU_BODY).toBe(
      "Recibirá su comprobante de donación por correo electrónico cuando el Ministerio de Hacienda lo confirme."
    );
  });
});

describe("donar wizard source contract", () => {
  it("labels the form fields in usted-form Spanish with the diezmo/ofrenda heading", () => {
    // Religious framing: the SV fiscal form heading names the aportación, now
    // flagged with the El Salvador emoji instead of a textual path identifier.
    expect(donarSource).toContain("Entregue su diezmo u ofrenda 🇸🇻");
    expect(donarSource).toContain("Tipo de documento");
    expect(donarSource).toContain("Teléfono (opcional)");
    expect(donarSource).toContain("Departamento");
    expect(donarSource).toContain("Municipio");
    expect(donarSource).toContain("Distrito");
    expect(donarSource).toContain("Dirección");
    expect(donarSource).toContain("Monto");
  });

  it("renders Diezmo|Ofrenda as a segmented radiogroup of real radio inputs", () => {
    expect(donarSource).toContain("DONAR_GIFT_TYPE_LABEL");
    expect(donarSource).toContain("DONAR_GIFT_TYPE_FIELD_LABEL");
    // Givebutter-style segmented control: real radios styled as two inverted halves.
    expect(donarSource).toContain('role="radiogroup"');
    expect(donarSource).toContain('type="radio"');
    expect(donarSource).toContain('name="donar-gift-type"');
    expect(donarSource).toContain('form.giftType === option ? "donar-segment-option active" : "donar-segment-option"');
    expect(DONAR_GIFT_TYPE_LABEL.DIEZMO).toBe("Diezmo");
    expect(DONAR_GIFT_TYPE_LABEL.OFRENDA).toBe("Ofrenda");
  });

  it("presents the wizard in three SV steps with a step indicator and per-step back affordances", () => {
    // "Paso n de m" chrome (Gotham Book gray) at the card top.
    expect(donarSource).toContain("donarStepIndicator(");
    expect(donarSource).toContain("donar-step-indicator");
    // Back affordances: "← Atrás" on later steps; "← Cambiar opción" only on Paso 1.
    expect(donarSource).toContain("DONAR_BACK_LABEL");
    expect(donarSource).toContain("DONAR_CHANGE_DOOR_LABEL");
  });

  it("makes the amount the hero: giant $-prefixed decimal input, no 'Otro monto' field", () => {
    expect(donarSource).toContain("donar-hero-amount");
    expect(donarSource).toContain("DONAR_HERO_PLACEHOLDER");
    expect(donarSource).toContain('inputMode="decimal"');
    // The old afterthought text field is gone everywhere.
    expect(donarSource).not.toContain("Otro monto");
    expect(appSource).not.toContain("Otro monto");
  });

  it("keeps the preset quick-fills as pill chips that fill the hero input", () => {
    expect(donarSource).toContain("DONAR_AMOUNT_CHIPS");
    expect(donarSource).toContain('form.amount === chip.toFixed(2) ? "donar-chip active" : "donar-chip"');
  });

  it("moves focus to the step's first control on advance", () => {
    expect(donarSource).toContain(".focus()");
  });

  it("shows a Paso 3 summary line with an Editar link back to Paso 1", () => {
    expect(donarSource).toContain("donar-summary");
    expect(donarSource).toContain("DONAR_EDIT_LABEL");
    expect(donarSource).toContain("donarAmountDisplay(");
  });

  it("frames the Paso 2 submit around the chosen gift, never a 'pago'", () => {
    // The label names the donor's own diezmo or ofrenda (giftType is always set on
    // the SV door — Diezmo is preselected).
    expect(donarSource).toContain("Continuar con su ofrenda");
    expect(donarSource).toContain("Continuar con su diezmo");
    expect(donarSource).not.toContain('"Donar"');
  });

  it("shows the EE. UU. flow its own heading, flagged with the US emoji", () => {
    expect(donarSource).toContain("Diezmos y Ofrendas 🇺🇸");
    // The old textual "— EE. UU." path identifier is replaced by the flag emoji.
    expect(donarSource).not.toContain("Diezmos y Ofrendas — EE. UU.");
  });

  it("preselects Diezmo so the SV Paso 1 segmented control starts checked", () => {
    // The gift type defaults to DIEZMO on mount: the donor lands with Diezmo
    // already selected, so the "elija un tipo" validation never fires in normal flow.
    expect(donarSource).toContain('giftType: "DIEZMO"');
    expect(donarSource).not.toContain('giftType: ""');
  });

  it("assures each door's donor of the legal document their path produces on Paso 1", () => {
    // Right under the Paso 1 heading, a Gotham Book gray subtitle names the
    // comprobante that path yields — reassurance of the door they just chose.
    expect(donarSource).toContain("Recibirá su comprobante de donación en su dirección de correo electrónico.");
    expect(donarSource).toContain("Recibirá un recibo oficial deducible de impuestos (IRS 501(c)(3)) en su dirección de correo electrónico.");
    expect(donarSource).toContain("donar-assurance");
  });

  it("no longer collects name or email on the form (both are entered on Wompi's sheet)", () => {
    // Wompi's hosted sheet requires and asks only for name + email, so the form
    // must not render those fields — and must tell the donor what comes next.
    expect(donarSource).not.toContain("Nombre completo");
    expect(donarSource).not.toContain("Correo electrónico");
    expect(donarSource).toContain("Su nombre y correo se ingresan al pagar con Wompi.");
  });

  it("wires cascading municipio/distrito selects to the department-scoped catalog helpers", () => {
    expect(donarSource).toContain("getCat013Municipalities(");
    expect(donarSource).toContain("getCat008Districts(");
  });

  it("auto-formats and check-digit-validates the DUI on blur via the shared helpers", () => {
    expect(donarSource).toContain("formatDui(");
    expect(donarSource).toContain("isValidDui(");
    expect(donarSource).toContain("onBlur=");
    // The "Revise el número de DUI." copy lives in donationFormValidationMessage.
    expect(donationFormValidationMessage).toBeTypeOf("function");
  });

  it("offers the five CAT-022 document types with donor-facing labels in the agreed order", () => {
    // Donor-facing labeling: CAT-022 "36" shows as "Empresa" on /donar, NOT "NIT" —
    // many natural persons still hold legacy personal NITs and a literal "NIT"
    // option would bait them into the razón-social requirement. The stored code
    // stays "36"; the admin quick-CDE keeps the raw CAT022_DOCUMENT_TYPES labels.
    // Order: DUI, Empresa, Otro, Pasaporte, Carnet de Residente.
    const donarStart = donarSource.indexOf("function DonarPage");
    expect(donarStart).toBeGreaterThan(-1);
    const pageSource = donarSource.slice(donarStart);
    let previous = -1;
    for (const option of ['value="13">DUI<', 'value="36">Empresa<', 'value="37">Otro<', 'value="03">Pasaporte<', 'value="02">Carnet de Residente<']) {
      const at = pageSource.indexOf(option);
      expect(at, `missing or out of order: ${option}`).toBeGreaterThan(previous);
      previous = at;
    }
    // The bait label never appears on the donor-facing select.
    expect(pageSource).not.toContain('value="36">NIT<');
  });

  it("auto-formats a valid 14-digit NIT on blur, mirroring the DUI blur behavior", () => {
    expect(donarSource).toContain("formatNit(");
    expect(donarSource).toContain("isValidNitFormat(");
  });

  it("presents the empresa field pair: NIT de la empresa + required razón social", () => {
    const pageSource = donarSource.slice(donarSource.indexOf("function DonarPage"));
    // The document input is labeled "NIT de la empresa" while Empresa is selected...
    expect(pageSource).toContain("NIT de la empresa");
    // ...alongside the required razón social, both keyed on the 36 document type.
    expect(pageSource).toContain("Razón social");
    expect(pageSource).toContain('donorDocumentType === "36"');
  });

  it("wires the extranjero toggle above the address block, swapping geography for a país select", () => {
    const pageSource = donarSource.slice(donarSource.indexOf("function DonarPage"));
    expect(pageSource).toContain("Resido en el extranjero");
    // Checked → the país select (CAT-020 minus SV) replaces departamento/municipio/distrito.
    expect(pageSource).toContain("DONAR_FOREIGN_COUNTRIES");
    expect(pageSource).toContain("País");
    expect(pageSource).toContain("foreignResident");
    // The toggle renders BEFORE the address selects in the form markup.
    const toggleAt = pageSource.indexOf("Resido en el extranjero");
    const departamentoAt = pageSource.indexOf("<span>Departamento</span>");
    expect(toggleAt).toBeGreaterThan(-1);
    expect(departamentoAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeLessThan(departamentoAt);
  });

  it("submits the intent body through the shared donationIntentBody helper", () => {
    expect(donarSource).toContain("donationIntentBody(");
  });

  it("disables the submit button while preparing the payment", () => {
    expect(donarSource).toContain("Preparando su entrega…");
  });

  it("validates per step: Paso 1 gates on the step-1 rules, Paso 2 on the rest", () => {
    expect(donarSource).toContain("donationStep1ValidationMessage(");
    expect(donarSource).toContain("donationStep2ValidationMessage(");
  });

  it("renders the Wompi checkout embedded in Paso 3 via a plain iframe", () => {
    // The checkout page (urlEnlaceLargo + esWidget=1) allows cross-origin framing —
    // verified live: no X-Frame-Options, no frame-ancestors — and Wompi's own modal
    // widget iframes the exact same URL with a plain {src, onLoad} iframe. Embedding
    // it directly keeps the donor inside the wizard: no popup, no overlay.
    expect(donarSource).toContain("<iframe");
    expect(donarSource).toContain('className="donar-embed"');
    expect(donarSource).toContain("src={widgetUrlFrom(intent.urlEnlaceLargo)}");
    expect(stylesSource).toContain(".donar-embed");
  });

  it("ships no Wompi script machinery: the embed needs no script, scan, or auto-click", () => {
    // wompi.pagos.js scans for .wompi_button_widget divs exactly once at script
    // evaluation (fragile in an SPA whose div appears on Paso 3), and its
    // button+modal flow needed an auto-click. The inline iframe replaces all of it.
    expect(donarSource).not.toContain("wompi_button_widget");
    expect(donarSource).not.toContain("DONAR_WOMPI_SCRIPT_URL");
    expect(donarSource).not.toContain("autoClickedRef");
  });

  it("never auto-redirects away from Paso 3 — leaving is always donor-initiated", () => {
    // Exactly one window.location.href assignment exists in the wizard: the manual
    // "Continúe aquí" backup button under the embed.
    const assignments = donarSource.match(/window\.location\.href\s*=/g) ?? [];
    expect(assignments).toHaveLength(1);
    const at = donarSource.indexOf("window.location.href =");
    expect(donarSource.slice(at, at + 260)).toContain("¿No se muestra el formulario? Continúe aquí");
    // The slow path renders a prominent hosted-checkout anchor, not a redirect.
    expect(donarSource).toContain("DONAR_WIDGET_FALLBACK_CTA");
    expect(donarSource).toContain("donar-widget-fallback");
    expect(DONAR_WIDGET_FALLBACK_CTA).toBe("Continuar en Wompi");
  });

  it("shows a loading indicator until the embedded checkout loads", () => {
    // handoff: "loading" (spinner) → "ready" via the iframe's onLoad; if the render
    // budget (DONAR_SCRIPT_TIMEOUT_MS) elapses first, "delayed" adds the hosted CTA
    // while the iframe keeps loading underneath.
    expect(donarSource).toContain("DONAR_WIDGET_LOADING_MESSAGE");
    expect(donarSource).toContain("DONAR_WIDGET_DELAYED_MESSAGE");
    expect(donarSource).toContain("onLoad");
    expect(donarSource).toContain("DONAR_SCRIPT_TIMEOUT_MS");
    expect(DONAR_WIDGET_LOADING_MESSAGE).toContain("Preparando su entrega");
    expect(DONAR_WIDGET_DELAYED_MESSAGE).toContain("Wompi");
    // Spinner is announced to assistive tech and styled monochrome in CSS.
    expect(donarSource).toContain('role="status"');
    expect(stylesSource).toContain(".donar-spinner");
    // Reduced-motion users get a static indicator, not a spinning ring.
    const reducedMotion = stylesSource.indexOf("prefers-reduced-motion");
    expect(reducedMotion).toBeGreaterThan(-1);
    expect(stylesSource.slice(reducedMotion)).toContain(".donar-spinner");
  });

  it("preconnects to the checkout host while the donor fills the form", () => {
    // DNS + TLS to pagos.wompi.sv are warmed on wizard mount, so the Paso 3 embed
    // skips connection setup on mobile networks.
    expect(donarSource).toContain('"preconnect"');
    expect(donarSource).toContain("DONAR_WOMPI_CHECKOUT_ORIGIN");
    expect(DONAR_WOMPI_CHECKOUT_ORIGIN).toBe("https://pagos.wompi.sv");
  });

  it("keeps the manual backup button and 'Continúe aquí' link visible", () => {
    // The modal can be closed and reopened, so the manual path stays on screen.
    expect(donarSource).toContain("¿No se muestra el formulario? Continúe aquí");
  });

  it("ships donation styles reusing the auth/card visual language", () => {
    expect(stylesSource).toContain(".donar-");
  });

  it("enforces the postMessage origin on the DONAR_COMPLETED_MESSAGE listener", () => {
    // The gracias page inside the modal iframe is same-origin, so the listener must
    // reject messages whose origin differs from window.location.origin — otherwise the
    // Wompi widget iframe (which holds window.parent) could spoof the thank-you state.
    const listenerStart = donarSource.indexOf("function onMessage(event: MessageEvent)");
    expect(listenerStart).toBeGreaterThan(-1);
    const completedCheck = donarSource.indexOf("DONAR_COMPLETED_MESSAGE", listenerStart);
    expect(completedCheck).toBeGreaterThan(-1);
    const originCheck = donarSource.indexOf("event.origin !== window.location.origin", listenerStart);
    expect(originCheck).toBeGreaterThan(-1);
    // The origin guard must appear before (or with) the message check, inside the listener.
    expect(originCheck).toBeLessThan(completedCheck);
  });

  it("posts the completed message to the same origin, never the wildcard target", () => {
    const senderStart = donarSource.indexOf("window.parent.postMessage(DONAR_COMPLETED_MESSAGE");
    expect(senderStart).toBeGreaterThan(-1);
    const senderCall = donarSource.slice(senderStart, senderStart + 120);
    expect(senderCall).toContain("window.location.origin");
    expect(senderCall).not.toContain('"*"');
  });
});

describe("donar wizard styles contract", () => {
  it("wraps the wizard in a soft-shadowed 16px-radius card", () => {
    const cardRule = stylesSource.match(/\.donar-card\s*\{[^}]*\}/)?.[0] ?? "";
    expect(cardRule).toContain("border-radius: 16px");
    expect(cardRule).toContain("box-shadow");
  });

  it("sizes the hero amount input in the 48-56px Gotham range", () => {
    const heroRule = stylesSource.match(/\.donar-hero-amount input\s*\{[^}]*\}/)?.[0] ?? "";
    expect(heroRule).toMatch(/font-size:\s*(4[89]|5[0-6])px/);
  });

  it("gives the primary button and segmented control 48px+ touch targets", () => {
    const primaryRule = stylesSource.match(/\.donar-card\s+\.primary\s*\{[^}]*\}/)?.[0] ?? "";
    expect(primaryRule).toMatch(/min-height:\s*(4[89]|5[0-6])px/);
    const segmentOption = stylesSource.match(/\.donar-segment-option\s*\{[^}]*\}/)?.[0] ?? "";
    expect(segmentOption).toMatch(/min-height:\s*(4[89]|5[0-6])px/);
  });

  it("inverts the active segment half to black (monochrome, no teal)", () => {
    const activeSegment = stylesSource.match(/\.donar-segment-option\.active\s*\{[^}]*\}/)?.[0] ?? "";
    expect(activeSegment).toMatch(/#000|#111/i);
    expect(activeSegment).not.toContain("#007c75");
  });

  it("respects prefers-reduced-motion on the step transition", () => {
    expect(stylesSource).toContain(".donar-step");
    expect(stylesSource).toMatch(/prefers-reduced-motion[\s\S]{0,800}\.donar-step/);
  });
});

describe("givebutter constants", () => {
  it("pins the FMCE account id and example-campaign campaign", () => {
    expect(GIVEBUTTER_ACCOUNT_ID).toBe("EXAMPLEACCT00001");
    expect(GIVEBUTTER_CAMPAIGN).toBe("example-campaign");
  });

  it("pins the official Givebutter widget script URL scoped to the account", () => {
    expect(GIVEBUTTER_SCRIPT_URL).toBe("https://widgets.givebutter.com/latest.umd.cjs?acct=EXAMPLEACCT00001");
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
  const pageSource = donarSource.slice(donarSource.indexOf("function DonarPage"));

  it("collapses the SV fiscal fields when the US Givebutter path is active", () => {
    // The form branches on isUsDonation(form): documento/razón social/teléfono/
    // dirección must NOT render for a US resident (only monto + frequency + widget).
    expect(pageSource).toContain("isUsDonation(");
  });

  it("shares Paso 1 with the SV door: hero amount + Única|Mensual segmented control", () => {
    // The US door renders the SAME hero amount input and pill chips, with the
    // monthly toggle restyled as the segmented control (real radios).
    expect(pageSource).toContain('name="donar-frequency"');
    expect(pageSource).toContain("GIVEBUTTER_FREQ_ONCE_LABEL");
    expect(pageSource).toContain("GIVEBUTTER_FREQ_MONTHLY_LABEL");
    // The pinned Spanish label still names the control for screen readers.
    expect(pageSource).toContain("GIVEBUTTER_MONTHLY_LABEL");
    expect(GIVEBUTTER_MONTHLY_LABEL).toBe("Donación mensual");
  });

  it("shows the FMCE explanation and the example-campaign giving form", () => {
    expect(donarSource).toContain("GIVEBUTTER_INTRO");
    expect(GIVEBUTTER_INTRO).toContain("Friends of Misión ExampleOrganization");
    expect(GIVEBUTTER_INTRO).toContain("501(c)(3)");
    // The US door funds the SAME church — the intro says so, never implying a
    // different beneficiary.
    expect(GIVEBUTTER_INTRO).toContain("apoya a Misión ExampleOrganization en El Salvador");
    // The embedded custom element targets the campaign.
    expect(pageSource).toContain("givebutter-giving-form");
    expect(pageSource).toContain("GIVEBUTTER_CAMPAIGN");
  });

  it("uses human GiveButter anchor text, never a raw URL, in the fallback CTA and hint", () => {
    // Brand style: capital G, capital B. "GiveButter" is the anchor text.
    expect(GIVEBUTTER_FALLBACK_CTA).toBe("Donar en GiveButter");
    expect(GIVEBUTTER_FALLBACK_HINT).toBe("¿Problemas con el formulario? Done en GiveButter");
    // No raw givebutter.com URL is shown to the donor in either string.
    expect(GIVEBUTTER_FALLBACK_CTA).not.toContain("givebutter.com");
    expect(GIVEBUTTER_FALLBACK_HINT).not.toContain("givebutter.com");
  });

  it("injects the Givebutter script only for the US path, once per page load", () => {
    expect(donarSource).toContain("GIVEBUTTER_SCRIPT_URL");
    // Guarded like the Wompi injection: a querySelector check prevents a second tag.
    expect(donarSource).toContain('script[src="${GIVEBUTTER_SCRIPT_URL}"]');
  });

  it("prefills the amount/frequency into the page URL via history.replaceState", () => {
    expect(donarSource).toContain("givebutterPrefillParams(");
    expect(donarSource).toContain("history.replaceState");
  });

  it("removes the prefill params when leaving the US path (clean unmount)", () => {
    // The effect cleanup restores the URL so the fiscal fields / Wompi path is clean.
    expect(donarSource).toContain("GIVEBUTTER_RENDER_TIMEOUT_MS");
  });

  it("renders the mandatory hosted-page fallback link with the slug URL", () => {
    expect(donarSource).toContain("givebutterHostedUrl(");
    expect(donarSource).toContain("GIVEBUTTER_FALLBACK_CTA");
    expect(donarSource).toContain("GIVEBUTTER_FALLBACK_HINT");
    // Opens in a new tab.
    expect(pageSource).toContain('target="_blank"');
  });

  it("no longer offers the US-path escape hatch back to the SV fiscal form", () => {
    // The donor deliberately chose the EE. UU. door; "← Cambiar opción" is the way
    // back. The forceFiscal escape hatch (and its state) is gone.
    expect(donarSource).not.toContain("GIVEBUTTER_ESCAPE_HATCH");
    expect(donarSource).not.toContain("forceFiscal");
    expect(donarSource).not.toContain("donar-givebutter-escape");
  });

  it("leaves the Wompi intent path untouched (non-US donors still submit an intent)", () => {
    // The non-US path still posts a donation intent through the shared helpers.
    expect(pageSource).toContain("donationIntentBody(");
    expect(pageSource).toContain("DONAR_INTENT_PATH");
    // No Givebutter-specific backend endpoint is introduced.
    expect(donarSource).not.toContain("/api/givebutter");
    expect(appSource).not.toContain("/api/givebutter");
  });
});

describe("two-door landing deep-link helpers", () => {
  it("reads ?ruta=sv / ?ruta=eeuu into a door, ignoring anything else", () => {
    expect(doorFromSearch("?ruta=sv")).toBe("sv");
    expect(doorFromSearch("?ruta=eeuu")).toBe("eeuu");
    expect(doorFromSearch("?ruta=SV")).toBeNull();
    expect(doorFromSearch("?ruta=other")).toBeNull();
    expect(doorFromSearch("")).toBeNull();
    // The prefill params the US path also writes never confuse the door read.
    expect(doorFromSearch("?amount=25&frequency=monthly&ruta=eeuu")).toBe("eeuu");
  });

  it("maps a chosen door back to its ?ruta value (null clears it)", () => {
    expect(routeParamForDoor("sv")).toBe("sv");
    expect(routeParamForDoor("eeuu")).toBe("eeuu");
    expect(routeParamForDoor(null)).toBeNull();
    expect(DONAR_ROUTE_PARAM).toBe("ruta");
  });
});

describe("two-door landing copy", () => {
  it("uses the Diezmos y Ofrendas heading and a residence-based subtitle", () => {
    expect(DONAR_LANDING_HEADING).toBe("Diezmos y Ofrendas");
    // Residence-based, not destination-based.
    expect(DONAR_LANDING_SUBTITLE).toBe("Elija según su lugar de residencia.");
  });

  it("pins the unifying line that both doors fund the same church in El Salvador", () => {
    expect(DONAR_LANDING_UNIFIER).toBe(
      "Todos los diezmos y ofrendas apoyan la obra de Misión ExampleOrganization en El Salvador."
    );
  });

  it("labels the two doors, their tax-receipt descriptors, and the change-option link", () => {
    expect(DONAR_DOOR_SV_LABEL).toBe("El Salvador y el mundo");
    expect(DONAR_DOOR_SV_DESC).toBe("Comprobante de donación DTE salvadoreño");
    expect(DONAR_DOOR_EEUU_LABEL).toBe("EE. UU.");
    expect(DONAR_DOOR_EEUU_DESC).toBe("Recibo oficial deducible de impuestos (IRS 501(c)(3))");
    expect(DONAR_CHANGE_DOOR_LABEL).toContain("Cambiar opción");
  });

  it("tells EE. UU. donors the payment form is in English", () => {
    expect(GIVEBUTTER_ENGLISH_NOTICE).toBe("El formulario se muestra en inglés.");
  });
});

describe("two-door landing source contract", () => {
  // The donor-landing surface begins at the inline icon components (OrganizationLogo,
  // SvWorldIcon, UsFlagIcon) which sit right above DonarPage and are only used there.
  const landingSource = donarSource.slice(donarSource.indexOf("function OrganizationLogo"));

  it("renders the landing heading, subtitle, unifier, and both door labels + descriptors", () => {
    expect(donarSource).toContain("DONAR_LANDING_HEADING");
    expect(donarSource).toContain("DONAR_LANDING_SUBTITLE");
    expect(donarSource).toContain("DONAR_LANDING_UNIFIER");
    expect(donarSource).toContain("DONAR_DOOR_SV_LABEL");
    expect(donarSource).toContain("DONAR_DOOR_SV_DESC");
    expect(donarSource).toContain("DONAR_DOOR_EEUU_LABEL");
    expect(donarSource).toContain("DONAR_DOOR_EEUU_DESC");
  });

  it("draws the SV door as the official flag asset over a globe, US as a circle-flag SVG", () => {
    // The US door keeps its inlined circle-flag SVG (MIT), verbatim.
    expect(landingSource).toContain("<svg");
    expect(landingSource).toContain("#d80027");
    expect(landingSource).toContain('mask id="us-flag-a"');
    // The SV door uses the OFFICIAL flag (flag-icons sv 1:1, full escudo) as a
    // circle-cropped <image> asset — internal SVG ids stay encapsulated.
    expect(donarSource).toContain('from "./assets/sv-flag.svg"');
    expect(landingSource).toContain("href={svFlag}");
    expect(landingSource).toContain("<image");
    expect(landingSource).toContain('clipPath id="sv-flag-circle"');
    // The simplified circle-flags inline paths are gone.
    expect(landingSource).not.toContain('mask id="sv-flag-a"');
    expect(landingSource).not.toContain("#ffda44");
    expect(landingSource).not.toContain("#6da544");
    // The old hand-drawn palette must still be gone.
    expect(landingSource).not.toContain("#0F47AF");
    expect(landingSource).not.toContain("#3C3B6E");
    expect(landingSource).not.toContain("#B22234");
    // The SV door keeps the line-art globe behind the flag.
    expect(landingSource).toContain('stroke="#595959"');
  });

  it("reuses the default logo vector paths on the landing", () => {
    // The landing shows the default logo. Its vector paths come from orgLogo.ts.
    expect(donarSource).toContain("ORG_LOGO_PATHS");
  });

  it("routes door 1 to the existing SV fiscal form and door 2 to the Givebutter block", () => {
    // A door state gates which view renders. Door 1 keeps the SV form (documento,
    // dirección, extranjero path); door 2 renders the Givebutter block directly.
    expect(landingSource).toMatch(/door === "sv"|door === "eeuu"|setDoor\(/);
    expect(landingSource).toContain("setDoor");
  });

  it("shows the change-option link from either door path", () => {
    expect(donarSource).toContain("DONAR_CHANGE_DOOR_LABEL");
  });

  it("shows the English-form notice on the EE. UU. door", () => {
    expect(donarSource).toContain("GIVEBUTTER_ENGLISH_NOTICE");
  });

  it("reads the deep-link on mount and writes it back via history.replaceState", () => {
    expect(donarSource).toContain("doorFromSearch(");
    expect(donarSource).toContain("routeParamForDoor(");
    // The door write composes with the URL, never clobbering existing params.
    expect(donarSource).toContain("history.replaceState");
  });
});

describe("Gotham brand webfonts + global stack", () => {
  it("registers @font-face for Book/Medium/Bold/Black with font-display: swap", () => {
    const faces = stylesSource.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(4);
    // Every declared face is the Gotham family, self-hosted as woff2, swap display.
    const gothamFaces = faces.filter((face) => /font-family:\s*"Gotham"/.test(face));
    expect(gothamFaces.length).toBeGreaterThanOrEqual(4);
    for (const face of gothamFaces) {
      expect(face).toContain("woff2");
      expect(face).toContain("font-display: swap");
    }
    // The four brand weights: 400 (Book), 500 (Medium), 700 (Bold), 900 (Black).
    for (const weight of ["400", "500", "700", "900"]) {
      expect(gothamFaces.some((face) => face.includes(`font-weight: ${weight}`))).toBe(true);
    }
  });

  it("points each face at a self-hosted woff2 under ./fonts (no external host)", () => {
    const faces = (stylesSource.match(/@font-face\s*\{[^}]*\}/g) ?? []).filter((face) =>
      /font-family:\s*"Gotham"/.test(face)
    );
    for (const face of faces) {
      expect(face).toMatch(/url\(["']?\.\/fonts\/gotham-[a-z]+\.woff2["']?\)/);
      // No CDN / remote font source.
      expect(face).not.toMatch(/https?:/);
    }
  });

  it("sets the global Gotham-first stack on body (covers admin too)", () => {
    const bodyRule = stylesSource.match(/(^|\})\s*body\s*\{[^}]*\}/m)?.[0] ?? "";
    expect(bodyRule).toContain('"Gotham"');
    expect(bodyRule).toContain("-apple-system");
    // Gotham is the first family in the stack.
    expect(bodyRule).toMatch(/font-family:\s*"Gotham"/);
  });
});

describe("monochrome donor-facing restyle", () => {
  // The donor-facing views (/donar + /donar/gracias) drop teal accents for the
  // monochrome Gotham language: black buttons/chips, gray borders. The admin
  // palette is untouched — only its font changes via the global body stack.
  it("styles the donor primary button/active chip in black (#000/#111), not teal", () => {
    const donarPrimary = stylesSource.match(/\.donar-card\s+\.primary\s*\{[^}]*\}/)?.[0] ?? "";
    expect(donarPrimary).toMatch(/#000|#111/i);
    expect(donarPrimary).not.toContain("#007c75");

    const activeChip = stylesSource.match(/\.donar-chip\.active\s*\{[^}]*\}/)?.[0] ?? "";
    // Active chip inverts to black instead of the teal wash.
    expect(activeChip).toMatch(/#000|#111/i);
    expect(activeChip).not.toContain("#007c75");
    expect(activeChip).not.toContain("#edf9f7");
  });

  it("keeps the teal accent out of every donor (.donar-) rule", () => {
    const donarRules = stylesSource.match(/\.donar-[\w-]*[^{]*\{[^}]*\}/g) ?? [];
    expect(donarRules.length).toBeGreaterThan(0);
    for (const rule of donarRules) {
      expect(rule, `teal leaked into: ${rule.slice(0, 40)}`).not.toContain("#007c75");
      expect(rule).not.toContain("#006d66");
    }
  });

  it("leaves the admin teal accent (#007c75) present elsewhere in the sheet", () => {
    // The admin keeps its palette; the teal must still appear on non-donor rules.
    const withoutDonar = stylesSource.replace(/\.donar-[\w-]*[^{]*\{[^}]*\}/g, "");
    expect(withoutDonar).toContain("#007c75");
  });
});
