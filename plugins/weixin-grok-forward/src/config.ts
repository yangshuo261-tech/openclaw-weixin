import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS,
  MIN_TIMEOUT_MS,
  WEIXIN_CHANNEL_ID,
} from "./constants.js";

export type ForwardConfig = {
  webhookUrl: string;
  webhookToken: string;
  stateDir: string;
  replyDir: string;
  timeoutMs: number;
  pollIntervalMs: number;
  channelId: string;
};

export type ConfigIssue = {
  path: Array<string | number>;
  message: string;
};

export type ParseResult =
  | { ok: true; config: ForwardConfig }
  | { ok: false; issues: ConfigIssue[] };

const ALLOWED = new Set([
  "webhookUrl",
  "webhookToken",
  "stateDir",
  "replyDir",
  "timeoutMs",
  "pollIntervalMs",
  "channelId",
]);

function requiredString(
  record: Record<string, unknown>,
  key: string,
  issues: ConfigIssue[],
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: [key], message: "required non-empty string" });
    return "";
  }
  return value.trim();
}

function optionalPositive(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  issues: ConfigIssue[],
): number {
  if (record[key] === undefined) return fallback;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    issues.push({ path: [key], message: `number between ${min} and ${max}` });
    return fallback;
  }
  return value;
}

export function parsePluginConfig(value: unknown): ParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: [{ path: [], message: "config must be an object" }] };
  }
  const record = value as Record<string, unknown>;
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) issues.push({ path: [key], message: "unknown config field" });
  }
  const webhookUrl = requiredString(record, "webhookUrl", issues);
  const webhookToken = requiredString(record, "webhookToken", issues);
  const stateDir = requiredString(record, "stateDir", issues);
  const replyDir = requiredString(record, "replyDir", issues);
  const timeoutMs = optionalPositive(
    record,
    "timeoutMs",
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    issues,
  );
  const pollIntervalMs = optionalPositive(
    record,
    "pollIntervalMs",
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    issues,
  );
  let channelId = WEIXIN_CHANNEL_ID;
  if (record.channelId !== undefined) {
    if (typeof record.channelId !== "string" || record.channelId.trim() === "") {
      issues.push({ path: ["channelId"], message: "non-empty string" });
    } else {
      channelId = record.channelId.trim().toLowerCase();
    }
  }
  if (pollIntervalMs >= timeoutMs) {
    issues.push({ path: ["pollIntervalMs"], message: "must be less than timeoutMs" });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: {
      webhookUrl,
      webhookToken,
      stateDir,
      replyDir,
      timeoutMs,
      pollIntervalMs,
      channelId,
    },
  };
}

export function configSchema() {
  return {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        webhookUrl: { type: "string" },
        webhookToken: { type: "string" },
        stateDir: { type: "string" },
        replyDir: { type: "string" },
        timeoutMs: { type: "number" },
        pollIntervalMs: { type: "number" },
        channelId: { type: "string" },
      },
      required: ["webhookUrl", "webhookToken", "stateDir", "replyDir"],
    },
    safeParse(value: unknown) {
      const parsed = parsePluginConfig(value);
      if (!parsed.ok) return { success: false as const, error: { issues: parsed.issues } };
      return { success: true as const, data: parsed.config };
    },
  };
}
