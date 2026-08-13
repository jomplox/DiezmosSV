#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const CAMPAIGN_ENV = "VITE_GIVEBUTTER_CAMPAIGN";
const PLACEHOLDER_CAMPAIGN = "example-campaign";
const CAMPAIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertDonationLaneConfigured({ environment = process.env } = {}) {
  const campaign = environment[CAMPAIGN_ENV]?.trim() ?? "";
  if (campaign === "") {
    throw new Error(
      `Release build blocked: ${CAMPAIGN_ENV} is unset or blank, so the Givebutter alternative would use a placeholder campaign.`
    );
  }
  if (campaign === PLACEHOLDER_CAMPAIGN) {
    throw new Error(
      `Release build blocked: ${CAMPAIGN_ENV} is still the "${PLACEHOLDER_CAMPAIGN}" placeholder.`
    );
  }
  if (!CAMPAIGN_PATTERN.test(campaign)) {
    throw new Error(
      `Release build blocked: ${CAMPAIGN_ENV} must be a single Givebutter campaign slug.`
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
