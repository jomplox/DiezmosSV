import { describe, expect, it } from "vitest";

import { AccountStateGuard, StaleAccountStateError } from "../../src/client/accountState";

describe("AccountStateGuard", () => {
  it("drops a privileged response that resolves after an account switch", async () => {
    const guard = new AccountStateGuard();
    let resolveResponse!: (value: { audit: string[] }) => void;
    const delayedResponse = new Promise<{ audit: string[] }>((resolve) => {
      resolveResponse = resolve;
    });

    const guarded = guard.run(() => delayedResponse);
    guard.advance();
    resolveResponse({ audit: ["account-a-secret"] });

    await expect(guarded).rejects.toBeInstanceOf(StaleAccountStateError);
  });

  it("turns a delayed old-session failure into a stale result", async () => {
    const guard = new AccountStateGuard();
    let rejectResponse!: (reason: unknown) => void;
    const delayedResponse = new Promise<never>((_resolve, reject) => {
      rejectResponse = reject;
    });

    const guarded = guard.run(() => delayedResponse);
    guard.advance();
    rejectResponse(new Error("old account unauthorized"));

    await expect(guarded).rejects.toBeInstanceOf(StaleAccountStateError);
  });
});
