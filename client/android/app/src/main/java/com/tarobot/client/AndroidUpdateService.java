package com.tarobot.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.FormBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/** Credentials, signed-package checks and transfer bytes never cross into JS. */
final class AndroidUpdateService {
    interface Changed { void changed(JSONObject value); }
    final Context context;
    private final String repo, clientId;
    private final DeviceKeyStore vault;
    private final SharedPreferences prefs;
    private final Changed changed;
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(5, TimeUnit.MINUTES).build();
    // A progressing APK download may legitimately outlast a small API call.
    // Preserve the injected client's interceptors, TLS, connect/read limits and
    // explicit cancellation; size/digest/package verification is unchanged.
    static OkHttpClient downloadClient(OkHttpClient source) { return source.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).build(); }
    private volatile Call active;
    private volatile boolean cancelled;
    private String phase = "initial", error, token, login;
    private JSONObject offer;
    private volatile JSONObject flow;
    private long received, nextPoll;
    private boolean loaded, verified;
    AndroidUpdateService(Context context, String repo, String clientId, Changed changed) {
        this.context = context; this.repo = repo; this.clientId = clientId; this.changed = changed;
        vault = new DeviceKeyStore(context); prefs = context.getSharedPreferences("tarobot_android_updates_v1", Context.MODE_PRIVATE);
    }
    private PackageInfo installed() throws Exception { return context.getPackageManager().getPackageInfo(context.getPackageName(), flags()); }
    private static int flags() { return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES; }
    private static long code(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private static String[] signers(PackageInfo info) {
        Signature[] values = Build.VERSION.SDK_INT >= 28 ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        if (values == null) return new String[0]; String[] result = new String[values.length];
        for (int i = 0; i < values.length; i++) result[i] = values[i].toCharsString(); return result;
    }
    private File directory() throws IOException { File dir = new File(context.getCacheDir(), "tarobot-updates"); if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("github_update_install"); return dir; }
    File apk() throws IOException { return new File(directory(), "update.apk"); }
    private File partial() throws IOException { return new File(directory(), "update.part"); }
    synchronized JSONObject snapshot() {
        JSONObject out = new JSONObject();
        try {
            out.put("phase", phase).put("configured", AndroidUpdatePolicy.configured(repo, clientId)).put("version", installed().versionName).put("authenticated", token != null).put("bytes", received).put("downloaded", verified);
            if (login != null) out.put("login", login); if (error != null) out.put("error", error);
            if (offer != null) out.put("nextVersion", offer.getString("version")).put("notes", offer.optString("notes")).put("total", offer.getLong("size"));
        } catch (Exception ignored) { try { out.put("error", "github_update_failed"); } catch (Exception impossible) { /* JSONObject literals */ } }
        return out;
    }
    synchronized void state(String next) { phase = next; error = null; changed.changed(snapshot()); }
    synchronized void fail(Exception failure) {
        String value = failure.getMessage();
        error = value != null && value.matches("github_update_(login_required|denied|expired|network|configuration|repo_unavailable|signature|invalid_offer|cancelled|response|manifest|keychain|install|busy|bounds|failed|permissions)") ? value : "github_update_failed";
        if ("github_update_login_required".equals(error)) { token = null; login = null; }
        phase = "error"; changed.changed(snapshot());
    }
    void load() throws Exception {
        if (loaded) return;
        String raw;
        try { raw = vault.read("android-updates-github", false); } catch (Exception failure) { throw new IOException("github_update_keychain"); }
        if (raw != null) { JSONObject saved = new JSONObject(raw); token = saved.getString("token"); login = saved.getString("login"); }
        loaded = true;
        raw = prefs.getString("offer", null);
        if (raw != null) {
            try {
                offer = new JSONObject(raw);
                if (AndroidUpdatePolicy.compare(offer.getString("version"), installed().versionName) <= 0) { clearDownload(); offer = null; }
                else if (apk().isFile()) { verify(); state("ready"); return; }
            } catch (Exception invalid) { clearDownload(); offer = null; }
        }
        state(!AndroidUpdatePolicy.configured(repo, clientId) ? "disabled" : "initial");
    }
    private String credential() throws IOException { if (token == null) throw new IOException("github_update_login_required"); return token; }
    private String request(Request request, boolean authenticated) throws Exception {
        active = http.newCall(request);
        try (Response response = active.execute()) {
            if (authenticated && response.code() == 401) { token = null; login = null; vault.remove("android-updates-github", false); throw new IOException("github_update_login_required"); }
            if (authenticated && (response.code() == 403 || response.code() == 404)) throw new IOException("github_update_repo_unavailable");
            if (!response.isSuccessful() || response.body() == null) throw new IOException("github_update_network");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n;
            try (var in = response.body().byteStream()) { while ((n = in.read(buffer)) != -1) { if (bytes.size() + n > 3 * 1024 * 1024) throw new IOException("github_update_bounds"); bytes.write(buffer, 0, n); } }
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        } finally { active = null; }
    }
    private Request.Builder api(String url, String secret) {
        return new Request.Builder().url(url).header("User-Agent", "TaroBot-Android-Updater").header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28").header("Authorization", "Bearer " + secret);
    }
    private JSONObject oauth(String endpoint, FormBody body) throws Exception {
        return new JSONObject(request(new Request.Builder().url("https://github.com/login/" + endpoint).header("Accept", "application/json").header("User-Agent", "TaroBot-Android-Updater").post(body).build(), false));
    }
    JSONObject startLogin() throws Exception {
        if (!AndroidUpdatePolicy.configured(repo, clientId)) throw new IOException("github_update_configuration");
        flow = null;
        JSONObject result = oauth("device/code", new FormBody.Builder().add("client_id", clientId).add("scope", "repo").build());
        String device = result.getString("device_code"), user = result.getString("user_code"), uri = result.getString("verification_uri");
        int expires = result.getInt("expires_in"), interval = result.getInt("interval");
        if (!"https://github.com/login/device".equals(uri) || device.length() > 1024 || !user.matches("[A-Za-z0-9-]{4,32}") || expires < 1 || expires > 1800 || interval < 1 || interval > 120) throw new IOException("github_update_response");
        flow = new JSONObject().put("id", UUID.randomUUID().toString()).put("code", device).put("expires", System.currentTimeMillis() + expires * 1000L).put("interval", interval);
        nextPoll = System.currentTimeMillis() + interval * 1000L;
        return new JSONObject().put("flowId", flow.getString("id")).put("userCode", user).put("verificationUri", uri).put("expiresIn", expires).put("interval", interval);
    }
    void cancelLogin(String id) { if (flow != null && flow.optString("id").equals(id)) flow = null; }
    JSONObject pollLogin(String id) throws Exception {
        JSONObject attempt = flow;
        if (attempt == null || !attempt.getString("id").equals(id)) throw new IOException("github_update_expired");
        if (System.currentTimeMillis() >= attempt.getLong("expires")) { flow = null; throw new IOException("github_update_expired"); }
        int interval = attempt.getInt("interval");
        if (System.currentTimeMillis() < nextPoll) return new JSONObject().put("status", "pending").put("interval", interval);
        JSONObject result = oauth("oauth/access_token", new FormBody.Builder().add("client_id", clientId).add("device_code", attempt.getString("code")).add("grant_type", "urn:ietf:params:oauth:grant-type:device_code").build());
        if (flow != attempt) throw new IOException("github_update_cancelled");
        String problem = result.optString("error");
        if ("authorization_pending".equals(problem) || "slow_down".equals(problem)) {
            if ("slow_down".equals(problem)) { interval = Math.min(300, interval + 5); attempt.put("interval", interval); }
            nextPoll = System.currentTimeMillis() + interval * 1000L;
            return new JSONObject().put("status", "pending").put("interval", interval);
        }
        if (!problem.isEmpty()) { flow = null; throw new IOException("access_denied".equals(problem) ? "github_update_denied" : "github_update_expired"); }
        String secret = result.getString("access_token");
        if (!secret.matches("[A-Za-z0-9_]{10,1024}") || !"bearer".equalsIgnoreCase(result.optString("token_type"))) throw new IOException("github_update_response");
        JSONObject user = new JSONObject(request(api("https://api.github.com/user", secret).build(), true));
        String name = user.getString("login"); if (!name.matches("[A-Za-z0-9-]{1,100}")) throw new IOException("github_update_response");
        if (flow != attempt) throw new IOException("github_update_cancelled");
        try { vault.write("android-updates-github", new JSONObject().put("token", secret).put("login", name).toString()); } catch (Exception failure) { throw new IOException("github_update_keychain"); }
        token = secret; login = name; flow = null; state("initial"); return new JSONObject().put("status", "authorized");
    }
    void logout() throws Exception {
        flow = null; token = null; login = null;
        try { vault.remove("android-updates-github", false); } catch (Exception failure) { throw new IOException("github_update_keychain"); }
        clearDownload(); offer = null; state("initial");
    }
    void check() throws Exception {
        load(); if (!AndroidUpdatePolicy.configured(repo, clientId)) { state("disabled"); return; }
        if (token == null) { state("login-required"); return; }
        state("checking"); JSONArray all = new JSONArray();
        for (int page = 1; page <= 3; page++) {
            JSONArray batch = new JSONArray(request(api("https://api.github.com/repos/" + repo + "/releases?per_page=100&page=" + page, credential()).build(), true));
            for (int i = 0; i < batch.length(); i++) all.put(batch.get(i));
            if (batch.length() < 100) break;
        }
        JSONObject next = AndroidUpdatePolicy.select(all, installed().versionName, repo);
        if (next == null) { clearDownload(); offer = null; state("current"); return; }
        boolean same = offer != null && offer.optString("sha256").equals(next.getString("sha256")) && offer.optLong("assetId") == next.getLong("assetId");
        if (!same) clearDownload(); offer = next;
        if (same && apk().isFile()) { verify(); state("ready"); } else state("available");
    }
    void cancel() { cancelled = true; Call call = active; if (call != null) call.cancel(); }
    void download() throws Exception {
        if (offer == null || !("available".equals(phase) || "error".equals(phase))) throw new IOException("github_update_invalid_offer");
        cancelled = false; received = 0; verified = false; state("downloading");
        File part = partial();
        try {
            String url = offer.getString("url"), secret = credential(); Response response = null;
            for (int hop = 0; hop < 6; hop++) {
                if (cancelled) throw new IOException("github_update_cancelled");
                Request request = hop == 0 ? api(url, secret).header("Accept", "application/octet-stream").build() : new Request.Builder().url(url).header("User-Agent", "TaroBot-Android-Updater").build();
                active = downloadClient(http).newCall(request); response = active.execute();
                if (response.code() >= 300 && response.code() < 400) {
                    String redirect = response.header("Location"); response.close(); response = null;
                    if (redirect == null || !AndroidUpdatePolicy.assetRedirect(redirect)) throw new IOException("github_update_response"); url = redirect; continue;
                }
                break;
            }
            if (response == null) throw new IOException("github_update_response");
            try (Response body = response) {
                if (body.code() == 401) throw new IOException("github_update_login_required");
                if (!body.isSuccessful() || body.body() == null) throw new IOException("github_update_network");
                long expected = offer.getLong("size");
                if (body.body().contentLength() > expected) throw new IOException("github_update_bounds");
                try (var in = body.body().byteStream(); var out = new FileOutputStream(part)) {
                    byte[] bytes = new byte[65536]; int count; long last = 0;
                    while ((count = in.read(bytes)) != -1) {
                        if (cancelled) throw new IOException("github_update_cancelled"); received += count;
                        if (received > expected || received > AndroidUpdatePolicy.MAX_APK) throw new IOException("github_update_bounds");
                        out.write(bytes, 0, count);
                        if (System.currentTimeMillis() - last > 150) { changed.changed(snapshot()); last = System.currentTimeMillis(); }
                    }
                    out.getFD().sync();
                }
            }
            if (cancelled) throw new IOException("github_update_cancelled");
            if (apk().exists() && !apk().delete() || !part.renameTo(apk())) throw new IOException("github_update_install");
            state("verifying"); verify();
            if (!prefs.edit().putString("offer", offer.toString()).commit()) throw new IOException("github_update_install");
            state("ready");
        } catch (Exception failure) { verified = false; part.delete(); apk().delete(); throw new IOException(cancelled ? "github_update_cancelled" : failure.getMessage()); }
        finally { active = null; }
    }
    void verify() throws Exception {
        verified = false;
        if (offer == null || !apk().isFile() || apk().length() != offer.getLong("size")) throw new IOException("github_update_signature");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var in = new FileInputStream(apk())) { byte[] buffer = new byte[65536]; int n; while ((n = in.read(buffer)) != -1) digest.update(buffer, 0, n); }
        StringBuilder hash = new StringBuilder(); for (byte value : digest.digest()) hash.append(String.format("%02x", value));
        if (!hash.toString().equals(offer.getString("sha256"))) throw new IOException("github_update_signature");
        PackageInfo target = context.getPackageManager().getPackageArchiveInfo(apk().getAbsolutePath(), flags()), current = installed();
        if (target == null) throw new IOException("github_update_signature");
        AndroidUpdatePolicy.verifyPackage(target.packageName, current.packageName, target.versionName, offer.getString("version"), code(target), code(current), signers(target), signers(current));
        verified = true;
    }
    void returnedFromInstaller() throws Exception {
        // RESULT_OK alone is not proof of installation. Usually self-update
        // terminates this process; next launch reads the installed version.
        if (offer != null && AndroidUpdatePolicy.compare(installed().versionName, offer.getString("version")) >= 0) { clearDownload(); offer = null; state("current"); }
        else { verify(); state("ready"); }
    }
    private void clearDownload() throws Exception { verified = false; apk().delete(); partial().delete(); if (!prefs.edit().remove("offer").commit()) throw new IOException("github_update_install"); }
}
