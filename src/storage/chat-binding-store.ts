import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ChatBinding } from "../models.js";
import { env, toLowerTrim } from "../utils.js";

interface BindingFile {
  version: number;
  items: ChatBinding[];
}

const toKey = (instanceId: string, chatId: number) => `${instanceId}:${chatId}`;

export class ChatBindingStore {
  private readonly filePath = path.resolve(process.cwd(), env("BINDINGS_FILE", "./data/chat-bindings.json"));
  private bindings = new Map<string, ChatBinding>();

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(data) as BindingFile;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const item of items) {
        if (!item?.instanceId || !item?.chatId || !item?.projectId) continue;
        this.bindings.set(toKey(item.instanceId, item.chatId), item);
      }
    } catch {
      this.bindings = new Map();
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const payload: BindingFile = {
      version: 1,
      items: [...this.bindings.values()]
    };
    const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.rename(tempPath, this.filePath);
  }

  async setProjectForChat(instanceId: string, chatId: number, userId: number | undefined, projectId: string): Promise<void> {
    this.bindings.set(toKey(instanceId, chatId), {
      instanceId,
      chatId,
      userId,
      projectId,
      updatedAt: new Date().toISOString()
    });
    await this.persist();
  }

  getProjectForChat(instanceId: string, chatId: number): ChatBinding | null {
    return this.bindings.get(toKey(instanceId, chatId)) ?? null;
  }

  async clearProjectForChat(instanceId: string, chatId: number): Promise<void> {
    this.bindings.delete(toKey(instanceId, chatId));
    await this.persist();
  }
}

export const chatKey = (instanceId: string, chatId: number) => toLowerTrim(toKey(instanceId, chatId));
