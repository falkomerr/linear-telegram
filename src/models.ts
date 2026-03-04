import { z } from "zod";

export const prioritySchema = z.number().int().min(0).max(4);

export type Priority = z.infer<typeof prioritySchema>;

export const routePolicySchema = z.enum(["explicit-only", "explicit-or-last"]);

export interface ProjectConfig {
  id: string;
  key: string;
  name: string;
  aliases: string[];
}

export interface TeamInstanceConfig {
  id: string;
  name: string;
  telegramToken: string;
  linearApiToken: string;
  linearTeamId: string;
  defaultProjectId?: string;
  projects: ProjectConfig[];
  routePolicy: z.infer<typeof routePolicySchema>;
}

export interface AppConfig {
  instances: TeamInstanceConfig[];
}

export interface ParsedProjectResult {
  status: "resolved" | "needs_hint" | "unknown";
  project?: ProjectConfig;
  text: string;
  hint?: string;
  alternatives?: ProjectConfig[];
}

export const composedTaskSchema = z.object({
  projectKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: prioritySchema.default(2),
  labels: z.array(z.string()).default([]),
  dueDate: z.string().optional(),
  assignee: z.string().optional(),
  estimate: z.number().int().nonnegative().optional(),
  state: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.75),
  rawInput: z.string().min(1)
});

export type ComposedTask = z.infer<typeof composedTaskSchema>;

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface IssueCreatedResult {
  issue: LinearIssue;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  confidence?: number;
}

export interface ChatBinding {
  instanceId: string;
  chatId: number;
  userId?: number;
  projectId: string;
  updatedAt: string;
}

export interface PendingApproval {
  correlationId: string;
  instanceId: string;
  chatId: number;
  userId: number;
  payload: ComposedTask;
  rawInputText: string;
  sourceType: "text" | "voice";
  createdAt: string;
}

export interface PendingProjectRequest {
  instanceId: string;
  chatId: number;
  userId: number;
  originalText: string;
  sourceType: "text" | "voice";
  extraPayload?: string;
  createdAt: string;
}

export interface AppRuntimeContext {
  instanceId: string;
  botId: string;
}
