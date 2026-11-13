import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as service from "../src/host-cli/service-manager.js";
import { inspectHost } from "../src/host-cli/doctor.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("reports service ownership mismatch structurally, and only names divergent environment variables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-environment-")); roots.push(root);
  vi.spyOn(service, "managedServiceStatus").mockRejectedValue(new Error("host_service_owner_mismatch"));
  vi.spyOn(service, "managedServiceEnvironmentDifferences").mockResolvedValue(["CODEX_HOME", "HTTPS_PROXY"]);
  const result = await inspectHost(root, { PATH: "/usr/bin", CODEX_HOME: "/private/custom", HTTPS_PROXY: "http://name:never-print-password@proxy.invalid" });
  expect(result.manager.error).toBe("host_service_owner_mismatch");
  expect(result.serviceEnvironmentDifferences).toEqual(["CODEX_HOME", "HTTPS_PROXY"]);
  expect(JSON.stringify(result)).not.toContain("never-print-password");
  expect(JSON.stringify(result)).not.toContain("/private/custom");
});
it("does not include raw environment/manifest errors that could contain proxy credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-environment-")); roots.push(root);
  vi.spyOn(service, "managedServiceStatus").mockRejectedValue(new Error("host_service_owner_mismatch: password=never-print-me"));
  vi.spyOn(service, "managedServiceEnvironmentDifferences").mockRejectedValue(new Error("proxy=never-print-me"));
  const result = await inspectHost(root, { PATH: "/usr/bin" });
  expect(result.manager.error).toBe("host_service_status_unavailable");
  expect(result.serviceEnvironmentCheck).toBe("host_service_environment_unavailable");
  expect(JSON.stringify(result)).not.toContain("never-print-me");
});

it.each([{ CODEX_HOME: "relative-private-location" }, { HTTPS_PROXY: "private\npassword" }])("keeps doctor usable for invalid service environment %j", async invalid => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-environment-")); roots.push(root);
  const result = await inspectHost(root, { PATH: "/usr/bin", ...invalid });
  expect(result.environmentCheck).toEqual({ error: "host_environment_invalid", variables: [Object.keys(invalid)[0]] });
  expect(result.engines).toHaveLength(5);
  expect(JSON.stringify(result)).not.toContain(Object.values(invalid)[0]);
});

it("explains settings repair without falling back or changing a damaged file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doctor-settings-")); roots.push(root);
  await writeFile(path.join(root, "engine-settings.json"), "broken", { mode: 0o600 });
  const result = await inspectHost(root, { PATH: "/usr/bin" });
  expect(result.engines).toEqual([]);
  expect(result.environmentCheck).toMatchObject({ error: "engine_settings_unavailable", hint: expect.stringContaining("engine-settings.json") });
});
