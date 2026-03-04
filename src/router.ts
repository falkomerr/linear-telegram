import { ParsedProjectResult, TeamInstanceConfig } from "./models.js";
import { toLowerTrim } from "./utils.js";

export const parseProjectFromText = (text: string, instance: TeamInstanceConfig): ParsedProjectResult => {
  const trimmed = text.trim();

  if (!trimmed) {
    return { status: "needs_hint", text: "", hint: undefined };
  }

  const bracketMatch = /^\s*\[(.+?)\]\s+([\s\S]+)/.exec(trimmed);
  if (bracketMatch) {
    const hint = bracketMatch[1].trim();
    const body = bracketMatch[2].trim();
    return resolveByHint(hint, body, instance);
  }

  const tagMatch = /^\s*(project|проект)\s*[:=]\s*([^\s]+)\s+([\s\S]+)/i.exec(trimmed);
  if (tagMatch) {
    const hint = tagMatch[2].trim();
    const body = tagMatch[3].trim();
    return resolveByHint(hint, body, instance);
  }

  const tokenMatch = /^([^\s]+)\s+([\s\S]+)/.exec(trimmed);
  if (!tokenMatch) {
    return { status: "needs_hint", text: trimmed };
  }

  const hint = tokenMatch[1].trim();
  const body = tokenMatch[2].trim();

  const candidate = resolveByHint(hint, body, instance);
  return candidate;
};

const resolveByHint = (
  hintRaw: string,
  text: string,
  instance: TeamInstanceConfig
): ParsedProjectResult => {
  const alias = toLowerTrim(hintRaw);
  const byAlias = findProjectByAlias(alias, instance);

  if (byAlias) {
    return {
      status: "resolved",
      project: byAlias,
      text,
      hint: hintRaw
    };
  }

  if (text.length === 0) {
    return {
      status: "needs_hint",
      text,
      hint: hintRaw,
      alternatives: suggestProjects(alias, instance)
    };
  }

  return {
    status: "unknown",
    text: `${hintRaw} ${text}`,
    hint: hintRaw,
    alternatives: suggestProjects(alias, instance)
  };
};

const normalizeAliasList = (projectKey: string, alias: string[]): string[] => {
  return [projectKey, ...alias]
    .filter(Boolean)
    .map((value) => toLowerTrim(value));
};

const findProjectByAlias = (alias: string, instance: TeamInstanceConfig) => {
  const normalized = toLowerTrim(alias);
  return instance.projects.find((project) =>
    normalizeAliasList(project.key, project.aliases).includes(normalized)
  );
};

const suggestProjects = (hint: string, instance: TeamInstanceConfig) => {
  const normalized = toLowerTrim(hint);
  const exact = instance.projects.filter((project) =>
    normalizeAliasList(project.key, project.aliases).some((alias) => alias.includes(normalized))
  );

  if (exact.length > 0) {
    return exact;
  }

  if (!normalized) {
    return instance.projects;
  }

  return instance.projects.slice(0, 0);
};
