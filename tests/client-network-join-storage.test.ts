import { describe, expect, it } from "vitest";
import { clearNetworkJoinAttempt, loadNetworkJoinAttempt, saveNetworkJoinAttempt } from "../client/src/network-join-storage.js";
import { reviewedNetworkHash, type NetworkJoinAttempt } from "../client/src/network-join.js";
import type { NetworkManifest } from "../src/client-protocol/private-network.js";

function fixture() {
  const key = (value: number) => Buffer.concat([Buffer.from([48,42,48,5,6,3,43,101,112,3,33,0]), Buffer.alloc(32, value)]).toString("base64");
  const authorityKey = key(1), sourceKey = key(2), nonce = Buffer.alloc(32, 1).toString("base64url");
  const reviewedManifest: NetworkManifest = { v:1, id:"network-test", name:"Work", authorityKey, genesisNonce:nonce, revision:1, hosts:[{publicKey:authorityKey,name:"Root",routes:[],state:"active",revoked:false}], devices:[],revokedMembers:[],blockedBindings:[] };
  const seenManifestHash = reviewedNetworkHash(reviewedManifest);
  const attempt: NetworkJoinAttempt = { networkId:reviewedManifest.id,authorityKey,sourceKey,seenManifestHash,reviewedManifest,proposal:{signature:Buffer.alloc(64).toString("base64"),proposal:{v:1,host:{publicKey:sourceKey,name:"Laptop",routes:[]},devices:[],networkId:reviewedManifest.id,authorityKey,seenManifestHash,nonce,expiresAt:Date.now()+60_000}} };
  const data = new Map<string,string>();
  const storage = { getItem: (key:string) => data.get(key) ?? null, setItem:(key:string,value:string) => { data.set(key,value); }, removeItem:(key:string) => { data.delete(key); } };
  return {attempt,data,storage};
}

describe("public network join recovery", () => {
  it("restores the exact signed proposal in a fresh UI instance and clears it after success", () => {
    const {attempt,data,storage} = fixture(); saveNetworkJoinAttempt(attempt,storage);
    expect(loadNetworkJoinAttempt(attempt.networkId,attempt.authorityKey,attempt.sourceKey,storage)).toEqual(attempt);
    expect([...data.values()].join("")).not.toMatch(/privateKey|secretKey|credentials/);
    clearNetworkJoinAttempt(attempt.networkId,attempt.authorityKey,attempt.sourceKey,storage);
    expect(loadNetworkJoinAttempt(attempt.networkId,attempt.authorityKey,attempt.sourceKey,storage)).toBeUndefined();
  });
  it("cannot restore another source or substitute a different reviewed directory", () => {
    const {attempt,data,storage} = fixture(); saveNetworkJoinAttempt(attempt,storage);
    expect(loadNetworkJoinAttempt(attempt.networkId,attempt.authorityKey,attempt.authorityKey,storage)).toBeUndefined();
    const key = [...data.keys()][0]!; const raw = JSON.parse(data.get(key)!); raw.reviewedManifest.name = "Unreviewed network"; data.set(key,JSON.stringify(raw));
    expect(loadNetworkJoinAttempt(attempt.networkId,attempt.authorityKey,attempt.sourceKey,storage)).toBeUndefined();
  });
  it("rejects malformed or private fields and reports failed persistence before admission", () => {
    const {attempt,storage} = fixture();
    expect(() => saveNetworkJoinAttempt({...attempt,privateKey:"must-not-store"} as NetworkJoinAttempt,storage)).toThrow();
    expect(() => saveNetworkJoinAttempt(attempt,{...storage,setItem() { throw new Error("quota"); }})).toThrow("network_join_recovery_unavailable");
    expect(loadNetworkJoinAttempt(attempt.networkId,attempt.authorityKey,attempt.sourceKey,{...storage,getItem:()=>"{"})).toBeUndefined();
  });
});
