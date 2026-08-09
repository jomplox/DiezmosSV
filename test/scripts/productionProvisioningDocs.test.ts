import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
const stagingRunbook = readFileSync(
  resolve(import.meta.dirname, "../../docs/cloudflare-staging-uat.md"),
  "utf8"
);
const provisioningDocuments = [
  ["README", readme],
  ["staging UAT runbook", stagingRunbook]
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
  ]
] as const;

describe("remote provisioning documentation", () => {
  it.each(provisioningDocuments)(
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
    matches: (tokens) => tokens[0] === "./node_modules/.bin/wrangler"
  },
  {
    family: "npx",
    matches: (tokens) =>
      tokens[0] === "npx" && tokens.indexOf("wrangler", 1) !== -1
  },
  {
    family: "npm-exec",
    matches: (tokens) =>
      tokens[0] === "npm" &&
      tokens[1] === "exec" &&
      tokens.indexOf("wrangler", 2) !== -1
  }
];

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
