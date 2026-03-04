import { config } from "dotenv";
import { Context, Telegraf } from "telegraf";

import {
  AppConfig,
  ChatBinding,
  ComposedTask,
  ParsedProjectResult,
  TeamInstanceConfig,
  TranscriptionResult
} from "./models.js";
import { ChatBindingStore } from "./storage/chat-binding-store.js";
import { PendingStore } from "./storage/pending-store.js";
import { SimpleQueue } from "./services/queue.js";
import { composeTaskPayload, resolveProjectWithCodex } from "./services/codex.js";
import { createLinearIssue } from "./services/linear.js";
import { loadConfig } from "./config.js";
import { parseProjectFromText } from "./router.js";
import { transcribeAudioFile } from "./services/transcription.js";
import { logger } from "./logger.js";
import { env, asBool, hashString } from "./utils.js";

config();

type AppState = {
  cfg: AppConfig;
  bindingStore: ChatBindingStore;
  pendingStore: PendingStore;
  queue: SimpleQueue;
  recentMessageIds: Map<string, number>;
  inFlightApprovals: Set<string>;
};

type PendingContext = {
  key: string;
  instance: TeamInstanceConfig;
  instanceId: string;
  chatId: number;
  userId: number;
  correlationId: string;
};

class PendingDraftAction extends Error {
  code: "REQUIRES_APPROVAL" = "REQUIRES_APPROVAL";

  constructor(message: string, public readonly payload: ComposedTask) {
    super(message);
    this.name = "PendingDraftAction";
  }
}

const appState: AppState = {
  cfg: { instances: [] },
  bindingStore: new ChatBindingStore(),
  pendingStore: new PendingStore(),
  queue: new SimpleQueue(Math.max(1, Number(env("QUEUE_CONCURRENCY", "2")))),
  recentMessageIds: new Map(),
  inFlightApprovals: new Set()
};

const stateKey = (instanceId: string, chatId: number, userId: number) => `${instanceId}:${chatId}:${userId}`;

const dedupeWindowMs = Number(env("REQUEST_DEDUP_TTL_MS", "120000"));

const correlationId = (
  instanceId: string,
  chatId: number,
  userId: number,
  messageId: number,
  text: string
) => {
  return hashString(`${instanceId}:${chatId}:${userId}:${messageId}:${text}`).slice(0, 12);
};

const markMessageSeen = (instanceId: string, chatId: number, messageId: number): boolean => {
  const key = `${instanceId}:${chatId}:${messageId}`;
  const now = Date.now();
  const lastSeen = appState.recentMessageIds.get(key);
  if (lastSeen && now - lastSeen < dedupeWindowMs) {
    return true;
  }

  appState.recentMessageIds.set(key, now);
  return false;
};

