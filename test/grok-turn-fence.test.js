"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createGrokTurnFence = require("../src/grok-turn-fence");

describe("Grok prompt ordering fence", () => {
  it("drops a late completion from an older prompt", () => {
    const fence = createGrokTurnFence();
    assert.strictEqual(fence.observe({ sessionId: "s", event: "UserPromptSubmit", promptId: "a" }).accept, true);
    assert.strictEqual(fence.observe({ sessionId: "s", event: "UserPromptSubmit", promptId: "b" }).accept, true);
    assert.deepStrictEqual(
      fence.observe({ sessionId: "s", event: "StopCancelled", promptId: "a" }),
      { accept: false, reason: "older-than-active-prompt" },
    );
    assert.strictEqual(fence.observe({ sessionId: "s", event: "Stop", promptId: "b" }).accept, true);
    assert.deepStrictEqual(
      fence.observe({ sessionId: "s", event: "Stop", promptId: "a" }),
      { accept: false, reason: "already-settled-prompt" },
    );
  });

  it("uses idle_prompt as an unconditional settlement backstop", () => {
    const fence = createGrokTurnFence();
    fence.observe({ sessionId: "s", event: "UserPromptSubmit", promptId: "a" });
    assert.strictEqual(fence.observe({
      sessionId: "s",
      event: "Notification",
      promptId: null,
      notificationType: "idle_prompt",
    }).accept, true);
    assert.deepStrictEqual(
      fence.observe({ sessionId: "s", event: "Stop", promptId: "a" }),
      { accept: false, reason: "already-settled-prompt" },
    );
  });

  it("does not settle a working turn on a permission notification", () => {
    const fence = createGrokTurnFence();
    fence.observe({ sessionId: "s", event: "UserPromptSubmit", promptId: "a" });
    assert.strictEqual(fence.observe({
      sessionId: "s",
      event: "Notification",
      promptId: null,
      notificationType: "permission_prompt",
    }).accept, true);
    assert.strictEqual(fence.observe({ sessionId: "s", event: "PostToolUse", promptId: "a" }).accept, true);
  });

  it("accepts an unseen bash-mode completion and clears on SessionEnd", () => {
    const fence = createGrokTurnFence();
    assert.strictEqual(fence.observe({ sessionId: "s", event: "StopCancelled", promptId: "bash-a" }).accept, true);
    assert.strictEqual(fence.observe({ sessionId: "s", event: "SessionEnd" }).accept, true);
    assert.strictEqual(fence.size(), 0);
  });
});
