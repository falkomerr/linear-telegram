import {
  ComposedTask,
  composedTaskSchema,
  TeamInstanceConfig,
  TranscriptionResult
} from "../models.js";

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

const toJsonFallback = (input: string, projectKey: string): ComposedTask => {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines[0] ?? input.slice(0, 80);
  const description = lines.slice(1).join("\n").trim() || input;

  return {
    projectKey,
    title: title.slice(0, 120),
    description,
    priority: 2,
    labels: [],
    confidence: 0.2,
    rawInput: input
  };
};
const getCodexModel = () => process.env.CODEX_MODEL?.trim() || "gpt-5.3-codex-spark";

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

  if (instanceProjects.length === 1) {
    return instanceProjects[0]?.key ?? null;
  }

  const codexUrl = process.env.CODEX_API_URL?.trim();
  const codexKey = process.env.CODEX_API_KEY?.trim();
  if (!codexUrl || !codexKey) {
    return null;
  }

  const response = await fetch(codexUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${codexKey}`,
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
  let jsonText = "";
  const choice = raw.choices?.[0]?.message?.content;
  if (typeof choice === "string") {
    jsonText = extractJson(choice);
  } else if (typeof raw.content === "string") {
    jsonText = extractJson(raw.content);
  }

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
  const codexUrl = process.env.CODEX_API_URL?.trim();
  const codexKey = process.env.CODEX_API_KEY?.trim();

  const payload = {
    projectKey,
    text,
    projectHint,
    transcribeMeta,
    user
  };

  if (!codexUrl || !codexKey) {
    return toJsonFallback(text, projectKey);
  }

  const response = await fetch(codexUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${codexKey}`,
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
    return toJsonFallback(text, projectKey);
  }

  const raw = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: unknown };
  let jsonText = "";
  const choice = raw.choices?.[0]?.message?.content;
  if (typeof choice === "string") {
    jsonText = extractJson(choice);
  } else if (typeof raw.content === "string") {
    jsonText = extractJson(raw.content);
  }

  if (!jsonText) {
    return toJsonFallback(text, projectKey);
  }

  try {
    const parsed = composedTaskSchema.parse(JSON.parse(jsonText));
    return {
      ...parsed,
      projectKey,
      rawInput: text
    };
  } catch {
    return toJsonFallback(text, projectKey);
  }
};
