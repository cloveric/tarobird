import { expect, it } from "vitest";
import { readFilesChangesSeen, saveFilesChangesSeen, type FilesChangesMark } from "./use-files-changes-seen.js";

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); },
    key: index => [...entries.keys()][index] ?? null,
    clear: () => { entries.clear(); },
  };
}

function mark(turn: number, version = 1, files = 1): FilesChangesMark {
  return { id: `reply-${turn}`, createdAt: turn, version, runId: `run-${turn}`, files };
}

it("bounds saved scopes by conversation even after 201 acknowledgements in one conversation", () => {
  const storage = memoryStorage();
  const hostA = "host-a/conversation";
  const hostB = "host-b/conversation";
  const saved = mark(1);
  saveFilesChangesSeen(storage, hostA, saved);
  expect(readFilesChangesSeen(storage, hostB, saved)).toBe(false);
  for (let turn = 1; turn <= 201; turn++) saveFilesChangesSeen(storage, hostB, mark(turn));

  expect(storage.length).toBe(2);
  expect(readFilesChangesSeen(storage, hostA, saved)).toBe(true);
  expect(readFilesChangesSeen(storage, hostB, mark(201))).toBe(true);
  expect(readFilesChangesSeen(storage, hostB, saved)).toBe(false);

  for (let index = 0; index < 201; index++) saveFilesChangesSeen(storage, `other-${index}`, saved);
  expect(storage.length).toBe(200);
});

it("keeps a newer reply version when other views acknowledge older snapshots of the same conversation", () => {
  const storage = memoryStorage();
  const scope = "host/conversation";
  const newer = mark(21, 2, 3);
  saveFilesChangesSeen(storage, scope, newer);
  // An older version can arrive after the newest acknowledgement, including
  // when the older version reported a different file count.
  saveFilesChangesSeen(storage, scope, mark(21, 1, 1));
  for (let turn = 1; turn <= 10; turn++) saveFilesChangesSeen(storage, scope, mark(turn));

  expect(readFilesChangesSeen(storage, scope, newer)).toBe(true);
  expect(readFilesChangesSeen(storage, scope, mark(10))).toBe(true);
  expect(readFilesChangesSeen(storage, scope, mark(21, 2, 4))).toBe(false);
});
