import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { EmailTemplateBodyPreview } from "../../src/client/EmailTemplateBodyPreview";
import { emailTemplateBodyHtml } from "../../src/shared/emailTemplateHtml";

function renderPreview(bodyText: string): { markup: string; document: string } {
  const markup = renderToStaticMarkup(createElement(EmailTemplateBodyPreview, {
    bodyText,
    templateLabel: "Envío de comprobante"
  }));
  const srcDoc = markup.match(/srcDoc="([^"]*)"/i)?.[1];
  expect(srcDoc).toBeDefined();
  const document = srcDoc!
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  return { markup, document };
}

describe("email template body preview", () => {
  test("is collapsed by default and identifies its scope and placeholder behavior in Spanish", () => {
    const { markup } = renderPreview("Hola {{donante}}:");

    expect(markup).toMatch(/<details(?:\s[^>]*)?>/);
    expect(markup).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/);
    expect(markup).toContain("<summary>Vista previa del cuerpo</summary>");
    expect(markup).toContain("Las variables se reemplazan al enviar el correo.");
    expect(markup).toContain('title="Vista previa del cuerpo — Envío de comprobante"');
  });

  test("renders exactly the shared outgoing body HTML, including line breaks, spacing and formatting", () => {
    const bodyText = "Hola {{donante}}:\r\n\r\n\r\n**Gracias** por su donación.\r\nConserve este correo.\r\n\r\n> Una cita\r\n> en dos líneas";
    const { document } = renderPreview(bodyText);

    expect(document).toContain(emailTemplateBodyHtml(bodyText));
    expect(document).toContain("{{donante}}");
    expect(document).toContain("<strong>Gracias</strong>");
    expect(document).toContain("max-width:560px");
    expect(document).toContain("padding:28px");
    expect(document).toContain("font-family:Arial,Helvetica,sans-serif");
  });

  test("isolates email styles from the admin and prevents preview scripts or remote content", () => {
    const { markup, document } = renderPreview('<script>alert(1)</script>\n\n<img src="https://example.org/tracker">');

    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(document).toContain("default-src 'none'; style-src 'unsafe-inline'");
    expect(document).not.toContain("<script>");
    expect(document).not.toContain("<img");
    expect(document).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(document).toContain("&lt;img");
  });
});
