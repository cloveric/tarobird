package com.tarobot.client;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONObject;

/** Persisted logical registrations. Connector callback IDs are generation-specific,
 * so a late callback cannot revive an unregistered/recreated host. No Android API
 * dependencies: the same production state machine is exercised by JVM tests. */
final class UnifiedPushRegistry {
    interface Storage { String read(); JSONObject legacy() throws Exception; boolean commit(String value); }
    private final Storage storage;
    UnifiedPushRegistry(Storage storage) { this.storage = storage; }
    static String instance(String host, String device) throws Exception {
        if (host == null || !host.matches("hub_[0-9a-f]{64}") || device == null || !device.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException("unifiedpush_identity_invalid");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(("[\"" + host + "\",\"" + device + "\"]").getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder("up_"); for (byte part : digest) value.append(String.format("%02x", part & 255)); return value.toString();
    }
    private JSONObject load() throws Exception {
        String saved = storage.read();
        if (saved != null) { JSONObject root = new JSONObject(saved); if (root.getInt("version") != 2) throw new IllegalStateException("unifiedpush_storage_invalid"); root.getJSONObject("records"); return root; }
        JSONObject records = new JSONObject(), old = storage.legacy();
        if (old != null && !old.optString("deviceId").isEmpty()) records.put("legacy", old);
        return new JSONObject().put("version", 2).put("records", records);
    }
    private void save(JSONObject root) { if (!storage.commit(root.toString())) throw new IllegalStateException("unifiedpush_storage_failed"); }
    private JSONObject bind(JSONObject root, String key, String host, String device, boolean legacy) throws Exception {
        if (!instance(host, device).equals(key)) throw new IllegalArgumentException("unifiedpush_identity_invalid");
        JSONObject records = root.getJSONObject("records"), item = records.optJSONObject(key), old = records.optJSONObject("legacy");
        // Only the original single-host cache may claim the original device ID.
        if (item == null && legacy && old != null && device.equals(old.optString("deviceId"))) {
            records.remove("legacy"); item = old.put("instance", key).put("hostId", host); records.put(key, item); save(root);
        }
        if (item != null && (!host.equals(item.optString("hostId")) || !device.equals(item.optString("deviceId")))) throw new IllegalStateException("unifiedpush_identity_conflict");
        return item;
    }
    synchronized JSONObject state(String key, String host, String device, boolean legacy) throws Exception {
        JSONObject root = load(), item = bind(root, key, host, device, legacy);
        JSONObject result = item == null ? new JSONObject() : new JSONObject(item.toString());
        result.put("schemaVersion", 2).put("instance", key).put("hostId", host).put("deviceId", device);
        result.put("registrationCount", root.getJSONObject("records").length());
        if ("removing".equals(result.optString("phase"))) { result.remove("endpoint"); result.remove("keys"); result.put("error", "unifiedpush_removal_pending"); }
        return result;
    }
    synchronized JSONObject prepare(String key, String host, String device, boolean legacy, String distributor) throws Exception {
        if (distributor == null || distributor.isEmpty()) throw new IllegalArgumentException("unifiedpush_distributor_unavailable");
        JSONObject root = load(), records = root.getJSONObject("records"), item = bind(root, key, host, device, legacy);
        for (String id : keys(records)) if (!distributor.equals(records.getJSONObject(id).optString("distributor"))) throw new IllegalStateException("unifiedpush_distributor_in_use");
        if (item != null && "removing".equals(item.optString("phase"))) throw new IllegalStateException("unifiedpush_removal_pending");
        if (item == null) item = new JSONObject().put("instance", key).put("hostId", host).put("deviceId", device).put("registrationId", "up_" + UUID.randomUUID().toString().replace("-", "")).put("distributor", distributor).put("phase", "active").put("confirmed", false);
        item.remove("error"); records.put(key, item); save(root); return new JSONObject(item.toString());
    }
    synchronized JSONObject callback(String registration) throws Exception {
        JSONObject records = load().getJSONObject("records");
        for (String key : keys(records)) { JSONObject item = records.getJSONObject(key); if (registration.equals(item.optString("registrationId")) && !"removing".equals(item.optString("phase"))) return new JSONObject(item.toString()); }
        return null;
    }
    synchronized JSONObject endpoint(String registration, String endpoint, String publicKey, String auth) throws Exception {
        JSONObject item = callback(registration); if (item == null) return null;
        try {
            URI url = new URI(endpoint);
            if (!"https".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null || url.getFragment() != null || endpoint.length() > 4096 || publicKey == null || !publicKey.matches("[A-Za-z0-9_=-]{80,128}") || auth == null || !auth.matches("[A-Za-z0-9_=-]{16,64}")) throw new IllegalArgumentException();
            item.put("endpoint", endpoint).put("keys", new JSONObject().put("p256dh", publicKey).put("auth", auth)); item.remove("error");
        } catch (Exception invalid) { item.remove("endpoint"); item.remove("keys"); item.put("error", "unifiedpush_endpoint_invalid"); }
        update(item); return item;
    }
    synchronized JSONObject failure(String registration, String error) throws Exception {
        JSONObject item = callback(registration); if (item == null) return null;
        item.remove("endpoint"); item.remove("keys"); item.put("error", error); update(item); return item;
    }
    synchronized void confirm(String key, String registration, String endpoint) throws Exception {
        JSONObject item = load().getJSONObject("records").optJSONObject(key);
        if (item == null || !"active".equals(item.optString("phase")) || !registration.equals(item.optString("registrationId")) || !endpoint.equals(item.optString("endpoint"))) throw new IllegalStateException("unifiedpush_registration_changed");
        item.put("confirmed", true); update(item);
    }
    /** Empty host is the pre-migration legacy route; never trust a payload to
     * invent its scope. The app resolves such links only with one known host. */
    synchronized String notificationHost(String registration, String claimed) throws Exception {
        JSONObject item = callback(registration); if (item == null) return null;
        String host = item.optString("hostId");
        if (host.isEmpty()) return "legacy".equals(item.optString("instance")) ? "" : null;
        return claimed == null || host.equals(claimed) ? host : null;
    }
    private void update(JSONObject item) throws Exception { JSONObject root = load(); root.getJSONObject("records").put(item.getString("instance"), item); save(root); }
    synchronized String beginRemoval(String key, boolean remote) throws Exception {
        JSONObject root = load(), item = root.getJSONObject("records").optJSONObject(key); if (item == null) return null;
        item.put("phase", "removing").put("remoteRemoval", remote || item.optBoolean("remoteRemoval", false)); save(root); return item.getString("registrationId");
    }
    synchronized void finishRemoval(String key, String registration) throws Exception {
        JSONObject root = load(), records = root.getJSONObject("records"), item = records.optJSONObject(key);
        if (item == null) return;
        if (!registration.equals(item.optString("registrationId")) || !"removing".equals(item.optString("phase"))) throw new IllegalStateException("unifiedpush_removal_conflict");
        records.remove(key); save(root);
    }
    synchronized List<String> instances() throws Exception { return keys(load().getJSONObject("records")); }
    private static List<String> keys(JSONObject object) { List<String> result = new ArrayList<>(); object.keys().forEachRemaining(result::add); return result; }
}
