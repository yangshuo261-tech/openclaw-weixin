import { FORWARD_FALLBACK_TEXT, WEIXIN_CHANNEL_ID } from "./constants.js";
import { configSchema, parsePluginConfig } from "./config.js";
import { Forwarder, type ForwardLogger } from "./forwarder.js";
import type { BeforeDispatchContext, BeforeDispatchEvent, BeforeDispatchResult } from "./types.js";

export type ForwardPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: ForwardLogger;
  on: (
    hookName: "before_dispatch",
    handler: (
      event: BeforeDispatchEvent,
      ctx: BeforeDispatchContext,
    ) => Promise<BeforeDispatchResult>,
  ) => void;
};

export { configSchema };

function channelOf(event: BeforeDispatchEvent, ctx: BeforeDispatchContext): string {
  return (ctx.channelId ?? event.channel ?? "").trim().toLowerCase();
}

/**
 * Register the public before_dispatch hook.
 * A WeChat-channel failure still returns handled:true so the host does not
 * continue into model dispatch. Other channels are left unclaimed.
 */
export function registerForwardPlugin(api: ForwardPluginApi): void {
  const parsed = parsePluginConfig(api.pluginConfig ?? {});
  const forwarder = parsed.ok ? new Forwarder(parsed.config, api.logger) : undefined;
  if (!parsed.ok) {
    api.logger.warn(
      "weixin-grok-forward: invalid plugin config; weixin turns return fallback text",
    );
  }
  api.on("before_dispatch", async (event, ctx) => {
    if (!forwarder) {
      if (channelOf(event, ctx) !== WEIXIN_CHANNEL_ID) return { handled: false };
      return { handled: true, text: FORWARD_FALLBACK_TEXT };
    }
    return forwarder.handle(event, ctx);
  });
}
