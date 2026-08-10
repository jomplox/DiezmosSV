import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
const readmeEs = readFileSync(resolve(import.meta.dirname, "../../README.es.md"), "utf8");
const stagingRunbook = readFileSync(
  resolve(import.meta.dirname, "../../docs/cloudflare-staging-uat.md"),
  "utf8"
);
// The wording assertions read English phrasing, so translations stay out of this list.
const englishProvisioningDocuments = [
  ["README", readme],
  ["staging UAT runbook", stagingRunbook]
] as const;
// The private-wrapper and resource-identifier assertions do not read prose, so they hold for
// every provisioning document in any language.
const provisioningDocuments = [
  ...englishProvisioningDocuments,
  ["Spanish README", readmeEs]
] as const;
const exactLocalD1Migration =
  "npx wrangler d1 migrations apply diezmossv-local-db-example --local";
const exactLocalD1MigrationTokens = exactLocalD1Migration.split(" ");
// Keep the rereviewer's first ten cases in their reported order.
const rejectedWranglerDocumentationCases = [
  ["bare Wrangler", "wrangler secret put X --env staging"],
  ["npx Wrangler", "npx wrangler secret put X --env staging"],
  ["flagged npx", "npx --yes wrangler secret put X --env staging"],
  ["npm exec Wrangler", "npm exec wrangler -- secret put X --env staging"],
  ["npm exec delimiter", "npm exec -- wrangler secret put X --env staging"],
  ["local binary", "./node_modules/.bin/wrangler secret put X --env staging"],
  ["prompt marker", "$ wrangler secret put X --env staging"],
  ["spoofed local comment", "npx wrangler secret put X --env staging # --local"],
  [
    "conflicting remote and local flags",
    "npx wrangler d1 execute DB --env staging --remote --local"
  ],
  ["continued npm exec", `npm exec -- \\
wrangler secret put X --env staging`],
  [
    "versioned npx",
    "npx wrangler@latest secret put X --env staging"
  ],
  [
    "flagged versioned npx",
    "npx --yes wrangler@4.115.0 secret put X --env staging"
  ],
  [
    "versioned npm exec",
    "npm exec wrangler@latest -- secret put X --env staging"
  ],
  [
    "delimited versioned npm exec",
    "npm exec -- wrangler@4.115.0 secret put X --env staging"
  ],
  ["npm x", "npm x wrangler secret put X --env staging"],
  [
    "delimited versioned npm x",
    "npm x -- wrangler@latest secret put X --env staging"
  ],
  [
    "alternate local binary",
    "node_modules/.bin/wrangler secret put X --env staging"
  ],
  [
    "npx launcher after package value",
    "npx --package other wrangler secret put X --env staging"
  ],
  [
    "npx short-package launcher after value",
    "npx -p other wrangler secret put X --env staging"
  ],
  [
    "npm exec launcher after package value",
    "npm exec --package other -- wrangler secret put X --env staging"
  ],
  [
    "npm x versioned launcher after package value",
    "npm x -p other -- wrangler@latest secret put X --env staging"
  ],
  [
    "npx launcher after package assignment",
    "npx --package=other wrangler@latest secret put X --env staging"
  ],
  [
    "npm exec launcher after short-package assignment",
    "npm exec -p=other -- wrangler secret put X --env staging"
  ],
  [
    "npm x launcher after attached short package",
    "npm x -pother -- wrangler@latest secret put X --env staging"
  ],
  [
    "launcher after multiple package options",
    "npx --package first -p second wrangler secret put X --env staging"
  ],
  [
    "launcher after boolean flags around package",
    "npx --yes --package other -y wrangler@latest secret put X --env staging"
  ],
  [
    "npx launcher after separator",
    "npx --yes -- wrangler secret put X --env staging"
  ],
  [
    "quoted launcher after quoted package value",
    'npx --package "other" "wrangler@latest" secret put X --env staging'
  ],
  [
    "continued launcher after package value",
    `npm x --package \\
  other -- \\
  wrangler secret put X --env staging`
  ],
  [
    "commented launcher after package value",
    "npx --package other wrangler secret put X --env staging # guarded"
  ],
  [
    "package-option local lookalike",
    "npx --package other wrangler d1 migrations apply diezmossv-local-db-example --local"
  ],
  ["missing long package value", "npx --package"],
  ["missing short package value", "npm exec -p -- wrangler secret put X"],
  ["empty package assignment", "npm x --package= echo safe"],
  ["unknown npx option", "npx --mystery echo safe"],
  ["unknown npm-exec option", "npm exec --mystery echo safe"],
  [
    "quoted versioned npx",
    'npx --yes "wrangler@4.115.0" secret put X --env staging'
  ],
  [
    "continued versioned npx",
    `npx --yes \\
  wrangler@4.115.0 secret put X --env staging`
  ],
  [
    "environment flag before the operation",
    "npx wrangler --env staging secret put X"
  ],
  ["continued flagged npx", `npx --yes \\
wrangler secret put X --env staging`],
  ["continued npx executable", `npx \\
  --yes wrangler secret put X --env staging`],
  [
    "quoted spoofed local text",
    'npx wrangler secret put X --env staging "# --local"'
  ],
  [
    "bare Wrangler local lookalike",
    "wrangler d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "flagged npx local lookalike",
    "npx --yes wrangler d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "npm exec local lookalike",
    "npm exec -- wrangler d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "local binary local lookalike",
    "./node_modules/.bin/wrangler d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "local migration with remote flag",
    "npx wrangler d1 migrations apply diezmossv-local-db-example --local --remote"
  ],
  [
    "local migration with trailing environment",
    "npx wrangler d1 migrations apply diezmossv-local-db-example --local --env staging"
  ],
  [
    "local migration with leading environment",
    "npx wrangler --env staging d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "local migration with wrong database",
    "npx wrangler d1 migrations apply another-example --local"
  ],
  [
    "local migration with comment-only local flag",
    "npx wrangler d1 migrations apply diezmossv-local-db-example # --local"
  ],
  [
    "versioned npx local lookalike",
    "npx wrangler@latest d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "flagged versioned npx local lookalike",
    "npx --yes wrangler@4.115.0 d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "versioned npm exec local lookalike",
    "npm exec wrangler@latest -- d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "delimited versioned npm exec local lookalike",
    "npm exec -- wrangler@4.115.0 d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "npm x local lookalike",
    "npm x wrangler d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "versioned npm x local lookalike",
    "npm x -- wrangler@latest d1 migrations apply diezmossv-local-db-example --local"
  ],
  [
    "alternate local binary local lookalike",
    "node_modules/.bin/wrangler d1 migrations apply diezmossv-local-db-example --local"
  ]
] as const;
const allowedWranglerDocumentationCases = [
  [
    "private wrapper",
    "node scripts/run-private-wrangler.mjs secret put X --env staging"
  ],
  ["package script", "npm run cf:deploy:staging"],
  ["exact local migration", exactLocalD1Migration],
  [
    "continued local migration",
    `npx wrangler d1 migrations apply \\
  diezmossv-local-db-example \\
  --local`
  ],
  [
    "local migration with whitespace and a comment",
    "  npx   wrangler d1 migrations apply diezmossv-local-db-example --local   # local example"
  ],
  [
    "local migration with quoted arguments",
    `npx wrangler d1 migrations apply "diezmossv-local-db-example" '--local'`
  ],
  ["empty version", "npx wrangler@ secret put X --env staging"],
  ["package lookalike", "npx wrangler-cli secret put X --env staging"],
  ["token substring", "npx notwrangler@latest secret put X --env staging"],
  ["bare version token", "wrangler@latest secret put X --env staging"],
  ["npx echo text", "npx echo wrangler secret put X --env staging"],
  [
    "flagged npx echo text",
    "npx --yes echo wrangler@latest secret put X --env staging"
  ],
  [
    "npm exec echo text",
    "npm exec echo wrangler secret put X --env staging"
  ],
  [
    "npm x echo text",
    "npm x echo wrangler@latest secret put X --env staging"
  ],
  [
    "local binary lookalike",
    "node_modules/.bin/wrangler-extra secret put X --env staging"
  ],
  [
    "npx Wrangler package with echo launcher",
    "npx --package wrangler echo safe"
  ],
  [
    "npm exec Wrangler package with echo launcher",
    "npm exec --package wrangler -- echo safe"
  ],
  [
    "npx versioned Wrangler package with echo launcher",
    "npx --package wrangler@latest echo safe"
  ],
  [
    "npx Wrangler package assignment with echo launcher",
    "npx --package=wrangler echo safe"
  ],
  [
    "npm exec Wrangler short-package assignment with echo launcher",
    "npm exec -p=wrangler -- echo safe"
  ],
  [
    "npm x Wrangler attached package with echo launcher",
    "npm x -pwrangler -- echo safe"
  ],
  [
    "multiple Wrangler packages with echo launcher",
    "npx --package wrangler -p wrangler@latest --yes echo safe"
  ],
  [
    "quoted Wrangler package with quoted echo launcher",
    'npm exec --package "wrangler@latest" -- "echo" safe'
  ]
] as const;

