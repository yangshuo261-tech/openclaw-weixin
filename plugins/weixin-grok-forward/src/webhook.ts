import type { WebhookPayload } from "./types.ts";

export type WebhookPostResult = { ok: true } | { ok: false; reason: string };

export async function postForwardWebhook(args: {
  url: string;
  token: string;
  payload: WebhookPayload;
}): Promise<WebhookPostResult> {
  if (args.token.trim() === "") return { ok: false, reason: "missing_token" };
  let target: URL;
  try {
    target = new URL(args.url);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, reason: "bad_url" };
  }
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify(args.payload),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "network" };
  }
}
