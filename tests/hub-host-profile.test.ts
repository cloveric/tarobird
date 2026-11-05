import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubDatabase } from "../src/hub/database.js";
import { HostProfile } from "../src/hub/host-profile.js";
import { hostNameSchema, hostProfileChangeSchema } from "../src/client-protocol/host-profile.js";

let directory: string, db: HubDatabase;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "host-profile-")); db = await HubDatabase.open(directory); });
afterEach(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });

it("initializes the host name once and retains it across reopen and changed computer defaults", async () => {
  const profile = new HostProfile(db, "  工作 Mac  ");
  expect(await profile.read()).toEqual({ name: "工作 Mac", revision: 0 });
  await db.close(); db = await HubDatabase.open(directory);
  expect(await new HostProfile(db, "Another computer").read()).toEqual({ name: "工作 Mac", revision: 0 });
  expect(await db.get("SELECT value FROM meta WHERE key='host-profile:v1'")).toEqual({ value: JSON.stringify({ name: "工作 Mac", revision: 0 }) });
});

it("serializes concurrent renames and rejects stale revisions without overwriting the winner", async () => {
  const profile = new HostProfile(db, "Original");
  const results = await Promise.allSettled(["First", "Second"].map(name => profile.update({ name, revision: 0 })));
  expect(results[0]).toMatchObject({ status: "fulfilled", value: { name: "First", revision: 1 } });
  expect(results[1]).toMatchObject({ status: "rejected", reason: { message: "host_profile_changed", status: 409 } });
  expect(await profile.read()).toEqual({ name: "First", revision: 1 });
  expect(await profile.update({ name: "  Final  ", revision: 1 })).toEqual({ name: "Final", revision: 2 });
});

it("rechecks authorization inside queued reads and writes before initializing or changing metadata", async () => {
  const profile = new HostProfile(db, "Original");
  let authorized = true;
  const validate = async () => { if (!authorized) throw new Error("device_revoked"); };
  const revoke = db.transaction(async () => { authorized = false; });
  await expect(profile.read(validate)).rejects.toThrow("device_revoked");
  await revoke;
  expect(await db.get("SELECT value FROM meta WHERE key='host-profile:v1'")).toBeUndefined();
  await expect(profile.update({ name: "Denied", revision: 0 }, validate)).rejects.toThrow("device_revoked");
  expect(await profile.read()).toEqual({ name: "Original", revision: 0 });
  await expect(profile.update({ name: "Denied", revision: 0 }, validate)).rejects.toThrow("device_revoked");
  expect(await profile.read()).toEqual({ name: "Original", revision: 0 });
});

it("validates the entire name and revision payload and preserves corrupted metadata for recovery", async () => {
  expect(hostNameSchema.parse("  主机 1  ")).toBe("主机 1");
  for (const name of ["", "  ", "a".repeat(101), "\ncomputer", "computer\t", "A\u0000B", "A\u007fB", "A\u202eB"]) {
    expect(hostNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
  }
  for (const input of [{ name: "Name" }, { name: "Name", revision: -1 }, { name: "Name", revision: 0.1 }, { name: "Name", revision: Number.MAX_SAFE_INTEGER + 1 }, { name: "Name", revision: 0, hubId: "other" }]) {
    expect(hostProfileChangeSchema.safeParse(input).success).toBe(false);
  }
  await db.run("INSERT INTO meta(key,value) VALUES('host-profile:v1','invalid-json')");
  await expect(new HostProfile(db).read()).rejects.toThrow();
  expect(await db.get("SELECT value FROM meta WHERE key='host-profile:v1'")).toEqual({ value: "invalid-json" });
});

it("does not wrap an exhausted revision or mutate unrelated metadata", async () => {
  const stored = { name: "Original", revision: Number.MAX_SAFE_INTEGER };
  await db.run("INSERT INTO meta(key,value) VALUES('host-profile:v1',?)", [JSON.stringify(stored)]);
  await db.run("INSERT INTO meta(key,value) VALUES('other-setting','keep')");
  await expect(new HostProfile(db).update({ name: "Next", revision: stored.revision })).rejects.toThrow("host_profile_revision_exhausted");
  expect(await new HostProfile(db).read()).toEqual(stored);
  expect(await db.get("SELECT value FROM meta WHERE key='other-setting'")).toEqual({ value: "keep" });
});
