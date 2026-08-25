"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildAntigravityConversationPath,
  buildAntigravityConversationUrl,
  createAntigravitySessionNavigator,
  getDefaultAntigravityDevToolsActivePortPath,
  navigateDevToolsTarget,
  parseAntigravityPageTarget,
  parseDevToolsActivePort,
  readDevToolsActivePort,
  requestAntigravityTargets,
  selectAntigravityPageTarget,
} = require("../src/antigravity-session-focus");

const CONVERSATION_ID = "693b2deb-295f-451c-ae37-c2b9bbb76d77";
const OTHER_CONVERSATION_ID = "9143fd56-2a16-40ed-a6f7-00680c7209b8";
const DEVTOOLS_PORT = 53678;
const APP_PORT = 53685;

function makePageTarget(conversationId = CONVERSATION_ID, overrides = {}) {
  return {
    id: "7E93810DFE447C7497F55AA419B1BC89",
    type: "page",
    title: "Fixture conversation",
    url: `https://127.0.0.1:${APP_PORT}/c/${conversationId}?section=fixture`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${DEVTOOLS_PORT}/devtools/page/7E93810DFE447C7497F55AA419B1BC89`,
    ...overrides,
  };
}

function createPortFixture(t, contents = `${DEVTOOLS_PORT}\n/devtools/browser/browser-id`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-antigravity-focus-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "DevToolsActivePort");
  fs.writeFileSync(filePath, contents);
  return filePath;
}

describe("Antigravity DevTools discovery", () => {
  it("builds platform-specific DevToolsActivePort paths", () => {
    assert.strictEqual(
      getDefaultAntigravityDevToolsActivePortPath({ platform: "darwin", homeDir: "/Users/test" }),
      "/Users/test/Library/Application Support/Antigravity/DevToolsActivePort",
    );
    assert.strictEqual(
      getDefaultAntigravityDevToolsActivePortPath({
        platform: "win32",
        homeDir: "C:\\Users\\test",
        appDataDir: "C:\\Users\\test\\AppData\\Roaming",
      }),
      path.join("C:\\Users\\test\\AppData\\Roaming", "Antigravity", "DevToolsActivePort"),
    );
    assert.strictEqual(
      getDefaultAntigravityDevToolsActivePortPath({ platform: "linux", homeDir: "/home/test", env: {} }),
      "/home/test/.config/Antigravity/DevToolsActivePort",
    );
  });

  it("parses only bounded loopback DevTools ports", (t) => {
    const filePath = createPortFixture(t);
    assert.strictEqual(parseDevToolsActivePort("53678\n/devtools/browser/id"), DEVTOOLS_PORT);
    assert.strictEqual(readDevToolsActivePort(filePath), DEVTOOLS_PORT);
    for (const invalid of ["", "0", "65536", "12x", "127.0.0.1:1234"]) {
      assert.throws(() => parseDevToolsActivePort(invalid), /invalid Antigravity DevTools port/);
    }
  });

  it("validates the Antigravity page and constructs an exact conversation URL", () => {
    const target = parseAntigravityPageTarget(makePageTarget(), DEVTOOLS_PORT);
    assert.strictEqual(target.id, "7E93810DFE447C7497F55AA419B1BC89");
    assert.strictEqual(buildAntigravityConversationPath(OTHER_CONVERSATION_ID), `/c/${OTHER_CONVERSATION_ID}`);
    assert.strictEqual(
      buildAntigravityConversationUrl(target.pageUrl, OTHER_CONVERSATION_ID),
      `https://127.0.0.1:${APP_PORT}/c/${OTHER_CONVERSATION_ID}`,
    );
    assert.strictEqual(parseAntigravityPageTarget(makePageTarget(CONVERSATION_ID, {
      webSocketDebuggerUrl: "ws://example.com/devtools/page/unsafe",
    }), DEVTOOLS_PORT), null);
    assert.strictEqual(buildAntigravityConversationPath("not-a-uuid"), null);
  });

  it("selects the sole page, prefers an exact route, and rejects ambiguity", () => {
    const first = makePageTarget(CONVERSATION_ID);
    const second = makePageTarget(OTHER_CONVERSATION_ID, {
      id: "SECOND",
      webSocketDebuggerUrl: `ws://127.0.0.1:${DEVTOOLS_PORT}/devtools/page/SECOND`,
    });

    assert.strictEqual(
      selectAntigravityPageTarget([first], DEVTOOLS_PORT, OTHER_CONVERSATION_ID).id,
      first.id,
    );
    assert.strictEqual(
      selectAntigravityPageTarget([first, second], DEVTOOLS_PORT, OTHER_CONVERSATION_ID).id,
      second.id,
    );
    assert.throws(
      () => selectAntigravityPageTarget([first, second], DEVTOOLS_PORT, "32038dc3-35eb-45b6-a393-359180ce6c2e"),
      /multiple Antigravity windows/,
    );
  });

  it("reads the bounded local target endpoint", async (t) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makePageTarget()]));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const address = server.address();
    const targets = await requestAntigravityTargets(address.port);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].id, makePageTarget().id);
  });
});

