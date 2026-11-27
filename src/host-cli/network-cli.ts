import { createHash, verify } from "node:crypto";
import { PRIVATE_NETWORK_RECOVERY_CAPABILITY, networkCanonical, networkCommandSchema, networkCommandResultSchema, networkGenesisText, networkManifestProof, networkMemberText, networkProposalProof, networkViewSchema, signedNetworkManifestSchema, signedNetworkProposalSchema, type NetworkCommand, type NetworkCommandResult, type NetworkView, type SignedNetworkManifest, type SignedNetworkProposal } from "../client-protocol/private-network.js";
import { HOST_ROUTES_CAPABILITY, HOST_ROUTES_PATH, HOST_LAN_SELECTION_CAPABILITY, HOST_LAN_SELECTION_PATH, managedLanSelectionSchema, hostRoutesViewSchema, type HostRoutesView } from "../client-protocol/host-routes.js";
import { hashSecret, parsePublicKey } from "../hub/auth.js";
import { HostCliError, LocalHostClient } from "./client.js";

export type CliNetworkCommand = Exclude<NetworkCommand, { operation: "attest" }>;
const CLI_OPERATIONS = new Set(["create", "routes", "propose", "admit", "join", "reinstate", "leave", "remove"]);

/** Signed public transfer documents are verified before being displayed or
 * used. No device or host private key belongs in an offer/proposal/receipt. */
export function verifyCliNetworkMembership(raw: unknown, expectedHostKey?: string, pin?: { id: string; authorityKey: string }): SignedNetworkManifest {
  const signed = signedNetworkManifestSchema.parse(raw), manifest = signed.manifest;
  const blocked = new Set(manifest.blockedKeys ?? []);
  const origins = new Map(manifest.devices.filter(device => device.memberId === `pm_${createHash("sha256").update(networkMemberText(device.host, device.id, device.originGeneration ?? 1)).digest("base64url")}`
    && device.originHost === device.host && device.attestedBy === device.host
    && (device.originGeneration ?? 1) === (device.generation ?? 1) && (device.attestedGeneration ?? 1) === (device.generation ?? 1))
    .map(device => [device.memberId, { host: device.host, generation: device.originGeneration ?? 1 }]));
  for (const host of manifest.hosts) parsePublicKey(host.publicKey);
  for (const device of manifest.devices) parsePublicKey(device.publicKey);
  if (networkCanonical(raw) !== networkCanonical(signed)
    || manifest.id !== `net_${hashSecret(networkGenesisText(manifest.authorityKey, manifest.genesisNonce))}`
    || pin && (manifest.id !== pin.id || manifest.authorityKey !== pin.authorityKey)
    || !verify(null, Buffer.from(networkManifestProof(manifest)), parsePublicKey(manifest.authorityKey), Buffer.from(signed.signature, "base64"))
    || manifest.devices.some(device => {
      if (device.revoked) return false;
      const origin = origins.get(device.memberId);
      return !origin || origin.host !== device.originHost || origin.generation !== (device.originGeneration ?? 1) || blocked.has(hashSecret(device.publicKey));
    })
    || expectedHostKey && !manifest.hosts.some(host => host.publicKey === expectedHostKey)) throw new HostCliError("network_membership_invalid");
  return signed;
}

export function verifyCliNetworkProposal(raw: unknown): SignedNetworkProposal {
  const signed = signedNetworkProposalSchema.parse(raw);
  if (networkCanonical(raw) !== networkCanonical(signed)
    || !verify(null, Buffer.from(networkProposalProof(signed.proposal)), parsePublicKey(signed.proposal.host.publicKey), Buffer.from(signed.signature, "base64"))) throw new HostCliError("network_proposal_invalid");
  return signed;
}

