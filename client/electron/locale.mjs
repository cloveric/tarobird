export function normalizeElectronLocale(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('ja')) return 'ja';
  if (trimmed.startsWith('zh')) return 'zh';
  return 'en';
}

export function resolveElectronLocale({ locale, english, app } = {}) {
  const explicit = normalizeElectronLocale(locale);
  if (explicit) return explicit;
  if (typeof english === 'boolean') return english ? 'en' : 'zh';
  try {
    const system = normalizeElectronLocale(app?.getLocale?.());
    if (system) return system;
  } catch { /* ignore */ }
  return 'zh';
}

export function pickElectronCopy(locale, table) {
  return table[locale] ?? table.en;
}
