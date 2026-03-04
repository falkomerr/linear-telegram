import {
  ComposedTask,
  composedTaskSchema,
  TeamInstanceConfig,
  TranscriptionResult
} from "../models.js";
import { env } from "../utils.js";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

const CODER_SYSTEM_PROMPT = `Ты системный конструктор задач.
На вход получаешь текст задачи пользователя в чате и служебный контекст.
Нужно вернуть строго JSON по схеме:
{
  "projectKey": "ключ проекта",
  "title": "краткое название задачи",
  "description": "техническое описание",
  "priority": 0..4,
  "labels": ["string"],
  "dueDate": "YYYY-MM-DD или пусто",
  "assignee": "id в Linear (или пусто)",
  "estimate": 0,
  "state": "название статуса или пусто",
  "confidence": 0..1,
  "rawInput": "исходный текст"
}
Не добавляй комментарии и не выходи за JSON. Используй русский язык для description/title.
priority=0 самая высокая важность.
`;
const PROJECT_RESOLVER_PROMPT = `Ты - маршрутизатор проектов.
На вход получаешь текст заявки и список доступных проектов.
Игнорируй регистр, учитывай алиасы и написания похожими по смыслу (в том числе кириллица/латиница).
Нужно вернуть строго JSON:
{"projectKey":"ключ проекта","reason":"краткое пояснение"}.
Если проект однозначно определить нельзя, верни {"projectKey":""}.
`;

type CodexRequest = {
  schema: string;
  prompt: string;
};

const CODEX_CLI_PROJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectKey: { type: "string" },
    reason: { type: "string" }
  },
  required: ["projectKey", "reason"]
};

const CODEX_CLI_TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectKey: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    priority: { type: "number" },
    labels: { type: "array", items: { type: "string" } },
    dueDate: { type: "string" },
    assignee: { type: "string" },
    estimate: { type: "number" },
    state: { type: "string" },
    confidence: { type: "number" },
    rawInput: { type: "string" }
  },
  required: [
    "projectKey",
    "title",
    "description",
    "priority",
    "labels",
    "dueDate",
    "assignee",
    "estimate",
    "state",
    "confidence",
    "rawInput"
  ]
};

const shouldUseCodexCli = (): boolean => {
  const value = env("CODEX_USE_CLI", "").toLowerCase().trim();
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }

  return false;
};

const runCodexCli = async (request: CodexRequest): Promise<string | null> => {
  if (!shouldUseCodexCli()) {
    return null;
  }

  const command = env("CODEX_CLI_PATH", "codex").trim() || "codex";
  const timeoutMs = Number(env("CODEX_CLI_TIMEOUT_MS", "60000"));

  const tmpPath = await mkdtemp(join(tmpdir(), "codex-cli-"));
  const schemaPath = join(tmpPath, "schema.json");
  const outputPath = join(tmpPath, "last-message.json");

  try {
    await writeFile(schemaPath, request.schema, "utf8");

    await execFileAsync(
      command,
      [
        "exec",
        "--json",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        request.prompt
      ],
      {
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000,
        maxBuffer: 1024 * 1024
      }
    );

    const raw = await readFile(outputPath, "utf8");
    const candidate = raw.trim();
    if (!candidate) {
      return null;
    }

    return candidate;
  } catch {
    return null;
  } finally {
    await rm(tmpPath, { recursive: true, force: true });
  }
};

const callCodex = async (
  request: CodexRequest,
  apiRequestBuilder: () => Promise<string | null>
) => {
  if (shouldUseCodexCli()) {
    const cliResult = await runCodexCli(request);
    if (cliResult) {
      return cliResult;
    }
  }

  return apiRequestBuilder();
};

const getCodexModel = () => process.env.CODEX_MODEL?.trim() || "gpt-5.3-codex-spark";
const resolveCodexSettings = () => {
  const codeXUrl = env("CODEX_API_URL");
  const codeXKey = env("CODEX_API_KEY");
  const openAiBase = env("OPENAI_API_BASE", "https://api.openai.com/v1");
  const openAiKey = env("OPENAI_API_KEY");

  const normalizedOpenAiBase = openAiBase.endsWith("/") ? openAiBase.slice(0, -1) : openAiBase;
  const url = codeXUrl || `${normalizedOpenAiBase}/chat/completions`;
  const key = codeXKey || openAiKey;

  if (!url || !key) {
    return null;
  }

  return { url, key };
};

const extractJson = (value: string): string => {
  const codeBlockMatch = /```json([\s\S]*?)```/i.exec(value);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return value.slice(firstBrace, lastBrace + 1);
  }
  return value.trim();
};

