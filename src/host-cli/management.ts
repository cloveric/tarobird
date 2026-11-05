import { PAIRING_INVITES_CAPABILITY, PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH, pairingInviteCreateSchema, pairingInviteIssuedSchema, pairingInviteListSchema, pairingInviteRevokeSchema, pairingInviteStatusSchema } from "../client-protocol/pairing-invites.js";
import { chromeSettingsSchema, chromePatchSchema, type ChromePatch } from "../client-protocol/chrome.js";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { createBotSchema, deleteBotSchema, renameBotSchema, type BotCatalog, type CreateBotInput, type DeleteBotInput, type RenameBotInput } from "../client-protocol/bots.js";
import { hostProfileSchema } from "../client-protocol/host-profile.js";
import { modelSettingsSchema, modelPatchSchema, type ModelPatch } from "../client-protocol/model.js";
import { personaSettingsSchema, personaPatchSchema } from "../client-protocol/persona.js";
import type { Bot, DeviceSummary } from "../hub/store.js";
import { HostCliError, LocalHostClient } from "./client.js";

export class HostManagement {
  constructor(readonly client: LocalHostClient) {}
  bots(): Bot[] { return this.client.bots; }
  catalog(): Promise<BotCatalog> { return this.client.request("/api/bots/catalog"); }
  createBot(input: CreateBotInput): Promise<Bot> { return this.client.request("/api/bots", "POST", createBotSchema.parse(input)); }
  deleteBot(id: string, input: DeleteBotInput) { return this.client.request(`/api/bots/${idSchema.parse(id)}`, "DELETE", deleteBotSchema.parse(input)); }
  renameBot(id: string, input: RenameBotInput) { return this.client.request(`/api/bots/${idSchema.parse(id)}/name`, "PUT", renameBotSchema.parse(input)); }
  async restartBot(id: string, receiptId: string = randomUUID()) {
    const result = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), result: z.unknown() }), z.object({ ok: z.literal(false), error: z.string() })]).parse(
      await this.client.request(`/api/bots/${idSchema.parse(id)}/restart`, "POST", { receiptId: idSchema.parse(receiptId) }));
    if (!result.ok) throw new HostCliError(result.error);
    return result;
  }
  botStatus(id: string) { return this.client.request(`/api/bots/${idSchema.parse(id)}/service-status`); }
  async botChrome(id: string, patch?: ChromePatch) {
    return chromeSettingsSchema.parse(await this.client.request(`/api/bots/${idSchema.parse(id)}/chrome`, patch ? "PUT" : "GET", patch ? chromePatchSchema.parse(patch) : undefined));
  }
  async botModel(id: string, patch?: ModelPatch) {
    return modelSettingsSchema.parse(await this.client.request(`/api/bots/${idSchema.parse(id)}/model`, patch ? "PUT" : "GET", patch ? modelPatchSchema.parse(patch) : undefined));
  }
  async botPersona(id: string, patch?: unknown) {
    return personaSettingsSchema.parse(await this.client.request(`/api/bots/${idSchema.parse(id)}/persona`, patch === undefined ? "GET" : "PUT", patch === undefined ? undefined : personaPatchSchema.parse(patch)));
  }
  async profile() { return hostProfileSchema.parse(await this.client.request("/api/host-profile")); }
  async renameHost(name: string, revision: number) { return hostProfileSchema.parse(await this.client.request("/api/host-profile", "PATCH", { name, revision })); }
  devices(): Promise<DeviceSummary[]> { return this.client.request("/api/devices"); }
  renameDevice(deviceId: string, name: string) {
    return this.client.request("/api/devices/rename", "PATCH", { deviceId: idSchema.parse(deviceId), name: z.string().trim().min(1).max(100).parse(name) });
  }
  private requirePairingInvites(): void {
    if (!this.client.supports(PAIRING_INVITES_CAPABILITY)) throw new Error("请先更新此主机，才能生成限时连接码。如果 CLI 已更新，请在任务结束后运行 tarobot restart 更新主机进程。已有设备无需重新配对。");
  }
  async issuePairingInvite(requestId = randomBytes(32).toString("base64url"), replaces?: string) {
    this.requirePairingInvites();
    return pairingInviteIssuedSchema.parse(await this.client.request(PAIRING_INVITES_PATH, "POST", pairingInviteCreateSchema.parse({ requestId, replaces })));
  }
  async pairingInvites() {
    this.requirePairingInvites(); return pairingInviteListSchema.parse(await this.client.request(PAIRING_INVITES_PATH));
  }
  async revokePairingInvite(id: string) {
    this.requirePairingInvites(); return pairingInviteStatusSchema.parse(await this.client.request(PAIRING_INVITE_REVOKE_PATH, "POST", pairingInviteRevokeSchema.parse({ id })));
  }
  pendingDevices(): Promise<{ deviceId: string; name: string; platform: string; publicKey: string; expiresAt: number }[]> { return this.client.request("/api/devices/pending"); }
  async approveDevice(code: string) {
    const proof = await this.client.deviceAction({ operation: "approve", target: code });
    return this.client.request("/api/devices/approve", "POST", { code, proof });
  }
  async revokeDevice(deviceId: string) {
    const proof = await this.client.deviceAction({ operation: "revoke", target: idSchema.parse(deviceId) });
    return this.client.request("/api/devices/revoke", "POST", { deviceId, proof });
  }
}

export async function withHostManagement<T>(directory: string, work: (management: HostManagement) => Promise<T>, options: { enroll?: boolean } = {}): Promise<T> {
  const client = await LocalHostClient.connect(directory, options);
  try { return await work(new HostManagement(client)); } finally { client.close(); }
}
