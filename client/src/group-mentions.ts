/** Resolve visible member names and IDs without interpreting code or emails as
 * recipients. Ambiguous/unknown mentions stay explicit so parallel mode cannot
 * silently turn a directed request into a broadcast. */
export function groupMentions(text: string, members: { id: string; names: string[] }[]): { ids: string[]; unresolved: string[]; ambiguous?: string[] } {
  // A pasted/open fence remains code through EOF. A shorter fence inside a
  // longer one is content, and a closing fence cannot carry an info string.
  // Keep this scan linear: recipient discovery runs while the user types.
  let fence: { character: string; length: number } | undefined;
  const prose = text.split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return "";
    }
    if (marker && (marker[1]![0] !== '`' || !marker[2]!.includes('`'))) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }; return "";
    }
    return line;
  }).join('\n').replace(/(`+)[\s\S]*?\1/g, " ");
  const aliases = new Map<string, Set<string>>();
  for (const member of members) for (const name of [member.id, ...member.names]) {
    const key = name.trim().toLowerCase();
    if (key) aliases.set(key, new Set([...(aliases.get(key) ?? []), member.id]));
  }
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length), lower = prose.toLowerCase();
  const ids = new Set<string>(), unresolved = new Set<string>(), ambiguous = new Set<string>();
  // Chinese and Japanese prose put no space around a mention ("请@GG1看一下").
  // A mention therefore also starts right after CJK text, but never after a
  // Latin letter, digit, "/" or "." (emails, URLs, package scopes). A name
  // ending in an ASCII letter/digit also ends right before CJK text; a
  // CJK-final name still needs punctuation or space, because "@助手乙" may be
  // a different, unknown Bot rather than "@助手" + "乙".
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const strict = (value: string | undefined) => value === undefined || /[\s,，。.!！?？:：;；、)）\]】」』》”’]/u.test(value);
  const boundary = (name: string, value: string | undefined) => strict(value) || /[a-z0-9]$/.test(name) && cjk.test(value!);
  const pattern = /(^|[\s,，。!！?？:：;；、(（\[【「『《“‘]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[@＠]/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prose))) {
    const start = match.index + match[0].length;
    const name = names.find(name => lower.startsWith(name, start) && boundary(name, prose[start + name.length]));
    // Full member aliases win, including model/version names with dots or
    // slashes. A literal that only shares a member prefix is ambiguous: never
    // silently turn @A/B or @A.example into an all-member broadcast.
    const suffix = prose.slice(start);
    const literal = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/i.exec(suffix)?.[0]
      ?? /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i.exec(suffix)?.[0];
    if (literal && (!name || name.length < literal.length)) {
      if (names.some(alias => literal.toLowerCase().startsWith(alias) && /[./]/.test(literal[alias.length] ?? ''))) unresolved.add(literal);
      pattern.lastIndex = start + literal.length; continue;
    }
    if (name) {
      const targets = aliases.get(name)!;
      if (targets.size === 1) ids.add([...targets][0]!); else { const token = prose.slice(start, start + name.length); unresolved.add(token); ambiguous.add(token); }
      pattern.lastIndex = start + name.length;
    } else {
      const token = /^[^\s,，。.!！?？:：;；、)）\]】」』》”’]+/u.exec(prose.slice(start))?.[0];
      if (token) unresolved.add(token);
    }
  }
  return { ids: [...ids], unresolved: [...unresolved], ...(ambiguous.size ? { ambiguous: [...ambiguous] } : {}) };
}
