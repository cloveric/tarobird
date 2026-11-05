package com.tarobot.client;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Arrays;
import org.json.JSONObject;
import org.bouncycastle.util.encoders.Base64;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

public final class DeviceIdentityChecks {
    static int checks = 0;
    static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    interface Attempt { void run() throws Exception; }
    static void rejects(Attempt action) throws Exception { boolean rejected = false; try { action.run(); } catch (Exception expected) { rejected = true; } check(rejected, "accepted invalid operation"); }
    static class Memory implements DeviceIdentity.Store {
        final Map<String, String> values = new HashMap<>(), legacy = new HashMap<>();
        boolean writeFails, deleteFails, corruptWrite, failAfterWrite;
        int writes;
        public String read(String key, boolean old) { return (old ? legacy : values).get(key); }
        public void write(String key, String value) throws Exception { if (writeFails) throw new Exception("disk_failed"); values.put(key, corruptWrite ? "invalid" : value); writes++; if (failAfterWrite) throw new Exception("disk_commit_failed_after_memory_update"); }
        public void remove(String key, boolean old) throws Exception { if (deleteFails) throw new Exception("delete_failed"); (old ? legacy : values).remove(key); }
    }
    static void verify(String publicKey, String signature, String message) {
        byte[] spki = Base64.decode(publicKey), bytes = message.getBytes(StandardCharsets.UTF_8);
        Ed25519Signer verifier = new Ed25519Signer(); verifier.init(false, new Ed25519PublicKeyParameters(spki, 12)); verifier.update(bytes, 0, bytes.length);
        check(verifier.verifySignature(Base64.decode(signature)), "signature not accepted by Ed25519 verifier");
    }
    public static void main(String[] args) throws Exception {
        JSONObject v = new JSONObject(new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8));
        JSONObject s = v.getJSONObject("statement"); String id = s.getString("deviceId");
        byte[] seven = new byte[32]; Arrays.fill(seven, (byte) 7); String encoded = Base64.toBase64String(seven);
        Memory memory = new Memory(); DeviceIdentity identity = new DeviceIdentity(memory);
        memory.legacy.put(id, JSONObject.quote(encoded));
        check(DeviceIdentity.actionProof(s).equals(v.getString("proofText")), "action proof mismatch");
        check(identity.signAction(id, s).equals(v.getString("signature")), "action signature mismatch");
        check(!memory.legacy.containsKey(id) && encoded.equals(memory.values.get(id)), "migration did not preserve seed");
        check(new DeviceIdentity(memory).signAction(id, s).equals(v.getString("signature")), "restart lost identity");
        JSONObject network = new JSONObject(new String(Files.readAllBytes(Paths.get(args[0]).resolveSibling("device-network-action-vector.json")), StandardCharsets.UTF_8));
        JSONObject networkStatement = network.getJSONObject("statement");
        check(DeviceIdentity.actionProof(networkStatement).equals(network.getString("proofText")), "network action proof mismatch");
        check(identity.signAction(id, networkStatement).equals(network.getString("signature")), "network action signature mismatch");
        for (String target : new String[]{"", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "device_target", "a".repeat(64) + "\n"}) {
            JSONObject invalid = new JSONObject(networkStatement.toString()); invalid.getJSONObject("action").put("target", target);
            rejects(() -> identity.signAction(id, invalid));
        }
        JSONObject messageGrant = new JSONObject(new String(Files.readAllBytes(Paths.get(args[0]).resolveSibling("device-message-grant-vector.json")), StandardCharsets.UTF_8));
        JSONObject grantStatement = messageGrant.getJSONObject("statement");
        check(DeviceIdentity.actionProof(grantStatement).equals(messageGrant.getString("proofText")), "message grant proof mismatch");
        check(identity.signAction(id, grantStatement).equals(messageGrant.getString("signature")), "message grant signature mismatch");
        JSONObject badGrant = new JSONObject(grantStatement.toString()); badGrant.getJSONObject("action").put("target", "../bot");
        rejects(() -> identity.signAction(id, badGrant));
        String n = "n".repeat(43), c = "c".repeat(43);
        if (args.length > 1) {
            org.json.JSONArray nonces = new org.json.JSONArray(new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.UTF_8));
            for (int i = 0; i < nonces.length(); i++) {
                String client = nonces.getString(i);
                verify(v.getString("publicKey"), identity.sign(id, id, n, client), "tarocub/device/v1\0" + id + "\0" + n + "\0" + client);
            }
        }
        verify(v.getString("publicKey"), identity.sign(id, id, n, c), "tarocub/device/v1\0" + id + "\0" + n + "\0" + c);
        rejects(() -> identity.sign(id, "device_other", n, c)); rejects(() -> identity.sign(id, id, "x\0" + n, c));
        rejects(() -> identity.signAction("device_other", s)); rejects(() -> identity.forget("../arbitrary"));
        for (String field : new String[]{"deviceId", "hubPublicKey", "sessionHash", "targetDigest", "nonce"}) {
            JSONObject bad = new JSONObject(s.toString()).put(field, "bad\0value"); rejects(() -> identity.signAction(id, bad));
        }
        for (Object expiry : new Object[]{true, -1, 0, 1.5, 9007199254740992d, "123"}) {
            JSONObject bad = new JSONObject(s.toString()).put("expiresAt", expiry); rejects(() -> identity.signAction(id, bad));
        }
        rejects(() -> identity.signAction(id, new JSONObject(s.toString()).put("extra", true)));
        JSONObject bad = new JSONObject(s.toString()); bad.getJSONObject("action").put("target", "../device"); rejects(() -> identity.signAction(id, bad));
        identity.forget(id); rejects(() -> identity.signAction(id, s));
        check(memory.values.isEmpty() && memory.legacy.isEmpty(), "forget left identity data");
        for (String fault : new String[]{"write", "write-after", "readback", "delete"}) {
            Memory m = new Memory(); m.legacy.put(id, JSONObject.quote(encoded)); DeviceIdentity d = new DeviceIdentity(m);
            m.failAfterWrite = fault.equals("write-after"); m.writeFails = fault.equals("write"); m.corruptWrite = fault.equals("readback"); m.deleteFails = fault.equals("delete");
            rejects(() -> d.signAction(id, s)); check(m.legacy.containsKey(id), "failure removed old identity");
            if (fault.equals("delete") || fault.equals("write-after")) { m.deleteFails = false; m.failAfterWrite = false; check(new DeviceIdentity(m).signAction(id, s).equals(v.getString("signature")), "cleanup retry changed identity"); check(m.writes == 2, "retry skipped durable write"); }
        }
        memory.legacy.put(id, JSONObject.quote(encoded)); memory.values.put(id, Base64.toBase64String(new byte[32]));
        rejects(() -> identity.signAction(id, s)); check(memory.legacy.containsKey(id), "conflict deleted old identity"); identity.forget(id);
        for (String invalid : new String[]{"null", "123", "\"AA==\"", JSONObject.quote(encoded) + "garbage"}) {
            memory.legacy.put(id, invalid); rejects(() -> identity.signAction(id, s)); identity.forget(id);
        }
        check(!identity.getLock(), "new lock must be off"); memory.legacy.put("app-lock", "true");
        check(identity.getLock() && !memory.legacy.containsKey("app-lock"), "lock migration lost setting");
        identity.setLock(false); check(!new DeviceIdentity(memory).getLock(), "lock reset did not persist");
        memory.values.clear(); memory.legacy.put("app-lock", "1"); rejects(() -> identity.getLock()); memory.legacy.clear();
        JSONObject created = identity.create(); String createdId = created.getString("deviceId");
        check(created.length() == 3 && createdId.equals(created.getString("keyRef")), "created identity leaks extra fields");
        verify(created.getString("publicKey"), identity.sign(createdId, createdId, n, c), "tarocub/device/v1\0" + createdId + "\0" + n + "\0" + c);
        identity.forget(createdId);
        System.out.println("{\"platform\":\"Android JVM core\",\"checks\":" + checks + ",\"status\":\"passed\"}");
    }
}
