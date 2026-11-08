import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";

import { FORWARD_FALLBACK_TEXT } from "./constants.js";
import { configSchema } from "./config.js";
import { Forwarder, messageKeyFor, type ForwardLogger } from "./forwarder.js";
import plugin from "./index.js";
import { registerForwardPlugin } from "./plugin.js";
import { stateFilePath } from "./store.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  ConversationBinding,
  WebhookPayload,
} from "./types.js";

const TOKEN = "fake-token-not-a-secret";

type Captured = {
  authorization: string | undefined;
  body: WebhookPayload;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function trackDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(
  onRequest?: (body: WebhookPayload, res: http.ServerResponse) => void,
): Promise<{ url: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as WebhookPayload;
      requests.push({ authorization: req.headers.authorization, body });
      if (onRequest) {
        onRequest(body, res);
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("webhook test server has no port"));
        return;
      }
      cleanups.push(
        () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      );
      resolve({ url: `http://127.0.0.1:${address.port}/hook`, requests });
    });
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function writeReply(replyDir: string, requestId: string, body: unknown): void {
  fs.mkdirSync(replyDir, { recursive: true });
  fs.writeFileSync(path.join(replyDir, `${requestId}.json`), JSON.stringify(body));
}

type Turn = {
  event: BeforeDispatchEvent;
  ctx: BeforeDispatchContext;
  binding: ConversationBinding;
};

function weixinTurn(conversationId: string, messageId: string, content: string): Turn {
  const sessionKey = `agent:main:openclaw-weixin:direct:${conversationId}`;
  const binding: ConversationBinding = {
    channelId: "openclaw-weixin",
    accountId: "acct-1",
    conversationId,
    sessionKey,
    senderId: "",
  };
  return {
    binding,
    event: {
      messageId,
      content,
      channel: "openclaw-weixin",
      sessionKey,
      timestamp: 1_700_000_000_000,
    },
    ctx: {
      messageId,
      channelId: "openclaw-weixin",
      accountId: "acct-1",
      conversationId,
      sessionKey,
    },
  };
}

function makeForwarder(
  dir: string,
  url: string,
  overrides: { timeoutMs?: number; pollIntervalMs?: number; webhookToken?: string } = {},
): Forwarder {
  return new Forwarder({
    webhookUrl: url,
    webhookToken: overrides.webhookToken ?? TOKEN,
    stateDir: path.join(dir, "state"),
    replyDir: path.join(dir, "replies"),
    timeoutMs: overrides.timeoutMs ?? 1_500,
    pollIntervalMs: overrides.pollIntervalMs ?? 10,
    channelId: "openclaw-weixin",
  });
}

const silentLogger: ForwardLogger = {
  info() {},
  warn() {},
  error() {},
};

