import fs from "node:fs";
import path from "node:path";

import type { StoredRequest } from "./types.js";

const STATE_NAME = "requests.json";
const LOCK_NAME = ".lock";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBinding(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.channelId === "string" &&
    typeof binding.accountId === "string" &&
    typeof binding.conversationId === "string" &&
    typeof binding.sessionKey === "string" &&
    typeof binding.senderId === "string"
  );
}

function isStoredRequest(value: unknown): value is StoredRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === "string" &&
    typeof record.messageKey === "string" &&
    typeof record.messageId === "string" &&
    isBinding(record.conversation) &&
    typeof record.inboundText === "string" &&
    (record.status === "waiting" || record.status === "completed" || record.status === "failed") &&
    typeof record.webhookAccepted === "boolean" &&
    (record.replyText === undefined || typeof record.replyText === "string") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

async function withStateLock<T>(stateDir: string, body: () => T): Promise<T> {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, LOCK_NAME);
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) fs.unlinkSync(lockPath);
      } catch {
        // The other waiter removed the lock.
      }
      if (Date.now() > deadline) throw new Error("timed out locking forwarder state");
      await delay(5);
    }
  }
  try {
    return body();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already released.
    }
  }
}

export class RequestStore {
  constructor(private readonly stateDir: string) {}

  load(): StoredRequest[] {
    const filePath = path.join(this.stateDir, STATE_NAME);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const requests = (parsed as { requests?: unknown }).requests;
    if (!Array.isArray(requests)) return [];
    return requests.filter(isStoredRequest);
  }

  async update(mutate: (requests: StoredRequest[]) => void): Promise<void> {
    await withStateLock(this.stateDir, () => {
      const requests = this.load();
      mutate(requests);
      const filePath = path.join(this.stateDir, STATE_NAME);
      const tmpPath = path.join(
        this.stateDir,
        `requests.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
      );
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, requests }, null, 2));
      fs.renameSync(tmpPath, filePath);
    });
  }
}

export function stateFilePath(stateDir: string): string {
  return path.join(stateDir, STATE_NAME);
}
