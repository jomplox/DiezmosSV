// How long the donor gets to finish an entrega on Wompi's hosted checkout.
//
// Shared because two sides must agree: the Worker sets the window on the payment link
// (EnlaceConfiguracion.duracionInterfazIntentoMinutos) and the /donar page polls for the
// result for exactly as long. When they disagreed the page gave up first — it polled for
// 3 minutes while Wompi kept the checkout open — and a donor still completing the bank
// challenge was dropped onto the neutral closing message.
//
// Why this size: production 3DS makes the bank challenge mandatory, and a donor may wait
// on an SMS OTP or switch to a banking app, so the window has to be generous. Wompi
// accepts 10-60 minutes. The ceiling is really the payment link's own vigencia
// (LINK_VALIDITY_HOURS = 1h): the link is pre-minted when the donor enters Paso 2, so by
// the time they reach the checkout, less than an hour of it remains — a 60-minute
// interface would outlive its own link. 30 minutes is triple Wompi's minimum, far beyond
// any real bank challenge, and safely inside the vigencia.
export const CHECKOUT_WINDOW_MINUTES = 30;

export const CHECKOUT_WINDOW_MS = CHECKOUT_WINDOW_MINUTES * 60_000;

// Bounds Wompi documents for duracionInterfazIntentoMinutos (live OpenAPI, 2026-07-29).
export const WOMPI_INTERFAZ_MIN_MINUTES = 10;
export const WOMPI_INTERFAZ_MAX_MINUTES = 60;