describe("Antigravity CDP navigation", () => {
  it("navigates the page and brings it to the foreground", async () => {
    class FakeWebSocket extends EventEmitter {
      constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.sent = [];
        process.nextTick(() => this.emit("open"));
      }

      send(raw) {
        const message = JSON.parse(raw);
        this.sent.push(message);
        if (message.id === 1) {
          process.nextTick(() => this.emit("message", JSON.stringify({
            id: 1,
            result: { frameId: "frame-1" },
          })));
        } else if (message.id === 2) {
          process.nextTick(() => this.emit("message", JSON.stringify({ id: 2, result: {} })));
        }
      }

      close() {
        this.closed = true;
      }
    }

    const parsedTarget = parseAntigravityPageTarget(makePageTarget(), DEVTOOLS_PORT);
    const targetUrl = buildAntigravityConversationUrl(parsedTarget.pageUrl, OTHER_CONVERSATION_ID);
    const result = await navigateDevToolsTarget(parsedTarget, targetUrl, {
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 100,
    });
    assert.deepStrictEqual(result, {
      targetId: parsedTarget.id,
      targetUrl,
      frameId: "frame-1",
    });
  });

  it("composes port discovery, target selection, and navigation", async (t) => {
    const filePath = createPortFixture(t);
    const calls = [];
    const navigate = createAntigravitySessionNavigator({
      devToolsActivePortPath: filePath,
      requestTargets: async (port) => {
        calls.push(["targets", port]);
        return [makePageTarget()];
      },
      navigateTarget: async (target, targetUrl) => {
        calls.push(["navigate", target.id, targetUrl]);
        return { targetId: target.id, frameId: "frame-2" };
      },
    });

    const result = await navigate(OTHER_CONVERSATION_ID);
    assert.deepStrictEqual(calls, [
      ["targets", DEVTOOLS_PORT],
      ["navigate", makePageTarget().id, `https://127.0.0.1:${APP_PORT}/c/${OTHER_CONVERSATION_ID}`],
    ]);
    assert.strictEqual(result.conversationId, OTHER_CONVERSATION_ID);
    assert.strictEqual(result.frameId, "frame-2");
  });
});

describe("Antigravity retained-session main-process wiring", () => {
  it("passes the exact conversation navigator into retained-session resume", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(mainSource, /createAntigravitySessionNavigator\(\{\s*platform: process\.platform,/);
    assert.match(mainSource, /resumeRetainedSession\(entry, \{[\s\S]*?navigateAntigravityConversation,/);
    assert.match(mainSource, /openCodexThread: async \(url\) => \{[\s\S]*?await shell\.openExternal\(url\);/);
    assert.match(mainSource, /resumeSession: \(sessionId\) => resumeDashboardSession\(sessionId\),/);
  });
});
