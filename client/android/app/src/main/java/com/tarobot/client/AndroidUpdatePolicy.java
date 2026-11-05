package com.tarobot.client;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Pure release/identity policy, shared by discovery and the install gate. */
final class AndroidUpdatePolicy {
    static final long MAX_APK = 256L * 1024 * 1024;
    static final String PREFIX = "android-tarobot-v";
    static boolean configured(String repo, String client) {
        return repo.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+") && client.matches("[A-Za-z0-9._-]{8,128}");
    }
    static int compare(String a, String b) {
        if (!a.matches("[0-9]{1,8}\\.[0-9]{1,8}\\.[0-9]{1,8}") || !b.matches("[0-9]{1,8}\\.[0-9]{1,8}\\.[0-9]{1,8}")) throw new IllegalArgumentException("github_update_manifest");
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < 3; i++) { int diff = Integer.compare(Integer.parseInt(x[i]), Integer.parseInt(y[i])); if (diff != 0) return diff; }
        return 0;
    }
    static JSONObject select(JSONArray releases, String current, String repo) throws Exception {
        JSONObject best = null; String version = current;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.getJSONObject(i); String tag = release.optString("tag_name");
            if (release.optBoolean("draft", true) || release.optBoolean("prerelease", true) || !tag.matches("android-tarobot-v[0-9]{1,8}\\.[0-9]{1,8}\\.[0-9]{1,8}")) continue;
            String next = tag.substring(PREFIX.length());
            if (compare(next, version) > 0) { version = next; best = release; }
        }
        if (best == null) return null;
        JSONArray assets = best.getJSONArray("assets"); JSONObject canonical = null, legacy = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            String name = asset.optString("name");
            if (name.equals("TaroBird_" + version + "_android.apk")) {
                if (canonical != null) throw new IllegalArgumentException("github_update_manifest");
                canonical = asset;
            } else if (name.equals("TaroBot-" + version + "-android.apk")) {
                if (legacy != null) throw new IllegalArgumentException("github_update_manifest");
                legacy = asset;
            }
        }
        // Validate the preferred artifact below; an invalid renamed APK must
        // never silently fall back to a second asset with the legacy name.
        JSONObject selected = canonical != null ? canonical : legacy;
        if (selected == null) throw new IllegalArgumentException("github_update_manifest");
        long id = selected.getLong("id"), size = selected.getLong("size");
        String digest = selected.optString("digest"), url = "https://api.github.com/repos/" + repo + "/releases/assets/" + id;
        if (id <= 0 || size <= 0 || size > MAX_APK || !digest.matches("sha256:[a-f0-9]{64}") || !url.equals(selected.getString("url")) || !"uploaded".equals(selected.optString("state"))) throw new IllegalArgumentException("github_update_manifest");
        String notes = best.optString("body", "");
        return new JSONObject().put("version", version).put("assetId", id).put("url", url).put("size", size).put("sha256", digest.substring(7)).put("notes", notes.substring(0, Math.min(12000, notes.length())));
    }
    static boolean assetRedirect(String raw) {
        try {
            URI uri = new URI(raw);
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getFragment() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                && Arrays.asList("release-assets.githubusercontent.com", "objects.githubusercontent.com").contains(uri.getHost());
        } catch (Exception error) { return false; }
    }
    static void verifyPackage(String packageName, String installedName, String version, String offeredVersion, long code, long installedCode, String[] signer, String[] installedSigner) {
        if (!packageName.equals(installedName) || !version.equals(offeredVersion) || code <= installedCode || signer.length == 0 || installedSigner.length == 0
                || !new HashSet<>(Arrays.asList(signer)).equals(new HashSet<>(Arrays.asList(installedSigner)))) throw new IllegalArgumentException("github_update_signature");
    }
}
