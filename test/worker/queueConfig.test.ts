import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const wranglerToml = readFileSync(resolve(import.meta.dirname, "../../wrangler.toml"), "utf8");

describe("issuance queue failure configuration", () => {
  const issuanceQueues = ["diezmossv-local-issuance-example", "diezmossv-staging-issuance-example", "diezmossv-production-issuance-example"];

  it("gives every issuance consumer explicit retries and a dead-letter queue", () => {
    for (const queue of issuanceQueues) {
      const consumer = consumerBlock(queue);
      expect(consumer, `consumer block for ${queue}`).toBeTruthy();
      expect(consumer).toContain("max_retries");
      expect(consumer).toContain(`dead_letter_queue = "${queue}-dlq"`);
    }
  });

  it("consumes every dead-letter queue so dropped messages leave an audit trail", () => {
    for (const queue of issuanceQueues) {
      expect(consumerBlock(`${queue}-dlq`), `consumer block for ${queue}-dlq`).toBeTruthy();
    }
  });
});

function consumerBlock(queueName: string): string | null {
  const blocks = wranglerToml.split(/(?=\[\[)/);
  return blocks.find((block) => block.startsWith("[[") && block.includes("queues.consumers") && block.includes(`queue = "${queueName}"\n`)) ?? null;
}
