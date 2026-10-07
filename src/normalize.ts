const INVALID = new Set(["", "null", "undefined", "none", "nan"]);

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim().toLowerCase();
  if (s.startsWith("@")) s = s.slice(1).trim();
  if (!s || INVALID.has(s) || s.includes("__deleted__")) return null;
  if (s.length > 80) return null;
  if (!/^[a-z0-9._-]+$/i.test(s)) return null;
  return s;
}

export function usernameFromEntry(entry: any): string | null {
  if (!entry || typeof entry !== "object") return null;
  const title = normalizeUsername(entry.title);
  if (title) return title;
  const list = entry.string_list_data;
  if (Array.isArray(list)) {
    for (const item of list) {
      const value = normalizeUsername(item?.value);
      if (value) return value;
    }
  }
  return null;
}

export function uniqueNormalized(values: unknown[]): string[] {
  return [...new Set(values.map(normalizeUsername).filter((x): x is string => Boolean(x)))].sort();
}
