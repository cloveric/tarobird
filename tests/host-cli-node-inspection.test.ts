import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { inspectFrozenNodeDependencies } from "../src/host-cli/update.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(["ENOENT", "nonzero"])("explains macOS inspection prerequisites and refuses to freeze Node after otool %s", async failure => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => failure === "ENOENT" ? child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })) : child.emit("close", 1));
    return child as unknown as ReturnType<typeof spawn>;
  });
  await expect(inspectFrozenNodeDependencies("/fixture/node", "darwin")).rejects.toThrow("xcode-select --install");
  expect(spawn).toHaveBeenCalledWith("/usr/bin/otool", ["-L", "/fixture/node"], { stdio: ["ignore", "pipe", "pipe"] });
});