export class HostNetwork {
  constructor(readonly client: LocalHostClient) {}
  private verifyView(raw: unknown): NetworkView {
    const view = networkViewSchema.parse(raw);
    if (view.host.publicKey !== this.client.publicKey) throw new HostCliError("network_host_mismatch");
    if (view.membership) verifyCliNetworkMembership(view.membership, this.client.publicKey);
    return view;
  }
  async view(): Promise<NetworkView> {
    const route = this.client.supports(PRIVATE_NETWORK_RECOVERY_CAPABILITY) ? "/api/network?capabilities=1" : "/api/network";
    return this.verifyView(await this.client.request(route));
  }
  /** Read-only: the same owner-scoped endpoint the App uses for self-route sync. */
  async localRoutes(): Promise<HostRoutesView> {
    if (!this.client.ready.serverCapabilities.includes(HOST_ROUTES_CAPABILITY)) throw new HostCliError("host_routes_update_required");
    const view = hostRoutesViewSchema.parse(await this.client.request(HOST_ROUTES_PATH));
    if (view.hostPublicKey !== this.client.publicKey) throw new HostCliError("network_host_mismatch");
    return view;
  }
  /** Explicitly select an already-listening LAN without replacing shared Tailscale. */
  async selectLan(raw: unknown): Promise<HostRoutesView> {
    if (!this.client.ready.serverCapabilities.includes(HOST_LAN_SELECTION_CAPABILITY)) throw new HostCliError("host_routes_update_required");
    const input = managedLanSelectionSchema.parse({ route: raw });
    const view = hostRoutesViewSchema.parse(await this.client.request(HOST_LAN_SELECTION_PATH, "POST", input));
    if (view.hostPublicKey !== this.client.publicKey) throw new HostCliError("network_host_mismatch");
    return view;
  }
  async command(raw: CliNetworkCommand): Promise<NetworkCommandResult> {
    if (!this.client.ready.serverCapabilities.includes("private-network.v2")) throw new HostCliError("network_host_update_required");
    const command = networkCommandSchema.parse(raw);
    if (!CLI_OPERATIONS.has(command.operation)) throw new HostCliError("cli_network_host_controller_only");
    if (networkCanonical(raw) !== networkCanonical(command)) throw new HostCliError("network_command_invalid");
    if ((command.operation === "reinstate" || (command.operation === "propose" && command.recover)) && !this.client.supports(PRIVATE_NETWORK_RECOVERY_CAPABILITY)) {
      throw new HostCliError("network_recovery_upgrade_required");
    }
    if (command.operation === "admit") verifyCliNetworkProposal(command.proposal);
    if (command.operation === "join") verifyCliNetworkMembership(command.membership, this.client.publicKey);
    const proof = await this.client.deviceAction({ operation: "network", target: hashSecret(networkCanonical(command)) });
    // Mutations are intentionally never retried automatically. The caller
    // retains the signed proposal and its original nonce across lost replies.
    const manageRoute = this.client.supports(PRIVATE_NETWORK_RECOVERY_CAPABILITY) ? "/api/network/manage?capabilities=1" : "/api/network/manage";
    const result = networkCommandResultSchema.parse(await this.client.request(manageRoute, "POST", { command, proof }));
    this.verifyView(result.view);
    if (result.membership) verifyCliNetworkMembership(result.membership);
    if (result.proposal) {
      const proposal = verifyCliNetworkProposal(result.proposal).proposal;
      if (command.operation !== "propose" || proposal.host.publicKey !== this.client.publicKey
        || proposal.networkId !== command.networkId || proposal.authorityKey !== command.authorityKey
        || proposal.seenManifestHash !== command.seenManifestHash) throw new HostCliError("network_proposal_mismatch");
    }
    if (command.operation === "propose" && !result.proposal) throw new HostCliError("network_proposal_missing");
    if (command.operation === "admit") {
      if (!result.membership) throw new HostCliError("network_membership_missing");
      verifyCliNetworkMembership(result.membership, command.proposal.proposal.host.publicKey, { id: command.proposal.proposal.networkId, authorityKey: this.client.publicKey });
    }
    return result;
  }
}
