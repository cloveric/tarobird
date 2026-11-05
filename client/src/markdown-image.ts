/** Message text cannot resolve relative paths against the App's privileged
 * origin. External images become explicit links, never automatic requests. */
export function markdownImageUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}
