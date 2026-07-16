const environment = process.argv[2];

if (!new Set(["staging", "production"]).has(environment)) {
  console.error("Usage: node scripts/assert-fiscal-cutover.mjs <staging|production>");
  process.exit(2);
}

if (process.env.FISCAL_CUTOVER_QUIESCED !== "1") {
  console.error(
    `Remote ${environment} migration blocked: drain every old Worker request and block all mutating traffic, including account/login/password-reset, donation, webhook, and fiscal routes; also pause queue delivery and scheduled work before setting FISCAL_CUTOVER_QUIESCED=1. Keep the deployment quiesced until the claim-aware Worker is verified.`
  );
  process.exit(1);
}

console.log(`Fiscal cutover acknowledgement accepted for ${environment}.`);
