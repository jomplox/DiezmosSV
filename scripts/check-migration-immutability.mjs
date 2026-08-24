import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const IMMUTABLE_MIGRATION_SHA256 = Object.freeze({
  "0001_init.sql": "f969a11f4dcbec473bf3022b5198efede624770d49feaf7ae999cc45d3518bd6",
  "0002_contingency_batches.sql": "b6722795a5046a33365e91d98625d0ead04ddf2a4b7c6c995c8da33550afffb8",
  "0003_runtime_settings.sql": "9ce92bf0c13118e8f2d783583edebee81dbdd3c48700a130dcb5118b8685214c",
  "0004_email_delivery_evidence.sql": "96205e3e4a0f0d361566c251f000964f38a1fb53dafb87ce8801a1718d3ca7f2",
  "0005_nullable_dte_wompi_source.sql": "8e92a435ed2279dab2e8143b0b1e5218f586af96605e71812e553df32eb3c5c5",
  "0006_document_list_indexes.sql": "714aa0faeeec357bc6e351102e3937f3049c7f4741dac358ca9a7e9049f91eba",
  "0007_dte_document_search_fts.sql": "bacd364099202888445d2ca3142f601c6629b6743f85b1dbec5ebe9dde9fa62d",
  "0008_audit_action_index.sql": "442d64d56d6b51872f34e574b858f6bc917bce8e901bce1d516f8a0c7edb8a0a",
  "0009_donation_intents.sql": "03b27d5984b717e6ca186b18153952e472ba37a8584b62f1153ad758f66f11ee",
  "0010_donation_intents_optional_contact.sql": "2b089d5c7934b622eff12dd724ac53d7566753f2f48bf083496c21a8d18c802e",
  "0011_donation_intents_document_types.sql": "9c82d0323e4f67cf84f51f531f140985830517ed08800d44a02ed2526e0e92f3",
  "0012_donation_intents_gift_type.sql": "ee2148e66d8c12f21c1594deb1b0d1b40edef4f2a97cc49b12e28a071279e0d0",
  "0013_audit_actor_context.sql": "a03b1e4b1b1e10d81e2fb09fbc223e5d88851ada8e83610e6d6a304a91bd8d2b",
  "0014_transmission_pending_status.sql": "382031f8f64aa34fef151d0de2afc3811cced91119195a39876603bb5f29a696",
  "0015_donation_intents_draft_donor.sql": "281885eb375a1876d49bc268a9cff5aea93fce0a73e5c216e87db091737d8392",
  "0016_donation_intents_paid_at.sql": "5ce567401e3c62c2d3deca066bba1a1a2cca6b621237751c7df2573201b0835b",
  "0017_donation_intents_datos_capability.sql": "e6d36f909e04541a59e0e09816317bc8efb42088d225a23522761ec185c66769",
  "0018_security_remediation_limits.sql": "fa497b0e26e0a96dc7c9980ef6f863498c10a1eb1400f8e4bcf9607853d2efb3",
  "0019_security_hardening.sql": "82825d556b9bca7b55b8c6c3efc5ec226ef86446d7a4f76aa9227d689f5ff48f",
  "0020_fiscal_operation_claims.sql": "fae2f3e03060c49607228f299a8ab37d04c9374b0d90c95c20e5496e5fa0d400",
  "0021_security_lifecycle_guards.sql": "c7f37f277e6178afa24fec39ebde7e606332f40087dc94acea8a957477c37c22",
  "0022_security_boundary_guards.sql": "46261531885fef33d183e5e0870532c2e46479d1408e2f32ef3c12d989f43bb5",
  "0023_wompi_issuance_lifecycle.sql": "870a51727f1bcf1d9318ba9d0aa28137683aaa9413e5db22f59984b639d1b143",
  "0024_add_rate_limit_claim_ids.sql": "71b665859f65914e098c704c7d6a2c29b5789904ac01dab3e5f3566d083d4440",
  "0025_email_delivery_recovery.sql": "8bb332dbd591f18a706a06ac56a6854160196098344b60c8f1e5f4bd548903bb",
  "0026_classify_legacy_email_rejections.sql": "af990bad4baf4de3f5cc423ea76c6b613eff6db36279b7500d37370d846d27c6",
  "0027_fiscal_corrections.sql": "8ac14b4353164c01cd39fd823bd58a454e3ddb39ca7bd3dcfac3396f7114257e",
  "0028_fiscal_correction_reservations.sql": "162a6c05e5ce92a678aa1af2770207e47ab43bf0e781bcccd4a517229de64c1a",
  "0029_wompi_payment_link_dedup.sql": "d2a073cf43587621777edb6f4259d9254f2286f379d7b657291526c905e4b249",
  "0030_wompi_reconciliation_lifecycle.sql": "cc99d9c1099cac80173f39bf80f9f12d9ab9c84b202b6d6af6fd59760b87eb19",
  "0031_repair_wompi_payment_link_backfill.sql": "1df79a331a48b4cecb90907682ad39da205b469fd3997c877af7c4abbc018b00",
  "0032_stripe_us_donations.sql": "7c161eb30a7c8d068f2faaedd0e1f21f5e5ebda71e8886e82fb76456e3460c98",
  "0033_stripe_gift_type.sql": "a42e9d74ed4fbbb5b23bfa609a132c67163ab5c7d042fd61f9e6cc8eea6a76fe",
  "0034_stripe_annual_statements.sql": "133ab5947a8f523f3aa61fd233306e25313af52bef5ffc78ad40fd60970fbdb5",
  "0035_stripe_provider_chronology.sql": "41862170ee18d46273b0c23acff58347084f10d8fcaf5a5a9eac89a6513239c4",
  "0036_stripe_retention_generations.sql": "7364055f31bfc1a17be84de2307ebec8d6f9112ee2e19f5fd540de141c91af44",
  "0037_stripe_delivery_safety.sql": "28c513b90bc41cf2af2dc2cdbd47d5dedc9f25ee84321130fd579a2b22c96df7",
  "0038_stripe_integrity_fences.sql": "62c11b01aacf353e75131cb21a9373d811a05faa195e397488885cff05dc808f",
  "0039_stripe_donor_contact_evidence.sql": "f1eb983d2f8e96dff0086c5dbed8d34a77b589c038c8579bf17953f2255aac1a",
  "0040_stripe_payment_method_evidence.sql": "b77f8e8a807704fc8592a8f6cb3e527a97fd37becb58819cf929a13202374d80",
  "0041_stripe_annual_email_evidence.sql": "471f4c90154e18b1115aae8a3dbc3a3419b994bf901ce25b23d8f0cc37b68378",
  "0042_stripe_annual_email_evidence_reclaim.sql": "44277c88b821f7eb2dd3dbeb783d839d6507358ed02d4894a7715ffbfe3fe506",
  "0043_stripe_annual_email_evidence_dispatch_guard.sql": "dd00177c7dece29d887cfd7913b7b2ca0eecd7e63862c6f09d459a0b2a054714",
  "0044_stripe_portal_capability.sql": "2a4be49afc5da8201438999cec857978910631ec002084467a50951b5373d1ca",
  "0045_login_step_up_mfa.sql": "9fd64e15528cb80f72d99389cec87378c01cada6adb70497ece9e4cb567853ca",
  "0046_provider_creation_budgets.sql": "dd014b8bf754da9bca91cddf96d77dcb48718a4644cd3c89d01ddaecc8bca35d"
});

