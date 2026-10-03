import { emailTemplateBodyHtml } from "../shared/emailTemplateHtml";

export function EmailTemplateBodyPreview({
  bodyText,
  templateLabel
}: {
  bodyText: string;
  templateLabel: string;
}) {
  // Reuse the outgoing body renderer inside its own document: the admin's p/table
  // rules must not change the spacing the operator is reviewing. No scripts or
  // remote content are needed for a body-only preview.
  const document = `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <meta name="color-scheme" content="only light" />
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;">
      <tr>
        <td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2a2e;">
          ${emailTemplateBodyHtml(bodyText)}
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return (
    <details className="email-template-body-preview">
      <summary>Vista previa del cuerpo</summary>
      <p>Las variables se reemplazan al enviar el correo.</p>
      <iframe
        className="email-template-body-preview-frame"
        title={`Vista previa del cuerpo — ${templateLabel}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={document}
      />
    </details>
  );
}
