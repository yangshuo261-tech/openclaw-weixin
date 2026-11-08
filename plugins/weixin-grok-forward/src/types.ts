/**
 * Public before_dispatch shape from OpenClaw 2026.8.1
 * (`dist/hook-types-*.d.ts` PluginHookBeforeDispatchEvent/Context/Result).
 * The handler is checked against `api.on("before_dispatch", ...)` at typecheck.
 * Extra host fields are ignored. This plugin does not import channel internals.
 */
export type BeforeDispatchEvent = {
  messageId?: string;
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
  timestamp?: number;
};

export type BeforeDispatchContext = {
  messageId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
};

export type BeforeDispatchResult = {
  handled: boolean;
  text?: string;
};

/** Fields that tie a minted request_id back to the WeChat turn OpenClaw already routed. */
export type ConversationBinding = {
  channelId: string;
  accountId: string;
  conversationId: string;
  sessionKey: string;
  senderId: string;
};

export type StoredRequest = {
  requestId: string;
  messageKey: string;
  messageId: string;
  conversation: ConversationBinding;
  inboundText: string;
  status: "waiting" | "completed" | "failed";
  webhookAccepted: boolean;
  replyText?: string;
  createdAt: string;
  updatedAt: string;
};

export type WebhookConversation = ConversationBinding & {
  messageId: string;
};

export type WebhookPayload = {
  request_id: string;
  text: string;
  conversation: WebhookConversation;
};
