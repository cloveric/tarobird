import { useCallback, useSyncExternalStore } from "react";
import { compareMessages } from "./message-lru-cache.js";

const legacyKey = "tarobird.filesChangesSeen";
const keyPrefix = `${legacyKey}:v2:`;
const maxConversations = 200;
const maxMarksPerConversation = 4;

export type FilesChangesMark = { id: string; createdAt: number; version: number; runId: string; files: number };
type StoredChanges = { seenAt: number; marks: FilesChangesMark[] };
const unsaved = new Map<string, StoredChanges>();

function sameMark(left: FilesChangesMark, right: FilesChangesMark) {
  return left.id === right.id && left.runId === right.runId && left.files === right.files;
}

function compareMarks(left: FilesChangesMark, right: FilesChangesMark) {
  return compareMessages(left, right) || left.version - right.version;
}

function readRecord(raw: string | null): StoredChanges | undefined {
  try {
    const record = JSON.parse(raw ?? "null") as StoredChanges | null;
    if (record && Number.isFinite(record.seenAt) && Array.isArray(record.marks)) {
      const marks = record.marks.filter(mark => mark && typeof mark.id === "string" && typeof mark.runId === "string"
        && Number.isFinite(mark.createdAt) && Number.isFinite(mark.version) && Number.isFinite(mark.files));
      return { seenAt: record.seenAt, marks: marks.slice(0, maxMarksPerConversation) };
    }
  } catch { /* Discard malformed saved values. */ }
}

function addMark(previous: StoredChanges | undefined, mark: FilesChangesMark) {
  const previousMarks = previous?.marks ?? [];
  if (previousMarks.some(saved => sameMark(saved, mark) && compareMarks(saved, mark) >= 0)) return undefined;
  const marks = [mark, ...previousMarks.filter(saved => !sameMark(saved, mark))];
  if (marks.length > maxMarksPerConversation) {
    // Keep the newest reply/version even if a slower window acknowledges an
    // older snapshot. The other slots can hold displayed fallback turns.
    const newest = marks.reduce((latest, item) => compareMarks(item, latest) > 0 ? item : latest);
    marks.splice(marks.at(-1) === newest ? marks.length - 2 : marks.length - 1, 1);
  }
  return { seenAt: Date.now(), marks };
}

export function readFilesChangesSeen(storage: Storage, scope: string, mark: FilesChangesMark) {
  return readRecord(storage.getItem(`${keyPrefix}${scope}`))?.marks.some(saved => sameMark(saved, mark)) ?? false;
}

export function saveFilesChangesSeen(storage: Storage, scope: string, mark: FilesChangesMark) {
  const storageKey = `${keyPrefix}${scope}`;
  const next = addMark(readRecord(storage.getItem(storageKey)), mark);
  if (!next) return;
  storage.setItem(storageKey, JSON.stringify(next));
  if (storage.length <= maxConversations) return;
  const older: { key: string; seenAt: number }[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== storageKey && key?.startsWith(keyPrefix)) {
      older.push({ key, seenAt: readRecord(storage.getItem(key))?.seenAt ?? 0 });
    }
  }
  if (older.length < maxConversations) return;
  older.sort((left, right) => left.seenAt - right.seenAt);
  for (const { key } of older.slice(0, older.length - maxConversations + 1)) storage.removeItem(key);
}

export function useFilesChangesSeen(scope: string | undefined, conversationId: string, mark: FilesChangesMark | undefined) {
  const key = scope ? `${keyPrefix}${scope}` : undefined;
  const subscribe = useCallback((notify: () => void) => {
    if (!key) return () => {};
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key || event.key === legacyKey) notify();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(legacyKey, notify);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(legacyKey, notify);
    };
  }, [key]);
  const snapshot = useCallback(() => {
    if (!scope || !mark) return false;
    if (unsaved.get(scope)?.marks.some(saved => sameMark(saved, mark))) return true;
    try {
      if (readFilesChangesSeen(localStorage, scope, mark)) return true;
      const previous: unknown = JSON.parse(localStorage.getItem(legacyKey) ?? "null");
      return !!previous && typeof previous === "object" && Object.hasOwn(previous, conversationId)
        && (previous as Record<string, unknown>)[conversationId] === `${mark.id}:${mark.files}`;
    } catch {
      return false;
    }
  }, [scope, conversationId, mark]);
  const seen = useSyncExternalStore(subscribe, snapshot);
  const markSeen = useCallback(() => {
    if (!scope || !mark) return;
    const write = () => {
      try {
        saveFilesChangesSeen(localStorage, scope, mark);
      } catch {
        const next = addMark(unsaved.get(scope), mark);
        if (next) {
          unsaved.delete(scope);
          unsaved.set(scope, next);
          const oldest = unsaved.keys().next().value;
          if (unsaved.size > maxConversations && oldest !== undefined) unsaved.delete(oldest);
        }
      }
      window.dispatchEvent(new Event(legacyKey));
    };
    // Serialize same-origin tabs where supported. Within one window the
    // synchronous read/merge/write also covers independently mounted Hosts.
    if (navigator.locks) void navigator.locks.request(keyPrefix, write).catch(write);
    else write();
  }, [scope, mark]);
  return { seen, markSeen };
}
