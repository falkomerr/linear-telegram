import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppConfig, TeamInstanceConfig, routePolicySchema } from "./models.js";
import { env } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const normalizeInstance = (raw: Record<string, unknown>): TeamInstanceConfig => {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid instance config format");
  }

  const routePolicyRaw =
    typeof raw.routePolicy === "string" && routePolicyRawRawAllowed(raw.routePolicy)
      ? raw.routePolicy
      : "explicit-only";

  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    telegramToken: String(raw.telegramToken ?? ""),
    linearApiToken: String(raw.linearApiToken ?? ""),
    linearTeamId: String(raw.linearTeamId ?? ""),
    defaultProjectId: raw.defaultProjectId ? String(raw.defaultProjectId) : undefined,
    routePolicy: routePolicyRaw,
    projects: Array.isArray(raw.projects)
      ? raw.projects
          .map((p) => {
            const project = p as Record<string, unknown>;
            return {
              id: String(project.id ?? ""),
              key: String(project.key ?? ""),
              name: String(project.name ?? ""),
              aliases: Array.isArray(project.aliases)
                ? (project.aliases as unknown[]).map((v) => String(v).trim()).filter(Boolean)
                : []
            };
          })
          .filter((p) => p.id && p.key)
      : []
  };
};

const routePolicyRawRawAllowed = (value: string): value is "explicit-only" | "explicit-or-last" => {
  return routePolicySchema.safeParse(value).success;
};

export async function loadConfig(): Promise<AppConfig> {
  const configPath = env("CONFIG_PATH", path.join(__dirname, "..", "..", "config", "instances.json"));
  const inlineJson = env("INSTANCES_JSON", "");

  if (inlineJson) {
    const parsed = JSON.parse(inlineJson);
    return validateAppConfig(parsed);
  }

  try {
    const resolvedPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(process.cwd(), configPath);

    const raw = await fs.readFile(resolvedPath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateAppConfig(parsed);
  } catch (error: unknown) {
    return fallbackFromEnv();
  }
}

const validateAppConfig = (parsed: unknown): AppConfig => {
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { instances?: unknown }).instances)) {
    throw new Error("Invalid config: expected { instances: [...] }");
  }

  const instances = (parsed as { instances: Array<Record<string, unknown>> }).instances.map((instance) =>
    normalizeInstance(instance)
  ).filter((i) => i.id && i.telegramToken && i.linearApiToken && i.linearTeamId);

  if (instances.length === 0) {
    throw new Error("No valid instances configured");
  }

  return { instances };
};

const fallbackFromEnv = (): AppConfig => {
  const telegramToken = env("TELEGRAM_BOT_TOKEN", "");
  const linearApiToken = env("LINEAR_API_TOKEN", "");
  const linearTeamId = env("LINEAR_TEAM_ID", "");
  const projectId = env("LINEAR_PROJECT_ID", "");
  const projectKey = env("LINEAR_PROJECT_KEY", "MAIN");
  const projectName = env("LINEAR_PROJECT_NAME", "Main");

  if (!telegramToken || !linearApiToken || !linearTeamId) {
    throw new Error(
      "No config file and fallback env vars are not configured. Set CONFIG_PATH or all of TELEGRAM_BOT_TOKEN, LINEAR_API_TOKEN, LINEAR_TEAM_ID."
    );
  }

  const instance: TeamInstanceConfig = {
    id: "default",
    name: "default",
    telegramToken,
    linearApiToken,
    linearTeamId,
    routePolicy: "explicit-or-last",
    defaultProjectId: projectId || undefined,
    projects: projectId
      ? [
          {
            id: projectId,
            key: projectKey,
            name: projectName,
            aliases: [projectKey.toLowerCase(), projectName.toLowerCase()]
          }
        ]
      : []
  };

  return { instances: [instance] };
};
