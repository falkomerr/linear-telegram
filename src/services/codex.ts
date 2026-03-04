import {
  ComposedTask,
  composedTaskSchema,
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
      model: process.env.CODEX_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: CODER_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: `${CODER_SYSTEM_PROMPT}\n\nprojectKey: ${projectKey}\nuser: ${user}\nprojectHint: ${projectHint}\ntext:\n${text}`
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
