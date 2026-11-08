import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { configSchema, registerForwardPlugin } from "./plugin.js";

export default definePluginEntry({
  id: "weixin-grok-forward",
  name: "Weixin Grok Forward",
  description:
    "Forwards openclaw-weixin turns to a Grok bot webhook and returns the reply file through before_dispatch.",
  configSchema: configSchema(),
  register(api: OpenClawPluginApi) {
    registerForwardPlugin(api);
  },
});
