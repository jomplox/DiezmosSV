import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOperatorCredentials,
  loadPrivateDeployConfig
} from "../../scripts/private-deploy-config.mjs";
import { pngBytes as generatePngBytes } from "../worker/support/rasterFixtures";

const pngBytes = Buffer.from(generatePngBytes(2, 2, { red: 20, green: 60, blue: 200 }));
const jpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64"
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("private deployment configuration", () => {
  it("loads an owner-only external raster configuration", () => {
    const fixture = deploymentFixture();

    expect(
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toMatchObject({
      target: "staging",
      campaign: "campaign-fixture",
      origin: "https://staging.example.invalid",
      donorLogo: { contentType: "image/png", bytes: pngBytes }
    });
  });

  it("accepts JPEG bytes when the private extension agrees", () => {
    const fixture = deploymentFixture({
      target: "production",
      logoName: "logo.jpeg",
      logoBytes: jpegBytes
    });

    expect(
      loadPrivateDeployConfig({
        target: "production",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      }).donorLogo.contentType
    ).toBe("image/jpeg");
  });

  it("permits plain HTTP only for loopback development origins", () => {
    const fixture = deploymentFixture({ origin: "http://127.0.0.1:8787" });

    expect(
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      }).origin
    ).toBe("http://127.0.0.1:8787");
  });

  it("accepts a stricter read-only config and donor logo", () => {
    const fixture = deploymentFixture();
    chmodSync(fixture.logoPath, 0o400);
    chmodSync(fixture.configPath, 0o400);

    expect(
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      }).donorLogo.contentType
    ).toBe("image/png");
  });

  it.each([
    "DIEZMOSSV_DEPLOY_TARGET",
    "VITE_GIVEBUTTER_CAMPAIGN",
    "DIEZMOSSV_APP_ORIGIN",
    "DIEZMOSSV_DONOR_LOGO_FILE"
  ])("names %s when that required setting is absent", (key) => {
    const fixture = deploymentFixture();
    writeFileSync(
      fixture.configPath,
      fixture.configContents.replace(new RegExp(`^${key}=.*\n`, "m"), ""),
      { mode: 0o600 }
    );

    expect(() =>
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toThrow(new RegExp(`missing a required setting: ${key}`));
    expectSanitizedFailure(() =>
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      }), fixture
    );
  });

  it.each([
    ["example-campaign", /placeholder/],
    ["campaign/with/path", /single Givebutter campaign slug/]
  ])("rejects the unusable Givebutter campaign value %s", (campaign, expected) => {
    const fixture = deploymentFixture();
    writeFileSync(
      fixture.configPath,
      fixture.configContents.replace("campaign-fixture", campaign),
      { mode: 0o600 }
    );

    expect(() =>
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toThrow(expected);
  });

  it("rejects a missing config file and an empty one without disclosure", () => {
    const fixture = deploymentFixture();
    const absentPath = join(fixture.privateRoot, "absent.env");
    const emptyPath = join(fixture.privateRoot, "empty.env");
    writeFileSync(emptyPath, "", { mode: 0o600 });

    expect(() =>
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: absentPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toThrow(/missing or inaccessible/);
    expect(() =>
      loadPrivateDeployConfig({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: emptyPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toThrow(/missing a required setting: DIEZMOSSV_DEPLOY_TARGET/);
    for (const path of [absentPath, emptyPath]) {
      expectSanitizedFailure(() =>
        loadPrivateDeployConfig({
          target: "staging",
          env: { DIEZMOSSV_DEPLOY_CONFIG: path },
          repositoryRoot: fixture.repositoryRoot
        }), fixture
      );
    }
  });

  it("rejects a deploy file selected for the other target without disclosure", () => {
    const fixture = deploymentFixture({ target: "staging" });

    expectSanitizedFailure(() =>
      loadPrivateDeployConfig({
        target: "production",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot
      }), fixture
    );
  });

  it.each([
    ["relative override", () => ({ DIEZMOSSV_DEPLOY_CONFIG: "private/staging.env" })],
    ["config inside repository", (fixture: Fixture) => {
      const path = join(fixture.repositoryRoot, "staging.env");
      writeFileSync(path, fixture.configContents, { mode: 0o600 });
      return { DIEZMOSSV_DEPLOY_CONFIG: path };
    }],
    ["config symlink", (fixture: Fixture) => {
      const path = join(fixture.privateRoot, "linked.env");
      symlinkSync(fixture.configPath, path);
      return { DIEZMOSSV_DEPLOY_CONFIG: path };
    }],
    ["config mode 0644", (fixture: Fixture) => {
      chmodSync(fixture.configPath, 0o644);
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["config mode 0700", (fixture: Fixture) => {
      chmodSync(fixture.configPath, 0o700);
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["missing deploy target", (fixture: Fixture) => {
      writeFileSync(
        fixture.configPath,
        fixture.configContents.replace(/^DIEZMOSSV_DEPLOY_TARGET=.*\n/m, ""),
        { mode: 0o600 }
      );
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["missing key", (fixture: Fixture) => {
      writeFileSync(
        fixture.configPath,
        fixture.configContents.replace(/^DIEZMOSSV_APP_ORIGIN=.*\n/m, ""),
        { mode: 0o600 }
      );
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["insecure remote origin", (fixture: Fixture) => {
      writeFileSync(
        fixture.configPath,
        fixture.configContents.replace(
          "https://staging.example.invalid",
          "http://staging.example.invalid"
        ),
        { mode: 0o600 }
      );
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["logo inside repository", (fixture: Fixture) => {
      const logoPath = join(fixture.repositoryRoot, "logo.png");
      writeFileSync(logoPath, pngBytes, { mode: 0o600 });
      writeFileSync(
        fixture.configPath,
        fixture.configContents.replace(fixture.logoPath, logoPath),
        { mode: 0o600 }
      );
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["logo symlink", (fixture: Fixture) => {
      const logoPath = join(fixture.privateRoot, "linked.png");
      symlinkSync(fixture.logoPath, logoPath);
      writeFileSync(
        fixture.configPath,
        fixture.configContents.replace(fixture.logoPath, logoPath),
        { mode: 0o600 }
      );
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["logo mode 0644", (fixture: Fixture) => {
      chmodSync(fixture.logoPath, 0o644);
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["logo mode 0700", (fixture: Fixture) => {
      chmodSync(fixture.logoPath, 0o700);
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["SVG bytes", (fixture: Fixture) => {
      writeFileSync(fixture.logoPath, "<svg>private-fixture-bytes</svg>", { mode: 0o600 });
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["extension mismatch", (fixture: Fixture) => {
      writeFileSync(fixture.logoPath, jpegBytes, { mode: 0o600 });
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }],
    ["malformed PNG", (fixture: Fixture) => {
      writeFileSync(fixture.logoPath, Buffer.from("not-a-private-raster"), { mode: 0o600 });
      return { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath };
    }]
  ])("rejects %s with a sanitized error", (_caseName, mutate) => {
    const fixture = deploymentFixture();
    const env = mutate(fixture as Fixture);

    expectSanitizedFailure(() =>
      loadPrivateDeployConfig({
        target: "staging",
        env,
        repositoryRoot: fixture.repositoryRoot
      }), fixture
    );
  });
});

describe("private operator credentials", () => {
  it("loads target-prefixed staging credentials from an owner-only override", () => {
    const fixture = deploymentFixture();
    const credentialsPath = join(fixture.privateRoot, "staging-smoke.env");
    writeFileSync(
      credentialsPath,
      "STAGING_EMAIL=operator@example.invalid\nSTAGING_PASSWORD=password-fixture\n",
      { mode: 0o600 }
    );

    expect(
      loadOperatorCredentials({
        target: "staging",
        env: { DIEZMOSSV_OPERATOR_ENV_FILE: credentialsPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toEqual({ email: "operator@example.invalid", password: "password-fixture" });
  });

  it("loads generic credentials for production", () => {
    const fixture = deploymentFixture();
    const credentialsPath = join(fixture.privateRoot, "production-operator.env");
    writeFileSync(
      credentialsPath,
      "DIEZMOSSV_OPERATOR_EMAIL=operator@example.invalid\nDIEZMOSSV_OPERATOR_PASSWORD=password-fixture\n",
      { mode: 0o600 }
    );

    expect(
      loadOperatorCredentials({
        target: "production",
        env: { DIEZMOSSV_OPERATOR_ENV_FILE: credentialsPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toEqual({ email: "operator@example.invalid", password: "password-fixture" });
  });

  it("accepts a stricter read-only operator env", () => {
    const fixture = deploymentFixture();
    const credentialsPath = join(fixture.privateRoot, "operator.env");
    writeFileSync(
      credentialsPath,
      "STAGING_EMAIL=operator@example.invalid\nSTAGING_PASSWORD=password-fixture\n",
      { mode: 0o600 }
    );
    chmodSync(credentialsPath, 0o400);

    expect(
      loadOperatorCredentials({
        target: "staging",
        env: { DIEZMOSSV_OPERATOR_ENV_FILE: credentialsPath },
        repositoryRoot: fixture.repositoryRoot
      })
    ).toEqual({ email: "operator@example.invalid", password: "password-fixture" });
  });

  it.each([["0644", 0o644], ["0700", 0o700]])(
    "rejects operator env mode %s",
    (_modeLabel, mode) => {
      const fixture = deploymentFixture();
      const credentialsPath = join(fixture.privateRoot, "operator.env");
      writeFileSync(
        credentialsPath,
        "STAGING_EMAIL=operator@example.invalid\nSTAGING_PASSWORD=password-fixture\n",
        { mode: 0o600 }
      );
      chmodSync(credentialsPath, mode);

      expectSanitizedFailure(() =>
        loadOperatorCredentials({
          target: "staging",
          env: { DIEZMOSSV_OPERATOR_ENV_FILE: credentialsPath },
          repositoryRoot: fixture.repositoryRoot
        }), fixture
      );
    }
  );

  it("rejects relative, repository-contained, symlinked, permissive, and incomplete files without disclosure", () => {
    const fixture = deploymentFixture();
    const credentialsPath = join(fixture.privateRoot, "operator.env");
    const credentials = "STAGING_EMAIL=operator@example.invalid\nSTAGING_PASSWORD=password-fixture\n";
    writeFileSync(credentialsPath, credentials, { mode: 0o600 });
    const repositoryCredentials = join(fixture.repositoryRoot, "operator.env");
    writeFileSync(repositoryCredentials, credentials, { mode: 0o600 });
    const linkedCredentials = join(fixture.privateRoot, "linked-operator.env");
    symlinkSync(credentialsPath, linkedCredentials);

    for (const path of ["operator.env", repositoryCredentials, linkedCredentials]) {
      expectSanitizedFailure(() =>
        loadOperatorCredentials({
          target: "staging",
          env: { DIEZMOSSV_OPERATOR_ENV_FILE: path },
          repositoryRoot: fixture.repositoryRoot
        }), fixture
      );
    }

    chmodSync(credentialsPath, 0o644);
    expectSanitizedFailure(() =>
      loadOperatorCredentials({
        target: "staging",
        env: { DIEZMOSSV_OPERATOR_ENV_FILE: credentialsPath },
        repositoryRoot: fixture.repositoryRoot
      }), fixture
    );

    chmodSync(credentialsPath, 0o600);
    writeFileSync(credentialsPath, "STAGING_EMAIL=operator@example.invalid\n", { mode: 0o600 });
    expectSanitizedFailure(() =>
      loadOperatorCredentials({
        target: "staging",
        env: { DIEZMOSSV_OPERATOR_ENV_FILE: credentialsPath },
        repositoryRoot: fixture.repositoryRoot
      }), fixture
    );
  });
});

interface Fixture {
  repositoryRoot: string;
  privateRoot: string;
  configPath: string;
  logoPath: string;
  configContents: string;
}

function deploymentFixture(options: {
  target?: "staging" | "production";
  logoName?: string;
  logoBytes?: Uint8Array;
  origin?: string;
} = {}): Fixture {
  const repositoryRoot = temporaryRoot("diezmos-repository-");
  const privateRoot = temporaryRoot("diezmos-private-");
  mkdirSync(join(repositoryRoot, "scripts"));
  const logoPath = join(privateRoot, options.logoName ?? "logo.png");
  writeFileSync(logoPath, options.logoBytes ?? pngBytes, { mode: 0o600 });
  const configPath = join(privateRoot, "staging.env");
  const configContents = [
    `DIEZMOSSV_DEPLOY_TARGET=${options.target ?? "staging"}`,
    "VITE_GIVEBUTTER_CAMPAIGN=campaign-fixture",
    `DIEZMOSSV_APP_ORIGIN=${options.origin ?? "https://staging.example.invalid"}`,
    `DIEZMOSSV_DONOR_LOGO_FILE=${logoPath}`,
    ""
  ].join("\n");
  writeFileSync(configPath, configContents, { mode: 0o600 });
  return { repositoryRoot, privateRoot, configPath, logoPath, configContents };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function expectSanitizedFailure(action: () => unknown, fixture: Fixture): void {
  let message = "";
  try {
    action();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toBe("");
  for (const privateValue of [
    "private-fixture-bytes",
    "password-fixture",
    fixture.logoPath,
    fixture.configPath,
    "929e7cf"
  ]) {
    expect(message).not.toContain(privateValue);
  }
}
