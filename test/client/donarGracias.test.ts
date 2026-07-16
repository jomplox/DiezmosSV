import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DONAR_THANK_YOU_TITLE } from "../../src/client/donation";
import { DonarGraciasPage } from "../../src/client/donarPage";

describe("DonarGraciasPage verification boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render a forged receipt claim or query amount before server verification", () => {
    const location = {
      origin: "https://example.org",
      pathname: "/donar/gracias",
      search: "?identificadorEnlaceComercio=unknown&idTransaccion=fake&monto=4999.99"
    };
    const windowStub = { location } as unknown as Window & typeof globalThis;
    Object.assign(windowStub, { parent: windowStub });
    vi.stubGlobal("window", windowStub);

    const html = renderToStaticMarkup(createElement(DonarGraciasPage));

    expect(html).not.toContain(DONAR_THANK_YOU_TITLE);
    expect(html).not.toContain("4999.99");
    expect(html).toContain("Verificando");
  });
});
