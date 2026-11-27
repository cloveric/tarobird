import { useSyncExternalStore } from "react";
import { addGlobalListener } from "./global-event-hub.js";

/** The timer fires this long after local midnight, so the calendar day has certainly turned. */
export const DAY_TURN_MARGIN_MS = 1000;
/**
 * Longest single wait. A long timer can come due late after the device sleeps,
 * and a new time zone or a corrected clock moves midnight without any event.
 * A bounded wait lets the next comparison notice within a minute; it compares
 * two numbers and notifies nobody unless the day really changed.
 */
export const DAY_RECHECK_MS = 60_000;

/** The device's calendar day as one comparable number: 18 November 2026 is 20261118. */
export function localDayKey(at: number): number {
  const date = new Date(at);
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Milliseconds from `at` to the start of the next local calendar day. Built from
 * local date parts instead of adding 24 hours: a daylight-saving day lasts 23 or
 * 25 hours, and where the clocks change at midnight the day starts at the first
 * instant that exists.
 */
export function msUntilNextLocalDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - at;
}

/**
 * One source for "which local day is it". While anyone is subscribed, a single
 * timer waits for the next local midnight and re-arms itself. The App coming
 * back into view also compares the day, because a sleeping device, a suspended
 * App or a changed clock can pass midnight without the timer firing on time.
 * Subscribers are told only when the day key actually changes.
 */
export function createLocalDay() {
  const listeners = new Set<() => void>();
  let day = localDayKey(Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const next = localDayKey(Date.now());
    if (next === day) return;
    day = next;
    for (const listener of [...listeners]) listener();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(wake, Math.min(msUntilNextLocalDay(Date.now()) + DAY_TURN_MARGIN_MS, DAY_RECHECK_MS));
  };
  // Re-arm first: a listener that throws must not end the schedule.
  const wake = () => { arm(); check(); };
  let stopListeners: (() => void)[] = [];
  const start = () => {
    // Page shown again, native App resumed, window activated, page restored from the back/forward cache.
    stopListeners = [
      addGlobalListener(document, "visibilitychange", wake),
      addGlobalListener(document, "resume", wake),
      addGlobalListener(window, "focus", wake),
      addGlobalListener(window, "pageshow", wake),
    ];
    wake();
  };
  const stop = () => {
    for (const off of stopListeners) off();
    stopListeners = [];
    clearTimeout(timer); timer = undefined;
  };
  return {
    /** The current day key. Read from the clock while nobody is subscribed, so a first render never starts from a stale day. */
    read: (): number => timer === undefined ? (day = localDayKey(Date.now())) : day,
    /** The first subscriber starts the timer and the wake listeners; the last one leaving removes them. */
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => { if (listeners.delete(listener) && !listeners.size) stop(); };
    },
  };
}

const localDay = createLocalDay();

/**
 * Re-renders the calling component when the device's local day changes and
 * returns the day key. Call it wherever a label is worded relative to today
 * ("昨天", a weekday, a dropped year); every caller shares one timer.
 */
export function useLocalDay(): number { return useSyncExternalStore(localDay.subscribe, localDay.read); }
