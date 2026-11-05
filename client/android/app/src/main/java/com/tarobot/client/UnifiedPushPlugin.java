package com.tarobot.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import org.unifiedpush.android.connector.UnifiedPush;

@CapacitorPlugin(name = "TaroCubUnifiedPush")
public class UnifiedPushPlugin extends Plugin {
    private final FirebaseTokenOperations.Owner firebaseOwner = new FirebaseTokenOperations.Owner();
    private static final Handler firebaseTimer = new Handler(Looper.getMainLooper());
    private static boolean firebaseConfigured() {
        try { FirebaseApp.getInstance(); return true; } catch (IllegalStateException missing) { return false; }
    }
    // Process-wide: Firebase tokens are shared by all hosts and Activity instances.
    private static final FirebaseTokenOperations firebase = new FirebaseTokenOperations(new FirebaseTokenOperations.Backend() {
        public void autoInit(boolean enabled) { if (firebaseConfigured()) FirebaseMessaging.getInstance().setAutoInitEnabled(enabled); }
        public void token(FirebaseTokenOperations.Completion completion) {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> completion.done(task.isSuccessful() ? task.getResult() : null, task.isSuccessful() ? null : "firebase_registration_failed"));
        }
        public void delete(FirebaseTokenOperations.Completion completion) {
            if (!firebaseConfigured()) { completion.done(null, null); return; }
            FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(task -> completion.done(null, task.isSuccessful() ? null : "firebase_unregister_failed"));
        }
    }, (millis, callback) -> { firebaseTimer.postDelayed(callback, millis); return () -> firebaseTimer.removeCallbacks(callback); });
    private FirebaseTokenOperations.Reply firebaseReply(PluginCall call, boolean token) {
        return new FirebaseTokenOperations.Reply() {
            public void success(String value) { if (token) { JSObject result = new JSObject(); result.put("token", value); call.resolve(result); } else call.resolve(); }
            public void failure(String code) { call.reject(code, code); }
        };
    }
    private static WeakReference<UnifiedPushPlugin> active = new WeakReference<>(null);
    private static UnifiedPushRegistry registry;
    static synchronized UnifiedPushRegistry store(Context context) {
        if (registry == null) {
            Context app = context.getApplicationContext();
            SharedPreferences saved = app.getSharedPreferences("tarocub-unifiedpush", Context.MODE_PRIVATE);
            registry = new UnifiedPushRegistry(new UnifiedPushRegistry.Storage() {
                public String read() { return saved.getString("registrations-v2", null); }
                public org.json.JSONObject legacy() throws Exception {
                    String instance = saved.getString("instance", ""); if (instance.isEmpty()) return null;
                    org.json.JSONObject item = new org.json.JSONObject().put("instance", "legacy").put("deviceId", instance).put("registrationId", instance).put("phase", "active").put("confirmed", true).put("distributor", UnifiedPush.getSavedDistributor(app));
                    for (String field : new String[]{"endpoint", "error"}) if (!saved.getString(field, "").isEmpty()) item.put(field, saved.getString(field, ""));
                    if (!saved.getString("p256dh", "").isEmpty()) item.put("keys", new org.json.JSONObject().put("p256dh", saved.getString("p256dh", "")).put("auth", saved.getString("auth", "")));
                    return item;
                }
                public boolean commit(String value) { return saved.edit().putString("registrations-v2", value).remove("instance").remove("endpoint").remove("error").remove("p256dh").remove("auth").commit(); }
            });
        }
        return registry;
    }
    static void changed(org.json.JSONObject item) throws Exception {
        UnifiedPushPlugin plugin = active.get(); if (plugin != null && item != null) { JSObject event = new JSObject(item.toString()); event.put("schemaVersion", 2); plugin.notifyListeners("registrationChanged", event); }
    }
    private JSObject snapshot(PluginCall call) throws Exception {
        JSObject result = new JSObject(store(getContext()).state(call.getString("instance"), call.getString("hostId"), call.getString("deviceId"), Boolean.TRUE.equals(call.getBoolean("migrateLegacy", false))).toString());
        result.put("sharedDistributor", UnifiedPush.getSavedDistributor(getContext())); return result;
    }
    private void reject(PluginCall call, Exception error) {
        String reason = error.getMessage(); call.reject(reason != null && reason.matches("unifiedpush_[a-z_]+") ? reason : "unifiedpush_operation_failed");
    }
    @Override public void load() { active = new WeakReference<>(this); }
    @Override protected void handleOnDestroy() { firebase.abandon(firebaseOwner); if (active.get() == this) active.clear(); }
    @PluginMethod public void state(PluginCall call) { try { synchronized (store(getContext())) { call.resolve(snapshot(call)); } } catch (Exception error) { reject(call, error); } }
    /** Read only: never creates a channel, registers a token or prompts. */
    @PluginMethod public void notificationStatus(PluginCall call) {
        try {
            call.resolve(MessageNotificationChannel.status(getContext()));
        } catch (Exception error) { call.reject("notification_status_unavailable"); }
    }
    /** Explicit user action; opening settings does not change any channel. */
    @PluginMethod public void openNotificationSettings(PluginCall call) {
        try {
            try { getContext().startActivity(MessageNotificationChannel.settingsIntent(getContext()).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (android.content.ActivityNotFoundException unsupported) {
                getContext().startActivity(MessageNotificationChannel.appSettingsIntent(getContext()).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            }
            call.resolve();
        } catch (Exception error) { call.reject("notification_settings_unavailable"); }
    }
    @PluginMethod public void distributors(PluginCall call) {
        JSArray list = new JSArray();
        for (String id : UnifiedPush.getDistributors(getContext())) {
            String name = id;
            try { name = getContext().getPackageManager().getApplicationLabel(getContext().getPackageManager().getApplicationInfo(id, 0)).toString(); } catch (Exception ignored) {}
            JSObject value = new JSObject(); value.put("id", id); value.put("name", name); list.put(value);
        }
        JSObject result = new JSObject(); result.put("distributors", list); call.resolve(result);
    }
    @PluginMethod public void register(PluginCall call) {
        String distributor = call.getString("distributor");
        if (distributor == null || !UnifiedPush.getDistributors(getContext()).contains(distributor)) { call.reject("unifiedpush_distributor_unavailable"); return; }
        try { synchronized (store(getContext())) {
            org.json.JSONObject item = store(getContext()).prepare(call.getString("instance"), call.getString("hostId"), call.getString("deviceId"), Boolean.TRUE.equals(call.getBoolean("migrateLegacy", false)), distributor);
            if (!distributor.equals(UnifiedPush.getSavedDistributor(getContext()))) UnifiedPush.saveDistributor(getContext(), distributor);
            UnifiedPush.register(getContext(), item.getString("registrationId"), "TaroBird", null);
            call.resolve(snapshot(call));
        } } catch (Exception error) { reject(call, error); }
    }
    @PluginMethod public void refresh(PluginCall call) {
        try { synchronized (store(getContext())) {
            JSObject item = snapshot(call);
            if (item.has("registrationId") && !"removing".equals(item.optString("phase")) && UnifiedPush.getAckDistributor(getContext()) != null) UnifiedPush.register(getContext(), item.getString("registrationId"), "TaroBird", null);
            call.resolve(snapshot(call));
        } } catch (Exception error) { reject(call, error); }
    }
    @PluginMethod public void confirmRegistration(PluginCall call) {
        try { synchronized (store(getContext())) {
            snapshot(call);
            store(getContext()).confirm(call.getString("instance"), call.getString("registrationId"), call.getString("endpoint"));
            call.resolve();
        } } catch (Exception error) { reject(call, error); }
    }
    private void remove(String instance) throws Exception {
        if (instance == null || !instance.matches("up_[0-9a-f]{64}|legacy")) throw new IllegalArgumentException("unifiedpush_identity_invalid");
        String registration = store(getContext()).beginRemoval(instance, false); if (registration == null) return;
        UnifiedPush.unregister(getContext(), registration);
        store(getContext()).finishRemoval(instance, registration);
        changed(new org.json.JSONObject().put("instance", instance).put("registrationId", registration).put("phase", "removed"));
    }
    @PluginMethod public void beginUnregister(PluginCall call) {
        try { synchronized (store(getContext())) {
            snapshot(call); // Bind eligible legacy records before retiring them.
            store(getContext()).beginRemoval(call.getString("instance"), Boolean.TRUE.equals(call.getBoolean("remoteRemoval", true)));
            call.resolve(snapshot(call));
        } } catch (Exception error) { reject(call, error); }
    }
    @PluginMethod public void finishUnregister(PluginCall call) {
        try { synchronized (store(getContext())) {
            JSObject current = snapshot(call);
            String registration = call.getString("registrationId");
            if (registration == null || !registration.equals(current.optString("registrationId")) || !"removing".equals(current.optString("phase"))) throw new IllegalStateException("unifiedpush_removal_conflict");
            UnifiedPush.unregister(getContext(), registration);
            store(getContext()).finishRemoval(call.getString("instance"), registration);
            changed(new org.json.JSONObject().put("instance", call.getString("instance")).put("registrationId", registration).put("phase", "removed")); call.resolve();
        } } catch (Exception error) { reject(call, error); }
    }
    @PluginMethod public void unregister(PluginCall call) {
        try { synchronized (store(getContext())) { remove(call.getString("instance")); call.resolve(); } } catch (Exception error) { reject(call, error); }
    }
    // Only the legacy whole-device reset uses this API. Per-host removal must name its instance.
    @PluginMethod public void unregisterAll(PluginCall call) {
        try { synchronized (store(getContext())) { for (String instance : store(getContext()).instances()) remove(instance); call.resolve(); } } catch (Exception error) { reject(call, error); }
    }
    // One request-bound result; never consume a retained registration broadcast.
    @PluginMethod public void registerFirebase(PluginCall call) {
        if (!firebaseConfigured()) { call.reject("firebase_not_configured", "firebase_not_configured"); return; }
        firebase.register(firebaseOwner, firebaseReply(call, true));
    }
    // Wait for real getToken completion before deletion, even after a UI timeout.
    @PluginMethod public void clearFirebase(PluginCall call) {
        firebase.clear(firebaseOwner, firebaseReply(call, false));
    }
}
