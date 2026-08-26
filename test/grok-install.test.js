"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  GROK_HOOK_EVENTS,
  GROK_NOTIFICATION_MATCHER,
  registerGrokHooks,
  unregisterGrokHooks,
} = require("../hooks/grok-install");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-grok-install-"));
}

describe("Grok hook installer", () => {
  it("skips automatic registration when Grok has left no install directory", () => {
    const homeDir = tempHome();
    try {
      const result = registerGrokHooks({ homeDir, nodeBin: process.execPath, silent: true });
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.reason, "grok-not-installed");
      assert.strictEqual(fs.existsSync(path.join(homeDir, ".grok")), false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes one owned global config and is idempotent", () => {
    const homeDir = tempHome();
    try {
      fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
      const first = registerGrokHooks({ homeDir, nodeBin: process.execPath, platform: "darwin", silent: true });
      assert.strictEqual(first.installed, true);
      assert.strictEqual(first.added, GROK_HOOK_EVENTS.length);
      const config = JSON.parse(fs.readFileSync(first.configPath, "utf8"));
      assert.deepStrictEqual(Object.keys(config.hooks), [...GROK_HOOK_EVENTS]);
      for (const event of GROK_HOOK_EVENTS) {
        const group = config.hooks[event][0];
        assert.strictEqual(group.hooks[0].type, "command");
        assert.match(group.hooks[0].command, /grok-hook\.js/);
        assert.strictEqual(group.hooks[0].timeout, 5);
      }
      assert.strictEqual(config.hooks.Notification[0].matcher, GROK_NOTIFICATION_MATCHER);
      assert.ok(!Object.prototype.hasOwnProperty.call(config.hooks.Stop[0], "matcher"));

      const second = registerGrokHooks({ homeDir, nodeBin: process.execPath, platform: "darwin", silent: true });
      assert.strictEqual(second.added, 0);
      assert.strictEqual(second.updated, 0);
      assert.strictEqual(second.skipped, GROK_HOOK_EVENTS.length);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a foreign file at the owned filename", () => {
    const homeDir = tempHome();
    try {
      const configPath = path.join(homeDir, ".grok", "hooks", "clawd-on-desk.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "other.sh" }] }] } }));
      assert.throws(
        () => registerGrokHooks({ homeDir, nodeBin: process.execPath, silent: true }),
        /Refusing to overwrite non-Clawd/,
      );
      assert.match(fs.readFileSync(configPath, "utf8"), /other\.sh/);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("removes only the owned config and can preserve a cleanup backup", () => {
    const homeDir = tempHome();
    try {
      fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
      const installed = registerGrokHooks({ homeDir, nodeBin: process.execPath, silent: true });
      const result = unregisterGrokHooks({ homeDir, backup: true, silent: true });
      assert.strictEqual(result.changed, true);
      assert.strictEqual(result.removed, GROK_HOOK_EVENTS.length);
      assert.strictEqual(fs.existsSync(installed.configPath), false);
      assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