describe("remote provisioning documentation", () => {
  it.each(englishProvisioningDocuments)(
    "requires the selected owner-only external config in the %s",
    (_name, document) => {
      expect(document).toContain("DIEZMOSSV_WRANGLER_CONFIG");
      expect(document).toMatch(/absolute/i);
      expect(document).toMatch(/outside (?:the|this) repositor/i);
      expect(document).toMatch(/owner-only/i);
      expect(document).toContain("0600");
    }
  );

  it.each(provisioningDocuments)(
    "routes every documented remote Wrangler command through the private wrapper in the %s",
    (_name, document) => {
      expect(directRemoteWranglerCommandRefs(document)).toEqual([]);
      expect(document).toContain("scripts/run-private-wrangler.mjs");
    }
  );

  it.each(rejectedWranglerDocumentationCases)(
    "rejects the %s",
    (_name, document) => {
      expect(directRemoteWranglerCommandRefs(document)).toHaveLength(1);
    }
  );

  it.each(allowedWranglerDocumentationCases)(
    "allows the %s form",
    (_name, document) => {
      expect(directRemoteWranglerCommandRefs(document)).toEqual([]);
    }
  );

  it("keeps live resource identifiers and routing data out of the public config workflow", () => {
    const documents = provisioningDocuments
      .map(([_name, document]) => document)
      .join("\n");

    expect(documents).not.toMatch(/copy the returned D1 id into\s+wrangler\.toml/i);
    expect(documents).not.toMatch(/ids are already committed in wrangler\.toml/i);
    expect(documents).not.toMatch(
      /\b(?!00000000-0000-0000-0000-000000000000\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
    );
  });
});

function directRemoteWranglerCommandRefs(document: string): string[] {
  return logicalShellCommands(document).flatMap(({ command, lineNumber }) => {
    const invocation = directWranglerInvocation(tokenizeShellCommand(command));
    if (!invocation || isAllowedLocalD1Migration(invocation)) return [];
    return [`line ${lineNumber} (${invocation.family})`];
  });
}

type DirectWranglerInvocation = {
  family: "wrangler" | "npx" | "npm-exec" | "local-binary";
  commandTokens: string[];
};
const directWranglerRecognizers: Array<{
  family: DirectWranglerInvocation["family"];
  matches: (tokens: string[]) => boolean;
}> = [
  { family: "wrangler", matches: (tokens) => tokens[0] === "wrangler" },
  {
    family: "local-binary",
    matches: (tokens) =>
      tokens[0] === "./node_modules/.bin/wrangler" ||
      tokens[0] === "node_modules/.bin/wrangler"
  },
  {
    family: "npx",
    matches: (tokens) =>
      tokens[0] === "npx" && isPotentialWranglerLauncher(scanLauncher(tokens, 1))
  },
  {
    family: "npm-exec",
    matches: (tokens) =>
      tokens[0] === "npm" &&
      (tokens[1] === "exec" || tokens[1] === "x") &&
      isPotentialWranglerLauncher(scanLauncher(tokens, 2))
  }
];

type LauncherScan =
  | { status: "launcher"; token: string | undefined }
  | { status: "ambiguous" };

const booleanLauncherOptions = new Set(["--yes", "-y"]);

function scanLauncher(tokens: string[], startIndex: number): LauncherScan {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      return { status: "launcher", token: tokens[index + 1] };
    }
    if (booleanLauncherOptions.has(token)) {
      index += 1;
      continue;
    }
    if (token === "--package" || token === "-p") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) return { status: "ambiguous" };
      index += 2;
      continue;
    }
    if (token.startsWith("--package=") || token.startsWith("-p=")) {
      if (token.endsWith("=")) return { status: "ambiguous" };
      index += 1;
      continue;
    }
    if (token.startsWith("-p") && token.length > 2) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { status: "ambiguous" };
    return { status: "launcher", token };
  }
  return { status: "launcher", token: undefined };
}

