import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TranscriptionResult } from "../models.js";
import { asBool, env } from "../utils.js";

const downloadFile = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download voice file: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const outputDir = path.resolve(process.cwd(), "./data/tmp");
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${crypto.randomUUID()}.ogg`);
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));
  return filePath;
};

const transcribeWithOpenAI = async (
  audioPath: string,
  language?: string
): Promise<TranscriptionResult> => {
  const apiKey = env("OPENAI_API_KEY", "");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for whisper transcription.");
  }

  const model = env("WHISPER_MODEL", "whisper-1");
  const base = env("OPENAI_API_BASE", "https://api.openai.com/v1");

  const audioBuffer = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("model", model);
  if (language) {
    form.append("language", language);
  }
  const file = new File([audioBuffer], path.basename(audioPath), { type: "audio/ogg" });
  form.append("file", file);

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${txt}`);
  }

  const data = (await response.json()) as { text?: string; language?: string };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) {
    throw new Error("Whisper returned empty transcript");
  }

  return {
    text,
    language: data.language
  };
};

export const transcribeAudioFile = async (fileUrl: string, languageHint?: string): Promise<TranscriptionResult> => {
  const provider = env("WHISPER_PROVIDER", "openai");
  const filePath = await downloadFile(fileUrl);
  try {
    if (provider === "none") {
      throw new Error("WHISPER_PROVIDER=none is configured");
    }

    return await transcribeWithOpenAI(filePath, languageHint);
  } finally {
    await fs.unlink(filePath).catch(() => {
      if (asBool(env("DEBUG_TRANSCRIBE_ERROR_LOG"), false)) {
        console.warn("Cannot remove temp audio file", { path: filePath });
      }
    });
  }
};
