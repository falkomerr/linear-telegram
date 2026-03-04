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
    if (instance.projects.length === 1) {
      return {
        status: "resolved",
        project: instance.projects[0],
        text: trimmed,
        hint: undefined
      };
    }

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

  if (instance.projects.length === 1) {
    return {
      status: "resolved",
      project: instance.projects[0],
      text: `${hintRaw} ${text}`.trim(),
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

const transliterationMap: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya"
};
const transliterate = (value: string) => {
  return value
    .toLowerCase()
    .split("")
    .map((char) => transliterationMap[char] ?? char)
    .join("");
};
const normalizeAliasPart = (value: string) => {
  return toLowerTrim(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s\-_:.]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
};
const aliasVariants = (value: string) => {
  const direct = normalizeAliasPart(value);
  if (!direct) {
    return [];
  }

  const translit = transliterate(direct);
  const distinct = new Set([direct, translit]);
  const spaced = toLowerTrim(value).replace(/[\s\-_:.]/g, "");
  if (spaced) {
    distinct.add(toLowerTrim(spaced));
    distinct.add(transliterate(spaced));
  }

  return Array.from(distinct).filter(Boolean);
};

const normalizeAliasList = (projectKey: string, alias: string[]): string[] => {
  return [projectKey, ...alias]
    .filter(Boolean)
    .flatMap((value) => aliasVariants(value));
};

const findProjectByAlias = (alias: string, instance: TeamInstanceConfig) => {
  const normalized = toLowerTrim(alias);
  const variants = aliasVariants(normalized);
  return instance.projects.find((project) => {
    const aliases = normalizeAliasList(project.key, project.aliases);
    return aliases.some((knownAlias) =>
      variants.some((candidate) => knownAlias === candidate || knownAlias.includes(candidate) || candidate.includes(knownAlias))
    );
  });
};

const suggestProjects = (hint: string, instance: TeamInstanceConfig) => {
  const normalized = toLowerTrim(hint);
  const hintVariants = aliasVariants(normalized);
  const exact = instance.projects.filter((project) =>
    normalizeAliasList(project.key, project.aliases).some((alias) =>
      hintVariants.some((hintAlias) => alias.includes(hintAlias) || hintAlias.includes(alias))
    )
  );

  if (exact.length > 0) {
    return exact;
  }

  if (!normalized) {
    return instance.projects;
  }

  return instance.projects.slice(0, 0);
};
