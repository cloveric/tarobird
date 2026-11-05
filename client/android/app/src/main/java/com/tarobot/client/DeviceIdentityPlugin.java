package com.tarobot.client;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TaroCubDeviceIdentity")
public final class DeviceIdentityPlugin extends Plugin {
    private DeviceIdentity identity;
    @Override public void load() { identity = new DeviceIdentity(new DeviceKeyStore(getContext())); }
    private interface Operation { JSObject run() throws Exception; }
    private void perform(PluginCall call, Operation operation) {
        try { if (identity == null) throw new IllegalStateException(); call.resolve(operation.run()); }
        catch (Exception error) {
            String message = error.getMessage();
            // Never return raw storage/crypto exceptions, which may contain input.
            call.reject(message != null && message.matches("(?:device_[a-z_]+|invalid_device_[a-z_]+|invalid_app_lock_state)") ? message : "device_storage_failed");
        }
    }
    @PluginMethod public void create(PluginCall call) { perform(call, () -> JSObject.fromJSONObject(identity.create())); }
    @PluginMethod public void sign(PluginCall call) { perform(call, () -> new JSObject().put("signature", identity.sign(call.getString("keyRef"), call.getString("deviceId"), call.getString("nonce"), call.getString("clientNonce")))); }
    @PluginMethod public void signAction(PluginCall call) { perform(call, () -> new JSObject().put("signature", identity.signAction(call.getString("keyRef"), call.getObject("statement")))); }
    @PluginMethod public void forget(PluginCall call) { perform(call, () -> { identity.forget(call.getString("keyRef")); return new JSObject(); }); }
    @PluginMethod public void getLock(PluginCall call) { perform(call, () -> new JSObject().put("enabled", identity.getLock())); }
    @PluginMethod public void setLock(PluginCall call) {
        perform(call, () -> {
            Object value = call.getData().opt("enabled");
            if (!(value instanceof Boolean)) throw new IllegalArgumentException("invalid_app_lock_state");
            identity.setLock((Boolean) value); return new JSObject();
        });
    }
}
