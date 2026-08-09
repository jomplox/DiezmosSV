// Built-in default logotype, shared by the CDE PDF, the annual certificate and the
// donor landing. Deployments that upload their own branding logo never see it.
// The view box is a layout contract: LOGO_HEIGHT in pdf.ts / certificate.ts scales
// against `height`, and the certificate centres against `width`. Keep 704x228 when
// swapping the artwork so the surrounding layout constants stay valid.
export const ORG_LOGO_VIEW_BOX = { width: 704, height: 228 } as const;

// Path data mirrors Sources/Logo.svg. The first entry is a ring: an outer circle
// wound clockwise followed by an inner circle wound counter-clockwise, so the
// non-zero fill rule (pdf-lib's default, and SVG's) punches the hole.
//
// The ink deliberately stops at y=186 of the 228-unit box. The certificate prints
// the organisation name immediately under the logo box, so artwork that reaches the
// full box height collides with it; the reserved bottom band keeps them clear.
export const ORG_LOGO_PATHS = [
  "M 97 8 C 146.15 8 186 47.85 186 97 C 186 146.15 146.15 186 97 186 C 47.85 186 8 146.15 8 97 C 8 47.85 47.85 8 97 8 Z M 97 42 C 66.62 42 42 66.62 42 97 C 42 127.38 66.62 152 97 152 C 127.38 152 152 127.38 152 97 C 152 66.62 127.38 42 97 42 Z",
  "M 97 74 L 120 97 L 97 120 L 74 97 Z",
  "M 226 20 L 704 20 L 704 58 L 226 58 Z",
  "M 226 72 L 590 72 L 590 110 L 226 110 Z",
  "M 226 138 L 704 138 L 704 144 L 226 144 Z",
  "M 226 160 L 438 160 L 438 186 L 226 186 Z"
] as const;