function isPotentialWranglerLauncher(scan: LauncherScan): boolean {
  return scan.status === "ambiguous" || isWranglerToken(scan.token);
}

function isWranglerToken(token: string | undefined): boolean {
  return token === "wrangler" || /^wrangler@.+$/.test(token ?? "");
}

function logicalShellCommands(
  document: string
): Array<{ command: string; lineNumber: number }> {
  const lines = document.split(/\r?\n/);
  const commands: Array<{ command: string; lineNumber: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let command = lines[index].trim();

    while (hasLineContinuation(command) && index + 1 < lines.length) {
      command = command.trimEnd().slice(0, -1).trimEnd();
      index += 1;
      command = `${command} ${lines[index].trimStart()}`;
    }

    commands.push({ command: command.trim(), lineNumber });
  }

  return commands;
}

function hasLineContinuation(line: string): boolean {
  const trimmed = line.trimEnd();
  let backslashes = 0;
  for (
    let index = trimmed.length - 1;
    index >= 0 && trimmed[index] === "\\";
    index -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (quote === '"' && character === "\\" && index + 1 < command.length) {
        index += 1;
        token += command[index];
      } else {
        token += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      pushToken();
    } else if (character === "#" && !tokenStarted) {
      break;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\" && index + 1 < command.length) {
      index += 1;
      token += command[index];
      tokenStarted = true;
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  pushToken();
  return tokens;
}

function directWranglerInvocation(
  rawTokens: string[]
): DirectWranglerInvocation | undefined {
  const commandTokens = rawTokens[0] === "$" ? rawTokens.slice(1) : rawTokens;
  const recognizer = directWranglerRecognizers.find(({ matches }) =>
    matches(commandTokens)
  );
  return recognizer
    ? { family: recognizer.family, commandTokens }
    : undefined;
}

function isAllowedLocalD1Migration(
  invocation: DirectWranglerInvocation
): boolean {
  const { commandTokens } = invocation;
  const hasDisallowedRemoteFlag = commandTokens.some(
    (token) => token === "--remote" || token.startsWith("--remote=")
  );
  const hasDisallowedEnvironment = commandTokens.some(
    (token) => token === "--env" || token.startsWith("--env=")
  );

  return (
    invocation.family === "npx" &&
    commandTokens.includes("--local") &&
    !hasDisallowedRemoteFlag &&
    !hasDisallowedEnvironment &&
    commandTokens.length === exactLocalD1MigrationTokens.length &&
    commandTokens.every(
      (token, index) => token === exactLocalD1MigrationTokens[index]
    )
  );
}
