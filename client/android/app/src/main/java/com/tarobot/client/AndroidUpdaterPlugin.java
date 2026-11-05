package com.tarobot.client;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

@CapacitorPlugin(name = "TaroBotAndroidUpdater")
public final class AndroidUpdaterPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();
    private AndroidUpdateService service;
    @Override public void load() {
        service = new AndroidUpdateService(getContext(), BuildConfig.TAROBOT_UPDATE_REPOSITORY, BuildConfig.TAROBOT_UPDATE_CLIENT_ID,
            value -> notifyListeners("state", object(value)));
    }
    private static JSObject object(JSONObject value) { try { return new JSObject(value.toString()); } catch (Exception impossible) { return new JSObject(); } }
    private void failed(PluginCall call, Exception failure) { service.fail(failure); call.reject(service.snapshot().optString("error", "github_update_failed")); }
    @PluginMethod public void status(PluginCall call) {
        io.execute(() -> { try { service.load(); call.resolve(object(service.snapshot())); } catch (Exception failure) { failed(call, failure); } });
    }
    @PluginMethod public void cancel(PluginCall call) { service.cancel(); call.resolve(); }
    /** Fixed browser destination; the renderer cannot supply an arbitrary URL. */
    @PluginMethod public void openLogin(PluginCall call) {
        try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/login/device"))); call.resolve(); }
        catch (Exception failure) { call.reject("github_update_browser"); }
    }
    @PluginMethod public void invoke(PluginCall call) {
        String command = call.getString("command", "");
        if ("github_update_login_cancel".equals(command)) { service.cancelLogin(call.getString("flowId", "")); call.resolve(); return; }
        if (!busy.compareAndSet(false, true)) { call.reject("github_update_busy"); return; }
        io.execute(() -> {
            boolean awaitingActivity = false;
            try {
                if (!"github_update_logout".equals(command)) service.load(); JSONObject result;
                switch (command) {
                    case "github_update_login_start": result = service.startLogin(); break;
                    case "github_update_login_poll": result = service.pollLogin(call.getString("flowId", "")); break;
                    case "github_update_login_cancel": service.cancelLogin(call.getString("flowId", "")); result = service.snapshot(); break;
                    case "github_update_logout": service.logout(); result = service.snapshot(); break;
                    case "check": service.check(); result = service.snapshot(); break;
                    case "download": service.download(); result = service.snapshot(); break;
                    case "install":
                        service.verify(); service.state("install-pending");
                        getActivity().runOnUiThread(() -> launchInstaller(call, false)); awaitingActivity = true; return;
                    default: throw new IllegalArgumentException("github_update_invalid_offer");
                }
                call.resolve(object(result));
            } catch (Exception failure) { failed(call, failure); }
            finally { if (!awaitingActivity) busy.set(false); }
        });
    }
    private void launchInstaller(PluginCall call, boolean permissionReturned) {
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                if (permissionReturned) throw new IllegalStateException("github_update_permissions");
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())), "permissionReturned"); return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".updateprovider", service.apk());
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .putExtra(Intent.EXTRA_RETURN_RESULT, true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("TaroBird update", uri));
            startActivityForResult(call, intent, "installerReturned");
        } catch (Exception failure) { busy.set(false); failed(call, failure); }
    }
    @ActivityCallback private void permissionReturned(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        // Recheck bytes and signer after returning from Settings, before any grant.
        io.execute(() -> { try { service.verify(); getActivity().runOnUiThread(() -> launchInstaller(call, true)); }
            catch (Exception failure) { busy.set(false); failed(call, failure); } });
    }
    @ActivityCallback private void installerReturned(PluginCall call, ActivityResult result) {
        io.execute(() -> { try { service.returnedFromInstaller(); if (call != null) call.resolve(object(service.snapshot())); }
            catch (Exception failure) { if (call != null) failed(call, failure); else service.fail(failure); }
            finally { busy.set(false); } });
    }
    @Override protected void handleOnDestroy() { if (service != null) service.cancel(); io.shutdown(); }
}