describe("weixin grok forwarder", () => {
  it("mints a request id, persists the original conversation, posts, and returns the reply file", async () => {
    const dir = trackDir("wgf-happy-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url);
    const turn = weixinTurn("wx-user-1", "msg-1", "hello from wechat");
    const pending = forwarder.handle(turn.event, turn.ctx);
    await waitFor(() => webhook.requests.length === 1, "webhook");
    const posted = webhook.requests[0];
    expect(posted?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(posted?.body.text).toBe("hello from wechat");
    expect(posted?.body.conversation).toEqual({ ...turn.binding, messageId: "msg-1" });
    expect(posted?.body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const onDisk = JSON.parse(fs.readFileSync(stateFilePath(path.join(dir, "state")), "utf8")) as {
      version: number;
      requests: Array<{ requestId: string; conversation: ConversationBinding; status: string }>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.requests[0]?.requestId).toBe(posted?.body.request_id);
    expect(onDisk.requests[0]?.conversation).toEqual(turn.binding);
    expect(onDisk.requests[0]?.status).toBe("waiting");
    expect(fs.readFileSync(stateFilePath(path.join(dir, "state")), "utf8")).not.toContain(TOKEN);

    writeReply(path.join(dir, "replies"), posted?.body.request_id ?? "", {
      request_id: posted?.body.request_id,
      text: "reply from doudou",
    });
    await expect(pending).resolves.toEqual({ handled: true, text: "reply from doudou" });
    expect(forwarder.listRequests()[0]?.status).toBe("completed");
    expect(forwarder.listRequests()[0]?.conversation).toEqual(turn.binding);
  });

  it("keeps two conversations isolated even when message ids collide", async () => {
    const dir = trackDir("wgf-iso-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url);
    const left = weixinTurn("wx-user-a", "same-id", "alpha");
    const right = weixinTurn("wx-user-b", "same-id", "beta");
    const leftPending = forwarder.handle(left.event, left.ctx);
    const rightPending = forwarder.handle(right.event, right.ctx);
    await waitFor(() => webhook.requests.length === 2, "two webhooks");
    const leftPost = webhook.requests.find(
      (item) => item.body.conversation.conversationId === "wx-user-a",
    );
    const rightPost = webhook.requests.find(
      (item) => item.body.conversation.conversationId === "wx-user-b",
    );
    expect(leftPost?.body.request_id).not.toBe(rightPost?.body.request_id);
    expect(leftPost?.body.text).toBe("alpha");
    expect(rightPost?.body.text).toBe("beta");
    writeReply(path.join(dir, "replies"), rightPost?.body.request_id ?? "", {
      request_id: rightPost?.body.request_id,
      text: "reply-b",
    });
    writeReply(path.join(dir, "replies"), leftPost?.body.request_id ?? "", {
      request_id: leftPost?.body.request_id,
      text: "reply-a",
    });
    await expect(leftPending).resolves.toEqual({ handled: true, text: "reply-a" });
    await expect(rightPending).resolves.toEqual({ handled: true, text: "reply-b" });
    const stored = forwarder.listRequests();
    expect(stored.map((item) => item.conversation.conversationId).sort()).toEqual([
      "wx-user-a",
      "wx-user-b",
    ]);
  });

  it("dedupes a repeated inbound message onto one webhook post", async () => {
    const dir = trackDir("wgf-dedupe-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url);
    const turn = weixinTurn("wx-user-1", "msg-repeat", "again");
    const first = forwarder.handle(turn.event, turn.ctx);
    const second = forwarder.handle(turn.event, turn.ctx);
    await waitFor(() => webhook.requests.length === 1, "single webhook");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(webhook.requests).toHaveLength(1);
    const requestId = webhook.requests[0]?.body.request_id ?? "";
    writeReply(path.join(dir, "replies"), requestId, { request_id: requestId, text: "once" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { handled: true, text: "once" },
      { handled: true, text: "once" },
    ]);
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: "once",
    });
    expect(webhook.requests).toHaveLength(1);
  });

  it("dedupes a repeated inbound message that has no message id when the timestamp matches", async () => {
    const dir = trackDir("wgf-fingerprint-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url);
    const turn = weixinTurn("wx-user-1", "", "same words");
    delete turn.event.messageId;
    delete turn.ctx.messageId;
    const first = forwarder.handle(turn.event, turn.ctx);
    await waitFor(() => webhook.requests.length === 1, "fingerprint webhook");
    const requestId = webhook.requests[0]?.body.request_id ?? "";
    writeReply(path.join(dir, "replies"), requestId, { text: "fingerprinted" });
    await expect(first).resolves.toEqual({ handled: true, text: "fingerprinted" });
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: "fingerprinted",
    });
    expect(webhook.requests).toHaveLength(1);
  });

  it("times out with the fixed fallback text", async () => {
    const dir = trackDir("wgf-timeout-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url, { timeoutMs: 40, pollIntervalMs: 10 });
    const turn = weixinTurn("wx-user-1", "msg-slow", "wait");
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    expect(FORWARD_FALLBACK_TEXT).toBe("暂时没有收到回复，请稍后再试。");
    expect(forwarder.listRequests()[0]?.status).toBe("failed");
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    expect(webhook.requests).toHaveLength(1);
  });

  it("reloads a pending request after a new instance starts and returns that reply", async () => {
    const dir = trackDir("wgf-restart-");
    const webhook = await listen();
    const configDir = dir;
    const original = makeForwarder(configDir, webhook.url);
    const turn = weixinTurn("wx-user-9", "msg-restart", "still there");
    const live = original.handle(turn.event, turn.ctx);
    const statePath = stateFilePath(path.join(dir, "state"));
    await waitFor(() => {
      if (!fs.existsSync(statePath)) return false;
      return fs.readFileSync(statePath, "utf8").includes('"webhookAccepted": true');
    }, "persisted accept");

    const revived = makeForwarder(configDir, webhook.url);
    const pending = revived.listRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("waiting");
    expect(pending[0]?.conversation).toEqual(turn.binding);
    expect(pending[0]?.requestId).toBe(webhook.requests[0]?.body.request_id);

    const resumed = revived.handle(turn.event, turn.ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(webhook.requests).toHaveLength(1);
    const requestId = pending[0]?.requestId ?? "";
    writeReply(path.join(dir, "replies"), requestId, { request_id: requestId, text: "picked up" });
    await expect(resumed).resolves.toEqual({ handled: true, text: "picked up" });
    await expect(live).resolves.toEqual({ handled: true, text: "picked up" });
  });

  it("posts a reloaded request that had not been accepted yet, keeping the same request id", async () => {
    const dir = trackDir("wgf-reaccept-");
    const webhook = await listen();
    const stateDir = path.join(dir, "state");
    const replyDir = path.join(dir, "replies");
    fs.mkdirSync(stateDir, { recursive: true });
    const turn = weixinTurn("wx-user-3", "msg-3", "retry me");
    const requestId = "11111111-1111-4111-8111-111111111111";
    fs.writeFileSync(
      stateFilePath(stateDir),
      JSON.stringify({
        version: 1,
        requests: [
          {
            requestId,
            messageKey: messageKeyFor(turn.binding, "msg-3", "retry me", turn.event.timestamp),
            messageId: "msg-3",
            conversation: turn.binding,
            inboundText: "retry me",
            status: "waiting",
            webhookAccepted: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const revived = new Forwarder({
      webhookUrl: webhook.url,
      webhookToken: TOKEN,
      stateDir,
      replyDir,
      timeoutMs: 1_500,
      pollIntervalMs: 10,
      channelId: "openclaw-weixin",
    });
    expect(revived.listRequests()[0]?.conversation).toEqual(turn.binding);
    const pending = revived.handle(turn.event, turn.ctx);
    await waitFor(() => webhook.requests.length === 1, "reaccepted webhook");
    expect(webhook.requests[0]?.body.request_id).toBe(requestId);
    writeReply(replyDir, requestId, { request_id: requestId, text: "late accept" });
    await expect(pending).resolves.toEqual({ handled: true, text: "late accept" });
  });

  it("returns fallback for a reloaded request id that is not a file name", async () => {
    const dir = trackDir("wgf-badid-");
    const webhook = await listen();
    const stateDir = path.join(dir, "state");
    const replyDir = path.join(dir, "replies");
    fs.mkdirSync(stateDir, { recursive: true });
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ text: "leaked" }));
    const turn = weixinTurn("wx-user-4", "msg-4", "bad id");
    fs.writeFileSync(
      stateFilePath(stateDir),
      JSON.stringify({
        version: 1,
        requests: [
          {
            requestId: "../outside",
            messageKey: messageKeyFor(turn.binding, "msg-4", "bad id", turn.event.timestamp),
            messageId: "msg-4",
            conversation: turn.binding,
            inboundText: "bad id",
            status: "waiting",
            webhookAccepted: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const forwarder = new Forwarder({
      webhookUrl: webhook.url,
      webhookToken: TOKEN,
      stateDir,
      replyDir,
      timeoutMs: 1_500,
      pollIntervalMs: 10,
      channelId: "openclaw-weixin",
    });
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    expect(webhook.requests).toHaveLength(0);
    expect(fs.readFileSync(outside, "utf8")).toContain("leaked");
  });

  it.each([
    ["http 500", 500, undefined],
    ["invalid json", 202, "not-json"],
    ["mismatched request id", 202, { request_id: randomUUID(), text: "wrong conversation" }],
    ["empty text", 202, { text: "   " }],
    ["non-string text", 202, { text: 12 }],
  ] as const)(
    "returns handled fallback when the reply path fails (%s)",
    async (_label, status, fileBody) => {
      const dir = trackDir("wgf-fail-");
      const webhook = await listen((_body, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
      });
      const forwarder = makeForwarder(dir, webhook.url, { timeoutMs: 300, pollIntervalMs: 10 });
      const turn = weixinTurn("wx-user-1", `msg-${_label}`, "fail please");
      const pending = forwarder.handle(turn.event, turn.ctx);
      if (status === 202) {
        await waitFor(() => webhook.requests.length === 1, "failure webhook");
        const requestId = webhook.requests[0]?.body.request_id ?? "";
        if (fileBody === "not-json") {
          fs.mkdirSync(path.join(dir, "replies"), { recursive: true });
          fs.writeFileSync(path.join(dir, "replies", `${requestId}.json`), "{");
        } else {
          writeReply(path.join(dir, "replies"), requestId, fileBody);
        }
      }
      await expect(pending).resolves.toEqual({ handled: true, text: FORWARD_FALLBACK_TEXT });
    },
  );

  it("returns handled fallback when the webhook cannot be reached", async () => {
    const dir = trackDir("wgf-down-");
    const webhook = await listen();
    const url = webhook.url;
    await cleanups.pop()?.();
    const forwarder = makeForwarder(dir, url, { timeoutMs: 200, pollIntervalMs: 10 });
    const turn = weixinTurn("wx-user-1", "msg-down", "offline");
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
  });

  it("returns handled fallback and does not post when state cannot be persisted", async () => {
    const dir = trackDir("wgf-disk-");
    const webhook = await listen();
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    const forwarder = new Forwarder({
      webhookUrl: webhook.url,
      webhookToken: TOKEN,
      stateDir: path.join(blocker, "state"),
      replyDir: path.join(dir, "replies"),
      timeoutMs: 200,
      pollIntervalMs: 10,
      channelId: "openclaw-weixin",
    });
    const turn = weixinTurn("wx-user-1", "msg-disk", "persist");
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    expect(webhook.requests).toHaveLength(0);
  });

  it("returns handled fallback for a weixin turn with no conversation binding", async () => {
    const dir = trackDir("wgf-nobind-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url);
    await expect(
      forwarder.handle(
        { content: "hello", channel: "openclaw-weixin", messageId: "msg-x" },
        { channelId: "openclaw-weixin", messageId: "msg-x" },
      ),
    ).resolves.toEqual({ handled: true, text: FORWARD_FALLBACK_TEXT });
    expect(webhook.requests).toHaveLength(0);
  });

  it("does not claim a non-weixin channel", async () => {
    const dir = trackDir("wgf-other-");
    const webhook = await listen();
    const forwarder = makeForwarder(dir, webhook.url);
    await expect(
      forwarder.handle(
        { content: "hi", channel: "telegram", messageId: "tg-1", senderId: "alice" },
        {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "alice",
          messageId: "tg-1",
          senderId: "alice",
        },
      ),
    ).resolves.toEqual({ handled: false });
    expect(webhook.requests).toHaveLength(0);
    expect(fs.existsSync(stateFilePath(path.join(dir, "state")))).toBe(false);
  });

  it("returns handled fallback when the logger throws", async () => {
    const dir = trackDir("wgf-logger-");
    const webhook = await listen();
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    const forwarder = new Forwarder(
      {
        webhookUrl: webhook.url,
        webhookToken: TOKEN,
        stateDir: path.join(blocker, "state"),
        replyDir: path.join(dir, "replies"),
        timeoutMs: 200,
        pollIntervalMs: 10,
        channelId: "openclaw-weixin",
      },
      {
        info() {
          throw new Error("logger failed");
        },
        warn() {
          throw new Error("logger failed");
        },
        error() {
          throw new Error("logger failed");
        },
      },
    );
    const turn = weixinTurn("wx-user-1", "msg-log", "log");
    await expect(forwarder.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    expect(webhook.requests).toHaveLength(0);
  });

  it("returns handled fallback for an empty token or a non-http webhook url", async () => {
    const dir = trackDir("wgf-auth-");
    const webhook = await listen();
    const turn = weixinTurn("wx-user-1", "msg-auth", "token");
    const missingToken = makeForwarder(dir, webhook.url, { webhookToken: "  " });
    await expect(missingToken.handle(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    const badUrl = new Forwarder({
      webhookUrl: "ftp://127.0.0.1/hook",
      webhookToken: TOKEN,
      stateDir: path.join(dir, "state-2"),
      replyDir: path.join(dir, "replies"),
      timeoutMs: 200,
      pollIntervalMs: 10,
      channelId: "openclaw-weixin",
    });
    await expect(
      badUrl.handle(
        weixinTurn("wx-user-1", "msg-url", "url").event,
        weixinTurn("wx-user-1", "msg-url", "url").ctx,
      ),
    ).resolves.toEqual({ handled: true, text: FORWARD_FALLBACK_TEXT });
    expect(webhook.requests).toHaveLength(0);
  });
});

describe("plugin registration", () => {
  it("registers before_dispatch and returns the reply through that hook", async () => {
    const dir = trackDir("wgf-plugin-");
    const webhook = await listen();
    const seen: Array<{
      name: string;
      handler: (
        event: BeforeDispatchEvent,
        ctx: BeforeDispatchContext,
      ) => Promise<{ handled: boolean; text?: string }>;
    }> = [];
    const api = {
      pluginConfig: {
        webhookUrl: webhook.url,
        webhookToken: TOKEN,
        stateDir: path.join(dir, "state"),
        replyDir: path.join(dir, "replies"),
        timeoutMs: 1_500,
        pollIntervalMs: 10,
      },
      logger: silentLogger,
      on(
        name: "before_dispatch",
        handler: (
          event: BeforeDispatchEvent,
          ctx: BeforeDispatchContext,
        ) => Promise<{ handled: boolean; text?: string }>,
      ) {
        seen.push({ name, handler });
      },
    };
    plugin.register(api as unknown as OpenClawPluginApi);
    expect(seen.map((item) => item.name)).toEqual(["before_dispatch"]);
    const turn = weixinTurn("wx-user-7", "msg-plugin", "via hook");
    const pending = seen[0]?.handler(turn.event, turn.ctx);
    await waitFor(() => webhook.requests.length === 1, "plugin webhook");
    const requestId = webhook.requests[0]?.body.request_id ?? "";
    writeReply(path.join(dir, "replies"), requestId, { request_id: requestId, text: "hook reply" });
    await expect(pending).resolves.toEqual({ handled: true, text: "hook reply" });
  });

  it("still returns handled true for weixin when config is invalid", async () => {
    let handler:
      | ((
          event: BeforeDispatchEvent,
          ctx: BeforeDispatchContext,
        ) => Promise<{ handled: boolean; text?: string }>)
      | undefined;
    registerForwardPlugin({
      pluginConfig: {},
      logger: silentLogger,
      on(_name, registered) {
        handler = registered;
      },
    });
    expect(handler).toBeTypeOf("function");
    const turn = weixinTurn("wx-user-1", "msg-badcfg", "no config");
    await expect(handler?.(turn.event, turn.ctx)).resolves.toEqual({
      handled: true,
      text: FORWARD_FALLBACK_TEXT,
    });
    await expect(
      handler?.(
        { content: "hi", channel: "telegram" },
        { channelId: "telegram", conversationId: "other" },
      ),
    ).resolves.toEqual({ handled: false });
    expect(configSchema().safeParse({}).success).toBe(false);
    expect(
      configSchema().safeParse({
        webhookUrl: "http://127.0.0.1/hook",
        webhookToken: TOKEN,
        stateDir: "/tmp/forward-state",
        replyDir: "/tmp/forward-replies",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
