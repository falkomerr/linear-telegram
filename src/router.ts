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

  const inline = findProjectInText(trimmed, instance);
  if (inline) {
    return inline;
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

const normalizeToken = (value: string) => {
  return value
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\wа-яА-ЯёЁ0-9_-]+/gu, "")
    .toLowerCase();
};

const stripByIndexes = (text: string, indexes: number[]) => {
  const words = text.split(/\s+/).filter(Boolean);
  const skip = new Set(indexes);
  return words.filter((_, index) => !skip.has(index)).join(" ").trim();
};

const findProjectInText = (text: string, instance: TeamInstanceConfig): ParsedProjectResult | null => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return null;
  }

  for (let i = 0; i < words.length; i++) {
    const token = normalizeToken(words[i]);
    if (!token) {
      continue;
    }

    const byToken = findProjectByAlias(token, instance);
    if (byToken) {
      return {
        status: "resolved",
        project: byToken,
        text: stripByIndexes(text, [i]),
        hint: words[i]
      };
    }
  }

  const markers = ["в", "для", "project", "проект", "по", "на"];
  for (let i = 0; i < words.length - 1; i++) {
    const marker = normalizeToken(words[i]);
    const token = normalizeToken(words[i + 1]);
    if (!marker || !token) {
      continue;
    }
    if (!markers.includes(marker)) {
      continue;
    }

    const byToken = findProjectByAlias(token, instance);
    if (byToken) {
      return {
        status: "resolved",
        project: byToken,
        text: stripByIndexes(text, [i, i + 1]),
        hint: words[i + 1]
      };
    }
  }

  return null;
};

const isMostlyCyrillic = (value: string) => /[а-яё]/ui.test(value);
const isMostlyLatin = (value: string) => /[a-z]/i.test(value);

const levenshteinDistance = (left: string, right: string) => {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();

  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = matrix[i - 1][j] + 1;
      const insertion = matrix[i][j - 1] + 1;
      const substitution = matrix[i - 1][j - 1] + cost;
      matrix[i][j] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[a.length][b.length];
};

const isAliasMatch = (candidateAlias: string, knownAlias: string) => {
  if (!candidateAlias || !knownAlias) {
    return false;
  }

  if (candidateAlias === knownAlias) {
    return true;
  }
  if (candidateAlias.includes(knownAlias) || knownAlias.includes(candidateAlias)) {
    return true;
  }

  const candidateLatin = transliterate(candidateAlias);
  const knownLatin = transliterate(knownAlias);

  if (isMostlyCyrillic(candidateAlias) || isMostlyCyrillic(knownAlias)) {
    if (candidateLatin.length > 3 && knownLatin.length > 3 && Math.abs(candidateLatin.length - knownLatin.length) <= 1) {
      return levenshteinDistance(candidateLatin, knownLatin) <= 1;
    }
  }

  return false;
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
const reverseTransliterationPairs: Array<[string, string]> = [
  ["shch", "щ"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ts", "ц"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["ya", "я"],
  ["yu", "ю"],
  ["yo", "ё"],
  ["ye", "е"],
  ["a", "а"],
  ["b", "б"],
  ["v", "в"],
  ["g", "г"],
  ["d", "д"],
  ["e", "е"],
  ["z", "з"],
  ["i", "и"],
  ["y", "й"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["f", "ф"],
  ["h", "х"],
  ["c", "ц"],
  ["j", "й"],
  ["q", "к"],
  ["w", "в"],
  ["x", "кс"]
];
const reversePairsSorted = [...reverseTransliterationPairs].sort((a, b) => b[0].length - a[0].length);
const transliterate = (value: string) => {
  return value
    .toLowerCase()
    .split("")
    .map((char) => transliterationMap[char] ?? char)
    .join("");
};
const reverseTransliterate = (value: string) => {
  const direct = toLowerTrim(value);
  if (!/^[a-z0-9]+$/.test(direct)) {
    return "";
  }

  let result = "";
  for (let i = 0; i < direct.length;) {
    const chunk = reversePairsSorted.find((entry) => {
      const [latin] = entry;
      return direct.startsWith(latin, i);
    });
    if (chunk) {
      const [latin, cyrillic] = chunk;
      result += cyrillic;
      i += latin.length;
      continue;
    }
    result += direct[i];
    i += 1;
  }
  return result;
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
  const reversed = reverseTransliterate(direct);
  if (reversed) {
    distinct.add(reversed);
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
      variants.some((candidate) => isAliasMatch(candidate, knownAlias))
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
