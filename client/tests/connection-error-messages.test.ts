import { describe, expect, it } from "vitest";
import { connectionErrorMessage } from "../src/connection-verification.js";

describe("native identity error recovery guidance", () => {
  it.each(["device_storage_unavailable", "device_key_write_failed", "device_key_delete_failed", "device_storage_invalid", "device_key_migration_conflict", "device_storage_failed"])("does not misdiagnose %s as a network outage", code => {
    const message = connectionErrorMessage(code);
    expect(message).not.toMatch(/连接中断|检查主机和网络|自动重试/);
    expect(message).not.toBe(code);
    expect(message).toMatch(/安全存储|配对|密钥|身份/);
  });
});
