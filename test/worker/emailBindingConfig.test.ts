import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

const publicConfig = experimental_readRawConfig({
  config: resolve(import.meta.dirname, "../../wrangler.toml")
}).rawConfig;

describe("public Email Service bindings", () => {
  it.each([
    ["root", publicConfig],
    ["staging", publicConfig.env?.staging],
    ["production", publicConfig.env?.production]
  ])("keeps exactly one unrestricted EMAIL binding in %s", (_scope, config) => {
    expect(config?.send_email).toHaveLength(1);
    expect(config?.send_email[0]?.name).toBe("EMAIL");
    expect(config?.send_email[0]).not.toHaveProperty("allowed_sender_addresses");
  });
});