export function assertImmutableMigrations(
  migrationsDirectory = resolve(process.cwd(), "migrations")
) {
  const names = new Set(readdirSync(migrationsDirectory));
  const prefixOwners = new Map();
  for (const name of names) {
    const match = /^(\d{4})_.*\.sql$/u.exec(name);
    if (!match) continue;
    const existing = prefixOwners.get(match[1]);
    if (existing) {
      throw new Error(`Duplicate migration prefix ${match[1]}: ${existing}, ${name}`);
    }
    prefixOwners.set(match[1], name);
  }
  for (const [name, expectedHash] of Object.entries(
    IMMUTABLE_MIGRATION_SHA256
  )) {
    if (!names.has(name)) {
      throw new Error(`Historical migration ${name} is missing`);
    }
    const actualHash = createHash("sha256")
      .update(readFileSync(resolve(migrationsDirectory, name)))
      .digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Historical migration ${name} was modified`);
    }
  }
  const latestImmutablePrefix = Math.max(
    ...Object.keys(IMMUTABLE_MIGRATION_SHA256).map((name) => Number(name.slice(0, 4)))
  );
  for (const name of names) {
    const match = /^(\d{4})_.*\.sql$/u.exec(name);
    if (!match || Object.hasOwn(IMMUTABLE_MIGRATION_SHA256, name)) continue;
    const prefix = Number(match[1]);
    if (prefix <= latestImmutablePrefix) {
      throw new Error(`Unexpected historical migration ${name}`);
    }
    if (prefix !== latestImmutablePrefix + 1) {
      throw new Error(`Unexpected future migration ${name}; next prefix must be ${String(latestImmutablePrefix + 1).padStart(4, "0")}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertImmutableMigrations();
    process.stdout.write("Historical migrations 0001-0046 are immutable.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
