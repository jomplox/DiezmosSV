import { pathToFileURL } from "node:url";

// The foreign-resident donation lane's campaign slug is build configuration: Vite
// bakes VITE_GIVEBUTTER_CAMPAIGN into the client bundle at `npm run build` time and
// src/client/donation.ts falls back to a neutral placeholder so a fresh clone, the
// test suites and staging stay runnable without it. A production build must not use
// that fallback: it would ship a lane pointing at a campaign that does not exist,
// and nothing downstream would report the mistake.
const CAMPAIGN_ENV = "VITE_GIVEBUTTER_CAMPAIGN";
const PLACEHOLDER_CAMPAIGN = "example-campaign";

export function assertDonationLaneConfigured({ environment = process.env } = {}) {
  const campaign = environment[CAMPAIGN_ENV]?.trim() ?? "";
  if (campaign === "") {
    throw new Error(
      `Release build blocked: ${CAMPAIGN_ENV} is unset or blank, so the build would fall back to the "${PLACEHOLDER_CAMPAIGN}" placeholder and ship a donation lane pointing at a campaign that does not exist. Set ${CAMPAIGN_ENV} to this deployment's campaign slug before building.`
    );
  }
  if (campaign === PLACEHOLDER_CAMPAIGN) {
    throw new Error(
      `Release build blocked: ${CAMPAIGN_ENV} is still the "${PLACEHOLDER_CAMPAIGN}" placeholder, which is not a real campaign. Set ${CAMPAIGN_ENV} to this deployment's campaign slug before building.`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertDonationLaneConfigured();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
