import crypto from "node:crypto";

export const env = (key: string, fallback = "") => process.env[key]?.trim() ?? fallback;

export const toLowerTrim = (value: string) => value.trim().toLowerCase();

export const asBool = (value: string | undefined, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on", "y"].includes(value.toLowerCase());
};

export function hashString(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
