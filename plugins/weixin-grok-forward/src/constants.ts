/** Fixed text returned for every handled failure, including timeout. */
export const FORWARD_FALLBACK_TEXT = "暂时没有收到回复，请稍后再试。";

/** Channel id this plugin claims. OpenClaw lowercases OriginatingChannel before the hook. */
export const WEIXIN_CHANNEL_ID = "openclaw-weixin";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;
export const MIN_TIMEOUT_MS = 20;
export const MAX_TIMEOUT_MS = 120_000;
export const MIN_POLL_INTERVAL_MS = 5;
export const MAX_POLL_INTERVAL_MS = 1_000;
