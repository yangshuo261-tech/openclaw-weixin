# weixin-grok-forward

Standalone OpenClaw plugin. It does not modify the Weixin channel.

On `before_dispatch` for channel `openclaw-weixin`, it mints a `request_id`, stores the hook's conversation binding on disk, and `POST`s that payload to a Grok bot webhook. It then waits for `{replyDir}/{request_id}.json` and returns `{ handled: true, text }` from the hook. Every Weixin failure, including timeout, returns the fixed fallback text with `handled: true`.

This package's tests are offline. They use a local fake webhook, a fake bearer token, and temporary directories. They do not connect WeChat, call a real webhook, or prove that a live OpenClaw gateway skips the model.

## Config

`plugins.entries.weixin-grok-forward.config`:

| Field            | Required | Meaning                                                          |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `webhookUrl`     | yes      | `http:` or `https:` URL of the bot webhook                       |
| `webhookToken`   | yes      | Sent only as `Authorization: Bearer <token>`                     |
| `stateDir`       | yes      | Directory for `requests.json`                                    |
| `replyDir`       | yes      | Directory the bot writes reply files into                        |
| `timeoutMs`      | no       | Wait for the reply file. Default `20000` (20–120000)             |
| `pollIntervalMs` | no       | Poll interval. Default `100` (5–1000, and less than `timeoutMs`) |
| `channelId`      | no       | Channel to claim. Default `openclaw-weixin`                      |

## Webhook body

```json
{
  "request_id": "uuid",
  "text": "inbound hook content",
  "conversation": {
    "channelId": "openclaw-weixin",
    "accountId": "",
    "conversationId": "",
    "sessionKey": "",
    "senderId": "",
    "messageId": ""
  }
}
```

The conversation fields are copied from the `before_dispatch` event and context. For this channel, OpenClaw fills `conversationId` from `OriginatingTo` / `To`, which the channel sets to `from_user_id`. The plugin never reads account files or calls the Weixin HTTP API.

## Reply file

`{replyDir}/{request_id}.json`:

```json
{ "request_id": "same uuid", "text": "reply text" }
```

`request_id` inside the file is optional. If present, it must match the file name. `text` must be a non-empty string. The file name has to be the uuid this plugin minted.

## Fallback

`暂时没有收到回复，请稍后再试。`

## Checks

From the repository root, after `npm ci --ignore-scripts --include=dev`:

```bash
npm test --prefix plugins/weixin-grok-forward
npm run typecheck --prefix plugins/weixin-grok-forward
```