const requestText = (projectKey: string, projectHint: string, text: string, user = "telegram") => {
  return `${CODER_SYSTEM_PROMPT}\n\nprojectKey: ${projectKey}\nuser: ${user}\nprojectHint: ${projectHint}\ntext:\n${text}`;
};
const requestProjectResolver = (text: string, hint: string | undefined, projects: TeamInstanceConfig["projects"]) => {
  const payload = {
    text,
    hint,
    projects: projects.map((project) => ({
      key: project.key,
      name: project.name,
      aliases: project.aliases ?? []
    }))
  };
  return `${PROJECT_RESOLVER_PROMPT}\n\navailableProjects:\n${JSON.stringify(payload, null, 2)}`;
};
const normalizeAlias = (value: string) => value.trim().toLowerCase();
export const resolveProjectWithCodex = async (
  instanceProjects: TeamInstanceConfig["projects"],
  rawText: string,
  projectHint: string | undefined
): Promise<string | null> => {
  if (!Array.isArray(instanceProjects) || instanceProjects.length === 0) {
    return null;
  }

  const jsonText = await callCodex(
    {
      schema: JSON.stringify(CODEX_CLI_PROJECT_SCHEMA),
      prompt: `${PROJECT_RESOLVER_PROMPT}\n\n${requestProjectResolver(rawText, projectHint, instanceProjects)}`
    },
    async () => {
      const settings = resolveCodexSettings();
      if (!settings) {
        return null;
      }

      const { url, key } = settings;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: getCodexModel(),
          messages: [
            {
              role: "system",
              content: PROJECT_RESOLVER_PROMPT
            },
            {
              role: "user",
              content: requestProjectResolver(rawText, projectHint, instanceProjects)
            }
          ],
          temperature: 0.0
        })
      });

      if (!response.ok) {
        return null;
      }

      const raw = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: unknown };
      let extracted = "";
      const choice = raw.choices?.[0]?.message?.content;
      if (typeof choice === "string") {
        extracted = extractJson(choice);
      } else if (typeof raw.content === "string") {
        extracted = extractJson(raw.content);
      }

      return extracted || null;
    }
  );

  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    const key = typeof parsed?.projectKey === "string" ? normalizeAlias(parsed.projectKey) : "";
    if (!key) {
      return null;
    }

    const knownKeys = new Set(instanceProjects.map((project) => normalizeAlias(project.key)));
    if (!knownKeys.has(key)) {
      return null;
    }
    return key;
  } catch {
    return null;
  }
};

export const composeTaskPayload = async (
  projectKey: string,
  text: string,
  projectHint: string,
  user: string,
  transcribeMeta?: TranscriptionResult
): Promise<ComposedTask> => {
  const payload = {
    projectKey,
    text,
    projectHint,
    transcribeMeta,
    user
  };

  const jsonText = await callCodex(
    {
      schema: JSON.stringify(CODEX_CLI_TASK_SCHEMA),
      prompt: `${CODER_SYSTEM_PROMPT}\n\nprojectKey: ${projectKey}\nuser: ${user}\nprojectHint: ${projectHint}\ntext:\n${text}`
    },
    async () => {
      const settings = resolveCodexSettings();
      if (!settings) {
        throw new Error(
          "LLM credentials are not configured. Set CODEX_API_URL/CODEX_API_KEY or OPENAI_API_BASE/OPENAI_API_KEY."
        );
      }
      const { url, key } = settings;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: getCodexModel(),
          messages: [
            {
              role: "system",
              content: CODER_SYSTEM_PROMPT
            },
            {
              role: "user",
              content: requestText(projectKey, projectHint, text, user)
            }
          ],
          temperature: 0.2
        })
      });

      if (!response.ok) {
        throw new Error(`Compose task request failed: ${response.status}`);
      }

      const raw = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: unknown };
      let extracted = "";
      const choice = raw.choices?.[0]?.message?.content;
      if (typeof choice === "string") {
        extracted = extractJson(choice);
      } else if (typeof raw.content === "string") {
        extracted = extractJson(raw.content);
      }

      if (!extracted) {
        throw new Error(`Could not extract JSON from LLM response for request: ${JSON.stringify(payload)}`);
      }

      return extracted;
    }
  );

  if (!jsonText) {
    throw new Error("LLM did not return JSON payload.");
  }

  try {
    const parsed = composedTaskSchema.parse(JSON.parse(jsonText));
    return {
      ...parsed,
      projectKey,
      rawInput: text
    };
  } catch {
    throw new Error("Could not parse LLM task payload");
  }
};
