package com.tarobot.client;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;
import org.unifiedpush.android.connector.data.PublicKeySet;

public class TaroCubUnifiedPushService extends PushService {
    @Override public void onNewEndpoint(PushEndpoint endpoint, String registration) {
        try { synchronized (UnifiedPushPlugin.store(this)) {
            PublicKeySet keys = endpoint.getPubKeySet();
            UnifiedPushPlugin.changed(UnifiedPushPlugin.store(this).endpoint(registration, endpoint.getUrl(), keys == null ? null : keys.getPubKey(), keys == null ? null : keys.getAuth()));
        } } catch (Exception ignored) { /* No receipt if durable storage failed; refresh retries. */ }
    }
    @Override public void onMessage(PushMessage message, String registration) {
        if (!message.getDecrypted() || message.getContent().length > 8192) return;
        try { synchronized (UnifiedPushPlugin.store(this)) {
            JSONObject json = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            // An endpoint is bound to its Hub. Payloads cannot navigate another Hub.
            String host = UnifiedPushPlugin.store(this).notificationHost(registration, json.has("hostId") ? json.getString("hostId") : null);
            if (host == null) return;
            Map<String, String> data = new HashMap<>();
            for (String key : new String[]{"id", "conversationId", "messageId", "kind", "body"}) data.put(key, json.optString(key, ""));
            if (!host.isEmpty()) data.put("hostId", host);
            TaroCubNotifications.show(this, data);
        } } catch (Exception ignored) { /* Invalid notifications never reach app navigation. */ }
    }
    @Override public void onRegistrationFailed(FailedReason reason, String registration) { failed(registration, "unifiedpush_registration_failed"); }
    @Override public void onUnregistered(String registration) { failed(registration, "unifiedpush_unregistered"); }
    private void failed(String registration, String error) {
        try { synchronized (UnifiedPushPlugin.store(this)) { UnifiedPushPlugin.changed(UnifiedPushPlugin.store(this).failure(registration, error)); } } catch (Exception ignored) { /* Retain last durable state; refresh retries. */ }
    }
}