const escapeMarkdownV2 = (text: string) =>
  text.replace(/[\\_\*\[\]\(\)~`>#+\-=|{}.!]/g, (match) => `\\${match}`);

const sendSafeReply = async (ctx: Context, text: string, markdown = false) => {
  if (!ctx || !ctx.reply) {
    return;
  }

  if (markdown) {
    await ctx
      .replyWithMarkdownV2(escapeMarkdownV2(text))
      .catch(() => {
        return ctx.reply(text);
      });
    return;
  }

  await ctx.reply(text);
};

const formatProjectList = (instance: TeamInstanceConfig): string => {
  if (instance.projects.length === 0) {
    return "Проекты не настроены.";
  }
  return instance.projects.map((project) => `${project.key}: ${project.name}`).join("\n");
};

const mapProjectByKey = (instance: TeamInstanceConfig, key: string) => {
  const lower = key.toLowerCase();
  return (
    instance.projects.find((item) => item.key.toLowerCase() === lower) ??
    instance.projects.find((item) => item.aliases.map((alias) => alias.toLowerCase()).includes(lower))
  );
};

const shouldAutoUseLastProject = (instance: TeamInstanceConfig): boolean => {
  return instance.routePolicy === "explicit-or-last";
};

const shouldAutoUseDefaultProject = (instance: TeamInstanceConfig): boolean => {
  return instance.routePolicy === "explicit-or-last";
};

const findDefaultProject = (instance: TeamInstanceConfig) => {
  if (!instance.defaultProjectId) {
    return null;
  }

  return instance.projects.find((project) => project.id === instance.defaultProjectId) ?? null;
};

const buildConfirmationMessage = (payload: ComposedTask, url?: string) => {
  const lines = [
    `Проект: ${payload.projectKey}`,
    `Название: ${payload.title}`,
    `Описание: ${payload.description}`,
    `Приоритет: ${payload.priority}`,
    `Метки: ${payload.labels?.length ? payload.labels.join(", ") : "—"}`,
    `Уверенность: ${(payload.confidence * 100).toFixed(0)}%`
  ];

  if (url) {
    lines.push(`Ссылка на задачу: ${url}`);
  }

  lines.push(
    "",
    "approve — создать задачу",
    "/approve — создать задачу",
    "edit <новый текст> — исправить и пересобрать",
    "/edit <новый текст> — исправить и пересобрать",
    "cancel — отменить",
    "/cancel — отменить"
  );

  return lines.join("\n");
};

const isUserAuthorized = (instance: TeamInstanceConfig, userId: number): boolean => {
  if (!instance.allowedUserIds || instance.allowedUserIds.length === 0) {
    return true;
  }
  return instance.allowedUserIds.includes(userId);
};

const parseApprovalCommand = (rawText: string) => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { type: "empty" as const };
  }

  const normalized = trimmed.replace(/^\//, "").trim();
  const normalizedLower = normalized.toLowerCase();
  const pieces = normalizedLower.split(/\s+/);
  const command = pieces[0] ?? "";
  const tail = normalized.substring(command.length).trim();

  if (["approve", "create", "да", "yes"].includes(command)) {
    return { type: "approve" as const };
  }

  if (["cancel", "нет", "no", "отмена", "отменить"].includes(command)) {
    return { type: "cancel" as const };
  }

  if (command === "edit") {
    return { type: "edit" as const, text: tail };
  }

  return { type: "unknown" as const, message: "Доступны команды: approve, edit <новый текст>, cancel." };
};

const ensureAuthorized = async (ctx: Context, instance: TeamInstanceConfig): Promise<boolean> => {
  const userId = ctx.from?.id;
  if (!userId) {
    return false;
  }

  if (isUserAuthorized(instance, userId)) {
    return true;
  }

  logger.warn("access.denied", {
    instanceId: instance.id,
    userId,
    chatId: ctx.chat?.id
  });
  await sendSafeReply(ctx, "У вас нет доступа к этому боту.");
  return false;
};

const isExplicitProjectHint = (text: string) => {
  const trimmed = text.trim();
  return /^\s*\[[^\]]+\]\s+/i.test(trimmed) || /^\s*(project|проект)\s*[:=]\s*([^\s]+)\s+/i.test(trimmed);
};

const composeEditedText = (
  instance: TeamInstanceConfig,
  pendingProjectKey: string,
  editedRawText: string
) => {
  const trimmedText = editedRawText.trim();
  const parsed = parseProjectFromText(trimmedText, instance);

  if (parsed.status === "resolved") {
    return `${parsed.project?.key} ${parsed.text || ""}`.trim();
  }

  if (parsed.status === "unknown" && isExplicitProjectHint(trimmedText)) {
    const suggestion =
      parsed.alternatives && parsed.alternatives.length > 0
        ? `Возможно, ты имел в виду: ${parsed.alternatives.map((p) => p.key).join(", ")}`
        : `Доступные проекты:\n${formatProjectList(instance)}`;

    throw new Error(`Не распознал проект ${parsed.hint || ""}. ${suggestion}`);
  }

  return `${pendingProjectKey} ${trimmedText}`.trim();
};

const createIssueWithLinear = async (
  instance: TeamInstanceConfig,
  payload: ComposedTask,
  projectId: string
) => {
  const created = await createLinearIssue(
    payload,
    projectId,
    instance.linearTeamId,
    instance.linearApiToken,
    process.env.LINEAR_API_URL
  );

  const project = mapProjectByKey(instance, payload.projectKey);
  if (!project) {
    throw new Error(`Проект ${payload.projectKey} не найден в конфиге инстанса ${instance.id}`);
  }

  return { created, project };
};

const resolveProject = async (
  state: AppState,
  instance: TeamInstanceConfig,
  chatId: number,
  text: string
): Promise<{ project: ParsedProjectResult; boundProject: ChatBinding | null }> => {
  const parsed = parseProjectFromText(text, instance);
  if (parsed.status === "resolved") {
    return { project: parsed, boundProject: null };
  }

  const codexProjectKey = await resolveProjectWithCodex(instance.projects, parsed.text || text, parsed.hint);
  if (codexProjectKey) {
    const codexProject = mapProjectByKey(instance, codexProjectKey);
    if (codexProject) {
      return {
        project: {
          status: "resolved",
          project: codexProject,
          text: parsed.text || text,
          hint: parsed.hint
        },
        boundProject: null
      };
    }
  }
  console.log("dkwdw");
  logger.info("dkwdw", {
    instanceId: instance.id,
    parsedStatus: parsed.status,
    hint: parsed.hint,
    textLength: text.length
  });

  const bound = await state.bindingStore.getProjectForChat(instance.id, chatId);
  if (bound && shouldAutoUseLastProject(instance)) {
    const boundProject = instance.projects.find((project) => project.id === bound.projectId);
    if (boundProject) {
      return {
        project: {
          status: "resolved",
          project: boundProject,
          text,
          hint: parsed.hint
        },
        boundProject: bound
      };
    }
  }

  if (shouldAutoUseDefaultProject(instance)) {
    const defaultProject = findDefaultProject(instance);
    if (defaultProject) {
      return {
        project: {
          status: "resolved",
          project: defaultProject,
          text,
          hint: parsed.hint
        },
        boundProject: null
      };
    }
  }

  return { project: parsed, boundProject: bound };
};

const resolveAndCreate = async (
  state: AppState,
  context: PendingContext,
  input: string,
  transcribeMeta?: TranscriptionResult
) => {
  logger.info("resolve_and_create:start", {
    correlationId: context.correlationId,
    instanceId: context.instanceId,
    chatId: context.chatId,
    userId: context.userId,
    sourceType: transcribeMeta ? "voice" : "text"
  });

  const resolution = await resolveProject(state, context.instance, context.chatId, input);

  if (resolution.project.status !== "resolved") {
    state.pendingStore.setProjectRequest(context.key, {
      instanceId: context.instanceId,
      chatId: context.chatId,
      userId: context.userId,
      originalText: input,
      sourceType: transcribeMeta ? "voice" : "text",
      createdAt: new Date().toISOString()
    });

    const suggestion =
      resolution.project.alternatives && resolution.project.alternatives.length > 0
        ? `Возможно, ты имел в виду: ${resolution.project.alternatives.map((p) => p.key).join(", ")}`
        : `Доступные проекты:\n${formatProjectList(context.instance)}`;

    if (resolution.project.status === "unknown") {
      throw new Error(`Не распознал проект ${resolution.project.hint || ""}. ${suggestion}`);
    }

    throw new Error(`Не указан проект. ${suggestion}`);
  }

  const project = resolution.project.project;
  if (!project) {
    throw new Error("Проект не найден в конфигурации инстанса");
  }

  const payload = await composeTaskPayload(
    project.key,
    resolution.project.text,
    project.key,
    `telegram:${context.chatId}`,
    transcribeMeta
  );

  if (!payload.title || !payload.description) {
    throw new Error("Сформированы некорректные данные задачи.");
  }

  if (payload.confidence < 0.65) {
    throw new PendingDraftAction("Нужен ручной ассент по низкой уверенности.", {
      ...payload,
      projectKey: project.key
    });
  }

  const result = await createIssueWithLinear(context.instance, payload, project.id);

  await state.bindingStore.setProjectForChat(context.instance.id, context.chatId, context.userId, project.id);

  return {
    issueUrl: result.created.issue.url,
    payload: { ...payload, projectKey: project.key },
    projectKey: project.key
  };
};

const finalizeApproval = async (ctx: Context, key: string, actionText: string) => {
  if (appState.inFlightApprovals.has(key)) {
    await sendSafeReply(ctx, "Запрос уже обрабатывается.");
    return;
  }

  appState.inFlightApprovals.add(key);
  try {
    const pending = appState.pendingStore.getApproval(key);
    if (!pending) {
      return;
    }

    const correlationIdValue = pending.correlationId || hashString(
      `${pending.instanceId}:${pending.chatId}:${pending.userId}:${pending.createdAt}`
    ).slice(0, 12);

    const action = parseApprovalCommand(actionText);
    if (!action) {
      return;
    }

    if (action.type === "approve") {
      const instance = appState.cfg.instances.find((i) => i.id === pending.instanceId);
      if (!instance) {
        throw new Error("Инстанс не найден");
      }

      const project = mapProjectByKey(instance, pending.payload.projectKey);
      if (!project) {
        throw new Error(`Проект ${pending.payload.projectKey} не найден в конфиге инстанса ${instance.id}`);
      }
      const issue = await createIssueWithLinear(instance, pending.payload, project.id);
      await appState.bindingStore.setProjectForChat(
        pending.instanceId,
        pending.chatId,
        pending.userId,
        project.id
      );
      appState.pendingStore.deleteApproval(key);
      logger.info("approval.approved", {
        correlationId: correlationIdValue,
        instanceId: pending.instanceId,
        chatId: pending.chatId,
        userId: pending.userId,
        issueUrl: issue.created.issue.url
      });
      await sendSafeReply(
        ctx,
        buildConfirmationMessage({ ...pending.payload, projectKey: issue.project.key }, issue.created.issue.url)
      );
      return;
    }

    if (action.type === "cancel") {
      appState.pendingStore.deleteApproval(key);
      logger.info("approval.canceled", {
        correlationId: correlationIdValue,
        instanceId: pending.instanceId,
        chatId: pending.chatId,
        userId: pending.userId
      });
      await sendSafeReply(ctx, "Ок, задача не создана.");
      return;
    }

    if (action.type === "edit") {
      const replacement = action.text.trim();
      if (!replacement) {
        await sendSafeReply(ctx, "После edit укажи новый текст задачи.");
        return;
      }

      const instance = appState.cfg.instances.find((i) => i.id === pending.instanceId);
      if (!instance) {
        await sendSafeReply(ctx, "Инстанс больше недоступен.");
        return;
      }

      appState.pendingStore.deleteApproval(key);
      const composedText = composeEditedText(instance, pending.payload.projectKey, replacement);
      const context: PendingContext = {
        key,
        instance,
        instanceId: instance.id,
        chatId: pending.chatId,
        userId: pending.userId,
        correlationId: correlationIdValue
      };
      await processIncomingText(ctx, context, composedText);
      return;
    }

    if (action.type === "empty") {
      await sendSafeReply(ctx, "Пустой ввод. Напиши approve, edit <новый текст> или cancel.");
      return;
    }

    await sendSafeReply(ctx, `Не понял команду. ${action.message}`);
  } catch (error) {
    logger.error("approval.failed", {
      message: error instanceof Error ? error.message : `${error}`
    });
    await sendSafeReply(ctx, "Ошибка обработки подтверждения.");
  } finally {
    appState.inFlightApprovals.delete(key);
  }
};

const processIncomingText = async (ctx: Context, context: PendingContext, inputText: string) => {
  try {
    const { issueUrl, payload } = await resolveAndCreate(appState, context, inputText);
    logger.info("text_processing.success", {
      correlationId: context.correlationId,
      instanceId: context.instanceId,
      chatId: context.chatId,
      issueUrl
    });
    await sendSafeReply(ctx, `Готово. Задача создана: ${issueUrl}`);
    await sendSafeReply(ctx, buildConfirmationMessage(payload));
  } catch (error) {
    if (error instanceof PendingDraftAction) {
      appState.pendingStore.setApproval(context.key, {
        correlationId: context.correlationId,
        instanceId: context.instanceId,
        chatId: context.chatId,
        userId: context.userId,
        payload: { ...error.payload },
        rawInputText: inputText,
        sourceType: "text",
        createdAt: new Date().toISOString()
      });

      await sendSafeReply(ctx, buildConfirmationMessage(error.payload));
      return;
    }

    if (error instanceof Error) {
      logger.error("text_processing.failed", {
        correlationId: context.correlationId,
        instanceId: context.instanceId,
        chatId: context.chatId,
        message: error.message
      });
      await sendSafeReply(ctx, error.message);
      return;
    }

    await sendSafeReply(ctx, "Не удалось обработать сообщение.");
  }
};

const handleTextMessage = async (ctx: Context, instance: TeamInstanceConfig) => {
  if (!ctx.chat || !ctx.from || !ctx.message || !("text" in ctx.message)) {
    return;
  }

  const message = ctx.message as { text: string; message_id?: number };
  const messageText = message.text.trim();
  const messageId = message.message_id || Date.now();
  const isDuplicate = markMessageSeen(instance.id, ctx.chat.id, messageId);
  const correlation = correlationId(instance.id, ctx.chat.id, ctx.from.id, messageId, messageText);
  if (isDuplicate) {
    logger.warn("duplicate_message_ignored", {
      correlationId: correlation,
      instanceId: instance.id,
      chatId: ctx.chat.id,
      sourceType: "text"
    });
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const key = stateKey(instance.id, chatId, userId);
  const context: PendingContext = {
    key,
    instance,
    instanceId: instance.id,
    chatId,
    userId,
    correlationId: correlation
  };

  logger.info("incoming_text_message", {
    correlationId: context.correlationId,
    instanceId: instance.id,
    chatId,
    userId
  });

  const approval = appState.pendingStore.getApproval(key);
  if (approval) {
    await finalizeApproval(ctx, key, messageText);
    return;
  }

  if (!messageText || messageText.startsWith("/")) {
    return;
  }

  const projectRequest = appState.pendingStore.getProjectRequest(key);
  if (projectRequest) {
    const resolved = parseProjectFromText(messageText, instance);
    if (resolved.status !== "resolved") {
      appState.pendingStore.setProjectRequest(key, projectRequest);
      await sendSafeReply(ctx, "Сначала укажи проект в формате [PROJECT] Текст задачи.");
      return;
    }

    appState.pendingStore.deleteProjectRequest(key);
    const recomposed = `${resolved.project?.key} ${resolved.text}`;
    await processIncomingText(ctx, context, recomposed);
    return;
  }

  try {
    await resolveAndCreate(appState, context, messageText);
    await sendSafeReply(ctx, `Задача создана через проектный routing.`);
  } catch (error) {
    if (error instanceof PendingDraftAction) {
      appState.pendingStore.setApproval(context.key, {
        correlationId: context.correlationId,
        instanceId: context.instanceId,
        chatId: context.chatId,
        userId: context.userId,
        payload: error.payload,
        rawInputText: messageText,
        sourceType: "text",
        createdAt: new Date().toISOString()
      });
      await sendSafeReply(ctx, buildConfirmationMessage(error.payload));
      return;
    }

    if (error instanceof Error) {
      logger.error("text_processing.failed", {
        correlationId: context.correlationId,
        instanceId: context.instanceId,
        chatId: context.chatId,
        message: error.message
      });
      await sendSafeReply(ctx, error.message);
      return;
    }

    await sendSafeReply(ctx, "Ошибка при обработке сообщения.");
  }
};

const handleVoiceMessage = async (ctx: Context, instance: TeamInstanceConfig) => {
  if (!ctx.chat || !ctx.from || !ctx.message || !(("voice" in ctx.message) || ("audio" in ctx.message))) {
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const key = stateKey(instance.id, chatId, userId);
  const message = ctx.message as { caption?: string; voice?: { file_id: string }; audio?: { file_id: string }; message_id?: number };
  const messageId = message.message_id || Date.now();
  const isDuplicate = markMessageSeen(instance.id, chatId, messageId);
  const caption = (typeof message.caption === "string" ? message.caption : "").trim();
  const correlation = correlationId(instance.id, chatId, userId, messageId, caption || "voice");
  if (isDuplicate) {
    logger.warn("duplicate_message_ignored", {
      correlationId: correlation,
      instanceId: instance.id,
      chatId,
      sourceType: "voice"
    });
    return;
  }

  const mediaFileId = message.voice?.file_id || message.audio?.file_id;
  if (!mediaFileId) {
    await sendSafeReply(ctx, "Не могу обработать вложение без file_id.");
    return;
  }

  const context: PendingContext = {
    key,
    instance,
    instanceId: instance.id,
    chatId,
    userId,
    correlationId: correlation
  };

  logger.info("incoming_voice_message", {
    correlationId: context.correlationId,
    instanceId: instance.id,
    chatId,
    userId,
    sourceType: "voice"
  });

  const approval = appState.pendingStore.getApproval(key);
  if (approval) {
    if (caption) {
      await finalizeApproval(ctx, key, caption);
      return;
    }

    await sendSafeReply(ctx, "Для подтверждения задачи пришли текстом: approve, edit <новый текст> или cancel.");
    return;
  }

  if (!ctx.telegram) {
    await sendSafeReply(ctx, "Не удалось получить telegram-клиент.");
    return;
  }

  const stored = appState.pendingStore.getProjectRequest(key);
  const routeSource = caption || stored?.originalText || "";
  if (!routeSource) {
    await sendSafeReply(ctx, "Сначала укажи проект в тексте: [PROJECT] описание задачи, затем приложи голос.");
    return;
  }

  const resolution = parseProjectFromText(routeSource, instance);
  if (resolution.status !== "resolved") {
    if (!stored) {
      appState.pendingStore.setProjectRequest(key, {
        instanceId: instance.id,
        chatId,
        userId,
        originalText: routeSource,
        sourceType: "voice",
        createdAt: new Date().toISOString()
      });
    }
    const suggestion =
      resolution.alternatives && resolution.alternatives.length > 0
        ? `Возможно: ${resolution.alternatives.map((p) => p.key).join(", ")}`
        : `Доступные проекты:\n${formatProjectList(instance)}`;
    await sendSafeReply(ctx, `Не определен проект в голосовом сообщении. ${suggestion}`);
    return;
  }

  if (!resolution.project?.key) {
    await sendSafeReply(ctx, "Проект не найден для голосового сообщения.");
    return;
  }

  const project = resolution.project;
  const projectPrefix = `${project.key} ${resolution.text || ""}`.trim();

  await sendSafeReply(ctx, `Распознаю голос для проекта ${project.key}...`);

  const file = await ctx.telegram.getFile(mediaFileId);
  const fileUrl = await ctx.telegram.getFileLink(file.file_id);

  await appState.queue.enqueue(context.correlationId, async () => {
    logger.info("voice_transcription_task:started", {
      correlationId: context.correlationId,
      instanceId: instance.id,
      chatId
    });

    const transcript = await transcribeAudioFile(fileUrl.toString());
    const combinedText =
      projectPrefix.length > project.key.length
        ? `${projectPrefix}\n${transcript.text}`
        : `${project.key} ${transcript.text}`;

    await processIncomingVoiceText(ctx, context, combinedText.trim(), transcript);
  });
};

const processIncomingVoiceText = async (
  ctx: Context,
  context: PendingContext,
  combinedText: string,
  transcript: TranscriptionResult
) => {
  try {
    const { issueUrl, payload } = await resolveAndCreate(appState, context, combinedText, transcript);
    await sendSafeReply(ctx, `Готово. Задача создана: ${issueUrl}`);
    await sendSafeReply(ctx, buildConfirmationMessage(payload));
  } catch (error) {
    if (error instanceof PendingDraftAction) {
      appState.pendingStore.setApproval(context.key, {
        correlationId: context.correlationId,
        instanceId: context.instanceId,
        chatId: context.chatId,
        userId: context.userId,
        payload: error.payload,
        rawInputText: combinedText,
        sourceType: "voice",
        createdAt: new Date().toISOString()
      });
      await sendSafeReply(ctx, buildConfirmationMessage(error.payload));
      return;
    }

    if (error instanceof Error) {
      await sendSafeReply(ctx, error.message);
      return;
    }

    await sendSafeReply(ctx, "Не удалось обработать голосовое сообщение.");
  }
};

const bootInstance = async (instance: TeamInstanceConfig) => {
  const bot = new Telegraf(instance.telegramToken);

  bot.use(async (ctx, next) => {
    if (await ensureAuthorized(ctx, instance)) {
      return next();
    }
  });

  bot.start(async (ctx) => {
    await sendSafeReply(
      ctx,
      `Привет! Я создаю задачи в Linear для команды ${instance.name}.\n` +
        `Пример: [WEB] Починить главный экран\nДополнительно: project:OPS Перенос в прод\n\nДоступные проекты:\n${formatProjectList(instance)}`
    );
  });

  bot.help(async (ctx) => {
    await sendSafeReply(ctx, "Если проект не указан явно, буду использовать последний для этого чата. Формат: [PROJECT] Текст задачи");
  });

  bot.command("projects", async (ctx) => {
    await sendSafeReply(ctx, `Проекты команды:\n${formatProjectList(instance)}`);
  });

  bot.command("status", async (ctx) => {
    await sendSafeReply(ctx, "Сервис работает. Используй текст с проектным префиксом.");
  });

  bot.on("text", async (ctx) => {
    await handleTextMessage(ctx, instance);
  });

  bot.on("voice", async (ctx) => {
    await handleVoiceMessage(ctx, instance);
  });

  bot.on("audio", async (ctx) => {
    await handleVoiceMessage(ctx, instance);
  });

  await bot.launch({
    dropPendingUpdates: asBool(env("TELEGRAM_DROP_PENDING_UPDATES", "true"), true)
  });

  logger.info("bot started", { instanceId: instance.id, name: instance.name });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("TERM"));
};

const bootstrap = async () => {
  appState.cfg = await loadConfig();
  await appState.bindingStore.load();
  await appState.pendingStore.load();
  await Promise.all(appState.cfg.instances.map((instance) => bootInstance(instance)));
  logger.info("all bots started", { instances: appState.cfg.instances.length });
};

bootstrap().catch((error) => {
  logger.error("bootstrap failed", {
    error: error instanceof Error ? error.message : `${error}`
  });
  process.exit(1);
});
