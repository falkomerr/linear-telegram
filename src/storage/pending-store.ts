import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PendingApproval, PendingProjectRequest } from "../models.js";
import { env } from "../utils.js";

interface ApprovalFile {
  version: number;
  approvals: Array<PendingApproval & { key?: string }>;
  projectRequests: Array<PendingProjectRequest & { key?: string }>;
}

const approvalTtlMs = 1000 * 60 * 15;
const projectTtlMs = 1000 * 60 * 15;

export class PendingStore {
  private readonly filePath = path.resolve(process.cwd(), env("PENDING_STORE_FILE", "./data/pending-store.json"));
  private approvalByChat = new Map<string, PendingApproval>();
  private projectByChat = new Map<string, PendingProjectRequest>();
  private persistChain = Promise.resolve();

  private isApprovalExpired = (value: PendingApproval) =>
    Date.now() - new Date(value.createdAt).getTime() > approvalTtlMs;

  private isProjectRequestExpired = (value: PendingProjectRequest) =>
    Date.now() - new Date(value.createdAt).getTime() > projectTtlMs;

  private toKey = (instanceId: string, chatId: number, userId: number) => `${instanceId}:${chatId}:${userId}`;

  private parseKey = (rawKey: string) => {
    const parts = rawKey.split(":");
    if (parts.length === 2) {
      const [chatIdRaw, userIdRaw] = parts;
      const chatId = Number(chatIdRaw);
      const userId = Number(userIdRaw);
      if (Number.isNaN(chatId) || Number.isNaN(userId)) {
        return null;
      }
      return { instanceId: "", chatId, userId, isLegacyTwoPart: true };
    }

    if (parts.length === 3) {
      const [instanceId, chatIdRaw, userIdRaw] = parts;
      const chatId = Number(chatIdRaw);
      const userId = Number(userIdRaw);
      if (!instanceId || Number.isNaN(chatId) || Number.isNaN(userId)) {
        return null;
      }
      return { instanceId, chatId, userId, isLegacyTwoPart: false };
    }

    return null;
  };

  private normalizeKey = (
    rawKey: string | undefined,
    instanceId: string,
    chatId: number,
    userId: number
  ) => {
    const parsedFromItem = this.toKey(instanceId, chatId, userId);
    if (typeof rawKey !== "string") {
      return parsedFromItem;
    }

    const parsed = this.parseKey(rawKey);
    if (!parsed) {
      return parsedFromItem;
    }

    if (parsed.isLegacyTwoPart) {
      if (parsed.chatId !== chatId || parsed.userId !== userId) {
        return null;
      }
      return parsedFromItem;
    }

    if (parsed.instanceId !== instanceId || parsed.chatId !== chatId || parsed.userId !== userId) {
      return null;
    }

    return rawKey;
  };

  private normalizeApprovalKey = (item: PendingApproval & { key?: string }) => {
    return this.normalizeKey(item.key, item.instanceId, item.chatId, item.userId);
  };

  private normalizeProjectRequestKey = (item: PendingProjectRequest & { key?: string }) => {
    return this.normalizeKey(item.key, item.instanceId, item.chatId, item.userId);
  };

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(data) as ApprovalFile;
      const approvals = Array.isArray(parsed?.approvals) ? parsed.approvals : [];
      const projectRequests = Array.isArray(parsed?.projectRequests) ? parsed.projectRequests : [];

      this.approvalByChat.clear();
      this.projectByChat.clear();

      for (const approval of approvals) {
        if (!approval.createdAt || !approval.correlationId || typeof approval.chatId !== "number" || typeof approval.instanceId !== "string" || typeof approval.userId !== "number") {
          continue;
        }
        if (this.isApprovalExpired(approval)) {
          continue;
        }

        const key = this.normalizeApprovalKey(approval);
        if (!key) {
          continue;
        }
        this.approvalByChat.set(key, approval);
      }

      for (const projectRequest of projectRequests) {
        if (!projectRequest.createdAt || typeof projectRequest.instanceId !== "string" || typeof projectRequest.chatId !== "number" || typeof projectRequest.userId !== "number") {
          continue;
        }
        if (this.isProjectRequestExpired(projectRequest)) {
          continue;
        }

        const key = this.normalizeProjectRequestKey(projectRequest);
        if (!key) {
          continue;
        }
        this.projectByChat.set(key, projectRequest);
      }
    } catch {
      this.approvalByChat = new Map();
      this.projectByChat = new Map();
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const payload: ApprovalFile = {
      version: 1,
      approvals: [...this.approvalByChat.entries()].map(([key, value]) => ({ key, ...value })),
      projectRequests: [...this.projectByChat.entries()].map(([key, value]) => ({ key, ...value }))
    };
    const tempPath = `${this.filePath}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.rename(tempPath, this.filePath);
  }

  private persistSafely() {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((error) => {
        console.error("pending-store persist failed", error instanceof Error ? error.message : `${error}`);
      });
  }

  getPendingPersistState() {
    return this.persistChain;
  }

  async waitForPersist() {
    await this.persistChain;
  }

  async flush() {
    await this.persist();
  }

  async compact(): Promise<void> {
    this.cleanupIfNeeded();
    await this.waitForPersist();
  }

  private cleanupIfNeeded() {
    for (const [key, approval] of this.approvalByChat) {
      if (this.isApprovalExpired(approval)) {
        this.approvalByChat.delete(key);
      }
    }

    for (const [key, project] of this.projectByChat) {
      if (this.isProjectRequestExpired(project)) {
        this.projectByChat.delete(key);
      }
    }
  }

  setApproval(key: string, value: PendingApproval): void {
    this.approvalByChat.set(key, value);
    this.cleanupIfNeeded();
    this.persistSafely();
  }

  getApproval(key: string): PendingApproval | null {
    const value = this.approvalByChat.get(key);
    if (!value) return null;
    if (this.isApprovalExpired(value)) {
      this.approvalByChat.delete(key);
      this.persistSafely();
      return null;
    }

    return value;
  }

  deleteApproval(key: string): void {
    this.approvalByChat.delete(key);
    this.persistSafely();
  }

  setProjectRequest(key: string, value: PendingProjectRequest): void {
    this.projectByChat.set(key, value);
    this.cleanupIfNeeded();
    this.persistSafely();
  }

  getProjectRequest(key: string): PendingProjectRequest | null {
    const value = this.projectByChat.get(key);
    if (!value) return null;
    if (this.isProjectRequestExpired(value)) {
      this.projectByChat.delete(key);
      this.persistSafely();
      return null;
    }

    return value;
  }

  deleteProjectRequest(key: string): void {
    this.projectByChat.delete(key);
    this.persistSafely();
  }
}
