import fs from "node:fs";
import path from "node:path";

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReplyRead =
  | { status: "missing" }
  | { status: "ready"; text: string }
  | { status: "invalid" };

export function replyFilePath(replyDir: string, requestId: string): string | undefined {
  if (!REQUEST_ID_RE.test(requestId)) return undefined;
  const root = path.resolve(replyDir);
  const filePath = path.resolve(root, `${requestId}.json`);
  if (filePath !== path.join(root, `${requestId}.json`)) return undefined;
  return filePath;
}

function parseReply(raw: string, requestId: string): ReplyRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid" };
  }
  const record = value as Record<string, unknown>;
  if (record.request_id !== undefined && record.request_id !== requestId) {
    return { status: "invalid" };
  }
  if (typeof record.text !== "string" || record.text.trim() === "") {
    return { status: "invalid" };
  }
  return { status: "ready", text: record.text };
}

/** Read `{replyDir}/{requestId}.json`. The filename is the request key. */
export function readReplyFile(replyDir: string, requestId: string): ReplyRead {
  const filePath = replyFilePath(replyDir, requestId);
  if (!filePath) return { status: "invalid" };
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing" };
    return { status: "invalid" };
  }
  try {
    return parseReply(fs.readFileSync(fd, "utf8"), requestId);
  } catch {
    return { status: "invalid" };
  } finally {
    fs.closeSync(fd);
  }
}
