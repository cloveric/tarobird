import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale, type SupportedLocale } from "../client/src/i18n.js";
import { formatMessageTime, formatRowTime } from "../client/src/conversation-inbox.js";

// Every instant is built from local calendar fields, so the cases hold in any
// time zone the suite runs in. The clock part keeps the device's own format.
const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) => new Date(year, month - 1, day, hour, minute, second, ms).getTime();
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const now = local(2026, 11, 17, 15, 30);
const use = (locale: SupportedLocale) => { vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } }); setLocale(locale); };
afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });

describe("message timestamps inside a conversation", () => {
  it.each([
    ["zh", "昨天", "11月15日", "1月2日", "2025年12月3日"],
    ["en", "Yesterday", "Nov 15", "Jan 2", "Dec 3, 2025"],
    ["ja", "昨日", "11月15日", "1月2日", "2025年12月3日"],
  ] as const)("%s: today is time-only; older messages add the day, then the year", (locale, yesterday, earlier, january, lastYear) => {
    use(locale);
    const at = { today: local(2026, 11, 17, 14, 5), yesterday: local(2026, 11, 16, 14, 5), earlier: local(2026, 11, 15, 14, 5), january: local(2026, 1, 2, 9, 7), lastYear: local(2025, 12, 3, 14, 5) };
    expect(formatMessageTime(at.today, locale, false, now)).toBe(clock(at.today));
    expect(formatMessageTime(at.yesterday, locale, false, now)).toBe(`${yesterday} ${clock(at.yesterday)}`);
    expect(formatMessageTime(at.earlier, locale, false, now)).toBe(`${earlier} ${clock(at.earlier)}`);
    expect(formatMessageTime(at.january, locale, false, now)).toBe(`${january} ${clock(at.january)}`);
    expect(formatMessageTime(at.lastYear, locale, false, now)).toBe(`${lastYear} ${clock(at.lastYear)}`);
  });

  it.each([
    ["zh", "昨天", "11月15日"],
    ["en", "Yesterday", "Nov 15"],
    ["ja", "昨日", "11月15日"],
  ] as const)("%s: days change at local midnight, not 24 hours ago", (locale, yesterday, dayBefore) => {
    use(locale);
    const midnight = local(2026, 11, 17), lastMs = local(2026, 11, 16, 23, 59, 59, 999);
    expect(formatMessageTime(midnight, locale, false, now)).toBe(clock(midnight));
    expect(formatMessageTime(lastMs, locale, false, now)).toBe(`${yesterday} ${clock(lastMs)}`);
    const yesterdayStart = local(2026, 11, 16), dayBeforeEnd = local(2026, 11, 15, 23, 59, 59, 999);
    expect(formatMessageTime(yesterdayStart, locale, false, now)).toBe(`${yesterday} ${clock(yesterdayStart)}`);
    expect(formatMessageTime(dayBeforeEnd, locale, false, now)).toBe(`${dayBefore} ${clock(dayBeforeEnd)}`);
    // Just after midnight, a message from 23:58 is already "yesterday".
    const justAfter = local(2026, 11, 17, 0, 1), lateEvening = local(2026, 11, 16, 23, 58);
    expect(formatMessageTime(lateEvening, locale, false, justAfter)).toBe(`${yesterday} ${clock(lateEvening)}`);
  });

  it.each([
    ["zh", "昨天", "2025年12月30日"],
    ["en", "Yesterday", "Dec 30, 2025"],
    ["ja", "昨日", "2025年12月30日"],
  ] as const)("%s: New Year's Eve is yesterday on New Year's Day; earlier days carry the year", (locale, yesterday, older) => {
    use(locale);
    const newYear = local(2026, 1, 1, 10, 0), eve = local(2025, 12, 31, 22, 15), before = local(2025, 12, 30, 22, 15);
    expect(formatMessageTime(eve, locale, false, newYear)).toBe(`${yesterday} ${clock(eve)}`);
    expect(formatMessageTime(before, locale, false, newYear)).toBe(`${older} ${clock(before)}`);
  });

  it.each([
    ["zh", "昨天", "11/15", "2025/12/3"],
    ["en", "Yesterday", "11/15", "12/3/2025"],
    ["ja", "昨日", "11/15", "2025/12/3"],
  ] as const)("%s: the compact form uses the conversation list's numeric day for every earlier day", (locale, yesterday, earlier, lastYear) => {
    use(locale);
    const at = { today: local(2026, 11, 17, 14, 5), yesterday: local(2026, 11, 16, 14, 5), earlier: local(2026, 11, 15, 14, 5), lastYear: local(2025, 12, 3, 14, 5) };
    expect(formatMessageTime(at.today, locale, true, now)).toBe(clock(at.today));
    expect(formatMessageTime(at.yesterday, locale, true, now)).toBe(`11/16 ${clock(at.yesterday)}`);
    expect(formatMessageTime(at.earlier, locale, true, now)).toBe(`${earlier} ${clock(at.earlier)}`);
    // New Year's Eve seen on New Year's Day is another year: day only.
    expect(formatMessageTime(local(2025, 12, 31, 22, 15), locale, true, local(2026, 1, 1, 10, 0))).toBe(locale === "en" ? "12/31/2025" : "2025/12/31");
    // Another year has no room for the clock in a narrow row.
    expect(formatMessageTime(at.lastYear, locale, true, now)).toBe(lastYear);
    // The list keeps its own wording for the same days.
    expect(formatRowTime(local(2026, 10, 8, 9, 7), locale, now)).toBe("10/8");
    expect(formatRowTime(at.lastYear, locale, now)).toBe(lastYear);
    expect(formatRowTime(at.yesterday, locale, now)).toBe(yesterday);
  });

  it("a message stamped slightly ahead of this device's clock still reads as today", () => {
    use("zh");
    const ahead = now + 90_000;
    expect(formatMessageTime(ahead, "zh", false, now)).toBe(clock(ahead));
  });
});

describe("formatters are built once, not per call", () => {
  it("formats many rows and messages without constructing a formatter for each", () => {
    use("zh");
    const at = [local(2026, 11, 17, 14, 5), local(2026, 11, 16, 14, 5), local(2026, 11, 13, 14, 5), local(2026, 1, 2, 9, 7), local(2025, 12, 3, 14, 5)];
    for (const value of at) { formatMessageTime(value, "zh", false, now); formatMessageTime(value, "zh", true, now); formatRowTime(value, "zh", now); }   // warm
    const built = vi.spyOn(Intl, "DateTimeFormat"), clockCalls = vi.spyOn(Date.prototype, "toLocaleTimeString");
    const first = at.map(value => [formatMessageTime(value, "zh", false, now), formatMessageTime(value, "zh", true, now), formatRowTime(value, "zh", now)]);
    for (let i = 0; i < 200; i++) for (const value of at) { formatMessageTime(value, "zh", false, now); formatMessageTime(value, "zh", true, now); formatRowTime(value, "zh", now); }
    expect(built).not.toHaveBeenCalled();
    expect(clockCalls).not.toHaveBeenCalled();
    expect(at.map(value => [formatMessageTime(value, "zh", false, now), formatMessageTime(value, "zh", true, now), formatRowTime(value, "zh", now)])).toEqual(first);
    // The clock part is still what the device's own format gives.
    built.mockRestore(); clockCalls.mockRestore();
    expect(formatMessageTime(at[0]!, "zh", false, now)).toBe(clock(at[0]!));
  });
});
