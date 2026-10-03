// Shared by the sender and the sandboxed admin body preview. Keep this renderer
// independent of browser CSS: many email clients reset paragraph/quote margins.
const BODY_TYPE = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22.4px;";
const SECTION_GAP = 14;

interface TemplateBlock {
  quote: boolean;
  lines: string[];
  blankLinesAfter: number;
}

export function emailTemplateBodyHtml(bodyText: string): string {
  const blocks: TemplateBlock[] = [];
  let current: TemplateBlock | undefined;

  // Outer whitespace is not part of the saved template. Internal blank lines,
  // including NBSP-only lines pasted into the editor, each add one section gap.
  for (const rawLine of bodyText.replace(/\r\n?/g, "\n").trim().split("\n")) {
    const quote = rawLine.match(/^\s*>\s?(.*)$/);
    if (!quote && !rawLine.trim()) {
      if (current) current.blankLinesAfter += 1;
      continue;
    }
    const isQuote = Boolean(quote);
    if (!current || current.quote !== isQuote || current.blankLinesAfter > 0) {
      current = { quote: isQuote, lines: [], blankLinesAfter: 0 };
      blocks.push(current);
    }
    current.lines.push(quote ? quote[1] : rawLine.trim());
  }

  if (blocks.length === 0) return "";
  const rows = blocks.map((block) => {
    const content = block.lines.map(formatEmailTemplateInline).join("<br />");
    const body = block.quote
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td style="padding:10px 14px;border-left:3px solid #dfe6e8;background:#f7f9fa;${BODY_TYPE}color:#52656c;"><blockquote style="margin:0;padding:0;">${content}</blockquote></td></tr></table>`
      : `<p style="margin:0;padding:0;">${content}</p>`;
    // Put spacing on the layout cell, outside a quote's shaded background.
    const gap = SECTION_GAP * Math.max(1, block.blankLinesAfter);
    return `<tr><td style="padding:0 0 ${gap}px;${BODY_TYPE}color:#1f2a2e;overflow-wrap:anywhere;word-wrap:break-word;">${body}</td></tr>`;
  });
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">${rows.join("\n")}</table>`;
}

function formatEmailTemplateInline(value: string): string {
  return value
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replace(/\\\\/g, "&#92;")
    .replace(/\\\*/g, "&#42;")
    .replace(/\\\+/g, "&#43;")
    .replace(/\\&gt;/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\+\+([^+\n]+)\+\+/g, "<u>$1</u>");
}
