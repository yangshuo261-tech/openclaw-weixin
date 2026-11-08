import { randomUUID } from "node:crypto";

import { FORWARD_FALLBACK_TEXT } from "./constants.js";
import type { ForwardConfig } from "./config.js";
import { readReplyFile } from "./reply-file.js";
import { RequestStore } from "./store.js";
import type {
  BeforeDispatchContext,
  BeforeDispatchEvent,
  BeforeDispatchResult,
  ConversationBinding,
  StoredRequest,
  WebhookPayload,
} from "./types.js";
import { postForwardWebhook } from "./webhook.js";

export type ForwardLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const silentLogger: ForwardLogger = {
  info() {},
  warn() {},
  error() {},
};

function safeLog(logger: ForwardLogger, level: keyof ForwardLogger, message: string): void {
  try {
    logger[level](message);
  } catch {
    // A broken logger must not turn a handled turn into a thrown hook.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function bindingFrom(
  channelId: string,
  event: BeforeDispatchEvent,
  ctx: BeforeDispatchContext,
): ConversationBinding {
  return {
    channelId,
    accountId: textOf(ctx.accountId),
    conversationId: textOf(ctx.conversationId),
    sessionKey: textOf(ctx.sessionKey ?? event.sessionKey),
    senderId: textOf(ctx.senderId ?? event.senderId),
  };
}

function hasConversation(binding: ConversationBinding): boolean {
  return Boolean(binding.conversationId || binding.senderId || binding.sessionKey);
}

export function messageKeyFor(
  binding: ConversationBinding,
  messageId: string,
  content: string,
  timestamp?: number,
): string {
  const parts = [
    binding.channelId,
    binding.accountId,
    binding.conversationId,
    binding.sessionKey,
    binding.senderId,
  ];
  if (messageId) return ["id", ...parts, messageId].join("\u0000");
  return ["fp", ...parts, content, String(timestamp ?? "")].join("\u0000");
}

function fallback(): BeforeDispatchResult {
  return { handled: true, text: FORWARD_FALLBACK_TEXT };
}

export class Forwarder {
  private readonly store: RequestStore;
  private readonly inflight = new Map<string, Promise<BeforeDispatchResult>>();

  constructor(
    private readonly config: ForwardConfig,
    private readonly logger: ForwardLogger = silentLogger,
  ) {
    this.store = new RequestStore(config.stateDir);
  }

  listRequests(): StoredRequest[] {
    return this.store.load();
  }

  async handle(
    event: BeforeDispatchEvent,
    ctx: BeforeDispatchContext,
  ): Promise<BeforeDispatchResult> {
    try {
      const channelId = textOf(ctx.channelId ?? event.channel).toLowerCase();
      if (channelId !== this.config.channelId) return { handled: false };
      const binding = bindingFrom(channelId, event, ctx);
      if (!hasConversation(binding)) {
        safeLog(this.logger, "warn", "weixin-grok-forward: missing conversation binding");
        return fallback();
      }
      const messageId = textOf(event.messageId ?? ctx.messageId);
      const key = messageKeyFor(binding, messageId, event.content ?? "", event.timestamp);
      const existing = this.inflight.get(key);
      if (existing) return await existing;
      const promise = this.dispatch(event, binding, messageId, key).catch((error: unknown) => {
        safeLog(
          this.logger,
          "error",
          `weixin-grok-forward: ${error instanceof Error ? error.message : "failed"}`,
        );
        return fallback();
      });
      this.inflight.set(key, promise);
      try {
        return await promise;
      } finally {
        this.inflight.delete(key);
      }
    } catch (error) {
      safeLog(
        this.logger,
        "error",
        `weixin-grok-forward: ${error instanceof Error ? error.message : "failed"}`,
      );
      return fallback();
    }
  }

  private async dispatch(
    event: BeforeDispatchEvent,
    binding: ConversationBinding,
    messageId: string,
    key: string,
  ): Promise<BeforeDispatchResult> {
    const prior = this.store.load().find((record) => record.messageKey === key);
    if (prior) return this.continueRequest(prior, event.content ?? "");
    const now = new Date().toISOString();
    const created: StoredRequest = {
      requestId: randomUUID(),
      messageKey: key,
      messageId,
      conversation: binding,
      inboundText: event.content ?? "",
      status: "waiting",
      webhookAccepted: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.update((requests) => {
        if (!requests.some((record) => record.messageKey === key)) requests.push(created);
      });
    } catch (error) {
      safeLog(
        this.logger,
        "error",
        `weixin-grok-forward: persist failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return fallback();
    }
    const stored = this.store.load().find((record) => record.messageKey === key) ?? created;
    return this.continueRequest(stored, event.content ?? "");
  }

  private async continueRequest(
    record: StoredRequest,
    text: string,
  ): Promise<BeforeDispatchResult> {
    if (record.status === "completed") {
      return record.replyText ? { handled: true, text: record.replyText } : fallback();
    }
    if (record.status === "failed") return fallback();
    if (!record.webhookAccepted) {
      const accepted = await this.post(record, text);
      if (!accepted) {
        await this.mark(record.requestId, { status: "failed", webhookAccepted: false });
        return fallback();
      }
      await this.mark(record.requestId, { webhookAccepted: true });
    }
    return this.waitForReply(record.requestId);
  }

  private async post(record: StoredRequest, text: string): Promise<boolean> {
    const payload: WebhookPayload = {
      request_id: record.requestId,
      text,
      conversation: { ...record.conversation, messageId: record.messageId },
    };
    const result = await postForwardWebhook({
      url: this.config.webhookUrl,
      token: this.config.webhookToken,
      payload,
    });
    if (!result.ok) {
      safeLog(
        this.logger,
        "warn",
        `weixin-grok-forward: webhook ${result.reason} request=${record.requestId}`,
      );
      return false;
    }
    safeLog(
      this.logger,
      "info",
      `weixin-grok-forward: webhook accepted request=${record.requestId}`,
    );
    return true;
  }

  private async waitForReply(requestId: string): Promise<BeforeDispatchResult> {
    const deadline = Date.now() + this.config.timeoutMs;
    for (;;) {
      const reply = readReplyFile(this.config.replyDir, requestId);
      if (reply.status === "ready") {
        await this.mark(requestId, { status: "completed", replyText: reply.text });
        return { handled: true, text: reply.text };
      }
      if (reply.status === "invalid") {
        await this.mark(requestId, { status: "failed" });
        return fallback();
      }
      if (Date.now() >= deadline) {
        await this.mark(requestId, { status: "failed" });
        return fallback();
      }
      await delay(this.config.pollIntervalMs);
    }
  }

  private async mark(requestId: string, patch: Partial<StoredRequest>): Promise<void> {
    await this.store.update((requests) => {
      const found = requests.find((record) => record.requestId === requestId);
      if (!found) return;
      Object.assign(found, patch, { updatedAt: new Date().toISOString() });
    });
  }
}
