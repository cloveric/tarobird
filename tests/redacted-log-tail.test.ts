import { expect, it } from "vitest";
import { RedactedLogTail } from "../src/runtime/redacted-log-tail.js";

it.each([
  ["Authorization: Basic Zml4dHVyZTpzZWNyZXQ=", "Zml4dHVyZTpzZWNyZXQ="],
  ["Authorization: Bearer bearer-secret", "bearer-secret"],
  ['{"token":"quoted-secret"}', "quoted-secret"],
  ["api_key=api-secret", "api-secret"],
  ["Authorization: Instance alpha:instance-secret", "instance-secret"],
  ['"Authorization" : "Basic interrupted-secret', "interrupted-secret"],
  ['"Authorization":"Basic interrupted-secret\\', "interrupted-secret"],
])("redacts every byte boundary of %s", (line, secret) => {
  const bytes = Buffer.from(`${line}\n`);
  for (let split = 0; split <= bytes.length; split++) {
    const log = new RedactedLogTail();
    log.write(bytes.subarray(0, split));
    expect(log.text()).not.toContain(secret);
    log.write(bytes.subarray(split)); log.end();
    expect(log.text()).toContain("[redacted]"); expect(log.text()).not.toContain(secret);
  }
});

it("keeps a partial line private across process exit until stderr actually closes", () => {
  const log = new RedactedLogTail();
  log.write(Buffer.from("Authorization: Bea"));
  expect(log.text()).toBe(""); // The process can exit here while stdio is still open.
  log.write(Buffer.from("rer late-secret"));
  expect(log.text()).toBe("");
  log.end();
  expect(log.text()).toBe("Authorization: Bearer [redacted]\n");
  log.end(); log.write("ignored-after-close");
  expect(log.text()).not.toContain("ignored");
});

it("discards all fragments of an oversized line and resumes at the next newline", () => {
  const log = new RedactedLogTail("", 32, 256);
  log.write("x".repeat(33)); log.write("Authorization: Basic hidden-tail");
  log.write("\nnext safe line\n"); log.end();
  expect(log.text()).toBe("[stderr line omitted: too long]\nnext safe line\n");
  const oneChunk = new RedactedLogTail("", 32, 256);
  oneChunk.write("x".repeat(80) + "secret-tail\nnext\n");
  expect(oneChunk.text()).toBe("[stderr line omitted: too long]\nnext\n");
});

it("decodes split UTF-8 and bounds the completed tail without carrying pending bytes to a new worker", () => {
  const bytes = Buffer.from("错误日志：连接失败\n"), old = new RedactedLogTail();
  for (const byte of bytes) old.write(Buffer.from([byte]));
  expect(old.text()).toBe(bytes.toString());
  old.write("Authorization: Bea");
  const replacement = new RedactedLogTail(old.text());
  replacement.write("new worker\n");
  old.write("rer old-secret\n"); old.end();
  expect(replacement.text()).toBe(`${bytes.toString()}new worker\n`);
  for (let i = 0; i < 2000; i++) replacement.write(`safe line ${i}\n`);
  expect(replacement.text().length).toBeLessThanOrEqual(8192);
  expect(replacement.text()).not.toContain("old-secret");
});
