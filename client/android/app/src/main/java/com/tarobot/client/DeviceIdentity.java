package com.tarobot.client;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import org.bouncycastle.util.encoders.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.UUID;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.json.JSONException;

/** Native-only identity operations. Store implementations never cross the JS bridge. */
final class DeviceIdentity {
    interface Store {
        String read(String key, boolean legacy) throws Exception;
        void write(String key, String value) throws Exception;
        void remove(String key, boolean legacy) throws Exception;
    }
    private final Store store;
    DeviceIdentity(Store store) { this.store = store; }
    private static void require(boolean value, String error) { if (!value) throw new IllegalArgumentException(error); }
    static String key(String value) {
        require(value != null && value.matches("device_[A-Za-z0-9_]{1,121}"), "invalid_device_id"); return value;
    }
    private static byte[] seed(String encoded) {
        require(encoded != null, "device_key_unavailable");
        byte[] bytes;
        try { bytes = Base64.decode(encoded); } catch (Exception e) { throw new IllegalArgumentException("device_key_invalid"); }
        if (bytes.length != 32 || !Base64.toBase64String(bytes).equals(encoded)) {
            Arrays.fill(bytes, (byte) 0); throw new IllegalArgumentException("device_key_invalid");
        }
        return bytes;
    }
    private static Object legacyValue(String raw) throws JSONException {
        JSONTokener parser = new JSONTokener(raw); Object result = parser.nextValue();
        require(parser.nextClean() == 0, "device_storage_invalid"); return result;
    }
    private void save(String key, String value) throws Exception {
        store.write(key, value);
        require(value.equals(store.read(key, false)), "device_key_write_failed");
    }
    private void erase(String key, boolean legacy) throws Exception {
        store.remove(key, legacy);
        require(store.read(key, legacy) == null, "device_key_delete_failed");
    }
    private byte[] load(String id) throws Exception {
        key(id); String current = store.read(id, false), previous = store.read(id, true);
        if (previous != null) {
            Object decoded = legacyValue(previous);
            require(decoded instanceof String, "device_key_invalid");
            require(previous.equals(JSONObject.quote((String) decoded)), "device_storage_invalid");
            byte[] validated = seed((String) decoded); Arrays.fill(validated, (byte) 0);
            require(current == null || current.equals(decoded), "device_key_migration_conflict");
            current = (String) decoded; save(id, current);
            // Persist and read back first. Failed cleanup cannot produce a signature.
            erase(id, true);
        }
        return seed(current);
    }
    synchronized JSONObject create() throws Exception {
        String id = "device_" + UUID.randomUUID().toString().replace("-", "");
        byte[] seed = new byte[32]; new SecureRandom().nextBytes(seed);
        try {
            require(store.read(id, false) == null && store.read(id, true) == null, "device_key_exists");
            save(id, Base64.toBase64String(seed));
            byte[] spki = new byte[44];
            byte[] prefix = {0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
            System.arraycopy(prefix, 0, spki, 0, 12);
            System.arraycopy(new Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().getEncoded(), 0, spki, 12, 32);
            return new JSONObject().put("deviceId", id).put("keyRef", id).put("publicKey", Base64.toBase64String(spki));
        } finally { Arrays.fill(seed, (byte) 0); }
    }
    synchronized String sign(String keyRef, String deviceId, String nonce, String clientNonce) throws Exception {
        key(keyRef); require(keyRef.equals(deviceId), "device_key_unavailable");
        require(nonce != null && nonce.matches("[A-Za-z0-9_-]{32,128}") && clientNonce != null && clientNonce.matches("[A-Za-z0-9_-]{32,128}"), "invalid_device_challenge");
        return signProof(keyRef, "tarocub/device/v1\0" + deviceId + "\0" + nonce + "\0" + clientNonce);
    }
    synchronized String signAction(String keyRef, JSONObject statement) throws Exception {
        String proof = actionProof(statement); key(keyRef);
        require(keyRef.equals(statement.getString("deviceId")), "device_key_unavailable");
        return signProof(keyRef, proof);
    }
    private String signProof(String id, String proof) throws Exception {
        byte[] value = load(id);
        try {
            Ed25519Signer signer = new Ed25519Signer(); signer.init(true, new Ed25519PrivateKeyParameters(value, 0));
            byte[] bytes = proof.getBytes(StandardCharsets.UTF_8); signer.update(bytes, 0, bytes.length);
            return Base64.toBase64String(signer.generateSignature());
        } finally { Arrays.fill(value, (byte) 0); }
    }
    synchronized void forget(String keyRef) throws Exception {
        key(keyRef); erase(keyRef, true); erase(keyRef, false);
    }
    synchronized boolean getLock() throws Exception {
        String value = store.read("app-lock", false), old = store.read("app-lock", true);
        if (value == null && old != null) {
            require(legacyValue(old) instanceof Boolean, "invalid_app_lock_state");
            value = old; save("app-lock", value);
        }
        require(value == null || value.equals("true") || value.equals("false"), "invalid_app_lock_state");
        if (old != null) { save("app-lock", value); erase("app-lock", true); }
        return "true".equals(value);
    }
    synchronized void setLock(boolean enabled) throws Exception { save("app-lock", String.valueOf(enabled)); erase("app-lock", true); }
    private static String field(JSONObject object, String name, String regex) {
        Object value = object.opt(name); require(value instanceof String && ((String) value).matches(regex), "invalid_device_action"); return (String) value;
    }
    private static void fields(JSONObject object, String... names) {
        require(object != null, "invalid_device_action");
        HashSet<String> actual = new HashSet<>(); Iterator<String> keys = object.keys();
        while (keys.hasNext()) actual.add(keys.next());
        require(actual.equals(new HashSet<>(Arrays.asList(names))), "invalid_device_action");
    }
    static String actionProof(JSONObject s) {
        fields(s, "hubPublicKey", "deviceId", "sessionHash", "action", "targetDigest", "nonce", "expiresAt");
        String publicKey = field(s, "hubPublicKey", "[A-Za-z0-9+/]{59}=");
        byte[] spki = Base64.decode(publicKey);
        require(spki.length == 44 && Arrays.equals(Arrays.copyOf(spki, 12), new byte[]{0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0}), "invalid_device_action");
        String device = field(s, "deviceId", "[A-Za-z0-9_-]{1,128}"), hash = field(s, "sessionHash", "[a-f0-9]{64}");
        JSONObject action = s.optJSONObject("action"); fields(action, "operation", "target");
        String operation = field(action, "operation", "approve|revoke|network|bot-message-grant");
        String target = field(action, "target", operation.equals("approve") ? "[0-9]{8}" : (operation.equals("network") || operation.equals("bot-message-grant")) ? "[a-f0-9]{64}" : "[A-Za-z0-9_-]{1,128}");
        String digest = field(s, "targetDigest", "[a-f0-9]{64}"), nonce = field(s, "nonce", "[A-Za-z0-9_-]{43}");
        Object expires = s.opt("expiresAt"); require(expires instanceof Number, "invalid_device_action");
        double n = ((Number) expires).doubleValue();
        require(Double.isFinite(n) && n == Math.floor(n) && n > 0 && n <= 9007199254740991d, "invalid_device_action");
        // Every field is constrained to ASCII without quotes, slashes needing escaping, or control characters.
        return "[\"tarocub/device-action/v1\",\"" + publicKey + "\",\"" + device + "\",\"" + hash + "\",\"" + operation + "\",\"" + target + "\",\"" + digest + "\",\"" + nonce + "\"," + ((Number) expires).longValue() + "]";
    }
}
