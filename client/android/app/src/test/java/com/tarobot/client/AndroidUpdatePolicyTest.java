package com.tarobot.client;

import org.junit.Test;
import okhttp3.OkHttpClient;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class AndroidUpdatePolicyTest {
    @Test public void progressingDownloadsKeepIdleTimeoutsAndInjectedTransportWithoutAnOverallDeadline() {
        okhttp3.Interceptor mock = chain -> { throw new AssertionError("No network in this policy test"); };
        OkHttpClient api = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(5, TimeUnit.MINUTES).addInterceptor(mock).build();
        OkHttpClient transfer = AndroidUpdateService.downloadClient(api);
        assertEquals(0, transfer.callTimeoutMillis());
        assertEquals(20000, transfer.connectTimeoutMillis()); assertEquals(30000, transfer.readTimeoutMillis());
        assertFalse(transfer.followRedirects()); assertFalse(transfer.followSslRedirects());
        assertSame(mock, transfer.interceptors().get(0));
        assertEquals(300000, api.callTimeoutMillis());
    }
    private JSONObject release(String version, long id) throws Exception {
        return new JSONObject().put("tag_name", "android-tarobot-v" + version).put("draft", false).put("prerelease", false).put("body", "Notes")
            .put("assets", new JSONArray().put(new JSONObject().put("name", "TaroBot-" + version + "-android.apk").put("id", id).put("size", 100)
                .put("digest", "sha256:" + "a".repeat(64)).put("state", "uploaded").put("url", "https://api.github.com/repos/owner/repo/releases/assets/" + id)));
    }
    private JSONObject birdRelease(String version, long id) throws Exception {
        JSONObject result = release(version, id);
        result.getJSONArray("assets").getJSONObject(0).put("name", "TaroBird_" + version + "_android.apk");
        return result;
    }
    @Test public void discoversRenamedApkAndRetainsLegacyCompatibility() throws Exception {
        assertEquals(2, AndroidUpdatePolicy.select(new JSONArray().put(birdRelease("1.1.2", 2)), "1.1.1", "owner/repo").getLong("assetId"));
        assertEquals(1, AndroidUpdatePolicy.select(new JSONArray().put(release("1.1.2", 1)), "1.1.1", "owner/repo").getLong("assetId"));
    }
    @Test public void canonicalApkWinsRegardlessOfAssetOrder() throws Exception {
        for (boolean canonicalFirst : new boolean[]{true, false}) {
            JSONObject canonical = birdRelease("1.1.2", 2).getJSONArray("assets").getJSONObject(0);
            JSONObject legacy = release("1.1.2", 1).getJSONArray("assets").getJSONObject(0);
            JSONObject mixed = release("1.1.2", 1).put("assets", new JSONArray()
                .put(canonicalFirst ? canonical : legacy).put(canonicalFirst ? legacy : canonical));
            assertEquals(2, AndroidUpdatePolicy.select(new JSONArray().put(mixed), "1.1.1", "owner/repo").getLong("assetId"));
        }
    }
    @Test public void invalidCanonicalApkCannotFallBackToLegacy() throws Exception {
        JSONObject broken = birdRelease("1.1.2", 2);
        broken.getJSONArray("assets").getJSONObject(0).put("digest", "invalid");
        broken.getJSONArray("assets").put(release("1.1.2", 1).getJSONArray("assets").getJSONObject(0));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.select(new JSONArray().put(broken), "1.1.1", "owner/repo"));
    }
    @Test public void duplicateCanonicalApkIsRejected() throws Exception {
        JSONObject duplicate = birdRelease("1.1.2", 2);
        duplicate.getJSONArray("assets").put(birdRelease("1.1.2", 3).getJSONArray("assets").getJSONObject(0));
        duplicate.getJSONArray("assets").put(release("1.1.2", 1).getJSONArray("assets").getJSONObject(0));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.select(new JSONArray().put(duplicate), "1.1.1", "owner/repo"));
    }
    @Test public void renamedApkMustMatchVersionAndExactFilename() throws Exception {
        for (String name : new String[]{"TaroBird_1.1.3_android.apk", "TaroBird_1.1.2_android.apk.sig", "TaroBird_1.1.2_android.apk.exe"}) {
            JSONObject wrong = birdRelease("1.1.2", 2);
            wrong.getJSONArray("assets").getJSONObject(0).put("name", name);
            assertThrows(Exception.class, () -> AndroidUpdatePolicy.select(new JSONArray().put(wrong), "1.1.1", "owner/repo"));
        }
    }
    @Test public void picksNumericAndroidChannelAndIgnoresMacDraftAndDowngrades() throws Exception {
        JSONObject unknownChannel = release("6.0.0", 6); unknownChannel.remove("prerelease");
        JSONArray releases = new JSONArray().put(release("1.0.9", 1)).put(release("1.0.10", 2))
            .put(release("9.0.0", 3).put("draft", true)).put(release("8.0.0", 4).put("tag_name", "macos-tarobot-v8.0.0"))
            .put(release("7.0.0", 5).put("prerelease", true)).put(unknownChannel);
        assertEquals("1.0.10", AndroidUpdatePolicy.select(releases, "1.0.8", "owner/repo").getString("version"));
        assertNull(AndroidUpdatePolicy.select(releases, "1.0.10", "owner/repo"));
        assertNull(AndroidUpdatePolicy.select(releases, "2.0.0", "owner/repo"));
    }
    @Test public void applicationIdentitiesUseSeparateDiscoveryChannels() throws Exception {
        JSONObject legacy = release("99.0.0", 7).put("tag_name", "android-v99.0.0");
        assertNull(AndroidUpdatePolicy.select(new JSONArray().put(legacy), "1.0.0", "owner/repo"));
        JSONObject current = release("1.1.0", 8);
        assertEquals("1.1.0", AndroidUpdatePolicy.select(new JSONArray().put(legacy).put(current), "1.0.0", "owner/repo").getString("version"));
        assertFalse(current.getString("tag_name").matches("android-v[0-9]{1,8}\\.[0-9]{1,8}\\.[0-9]{1,8}"));
    }
    @Test public void badLatestAssetCannotSilentlyFallBack() throws Exception {
        for (String field : new String[]{"digest", "url", "size", "state"}) {
            JSONObject broken = release("1.0.11", 2), asset = broken.getJSONArray("assets").getJSONObject(0);
            asset.put(field, field.equals("size") ? AndroidUpdatePolicy.MAX_APK + 1 : "invalid");
            assertThrows(Exception.class, () -> AndroidUpdatePolicy.select(new JSONArray().put(release("1.0.10", 1)).put(broken), "1.0.9", "owner/repo"));
        }
    }
    @Test public void missingOrDuplicateApkIsRejected() throws Exception {
        JSONObject missing = release("1.0.11", 2).put("assets", new JSONArray());
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.select(new JSONArray().put(missing), "1.0.9", "owner/repo"));
        JSONObject duplicate = release("1.0.11", 2); duplicate.getJSONArray("assets").put(duplicate.getJSONArray("assets").get(0));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.select(new JSONArray().put(duplicate), "1.0.9", "owner/repo"));
    }
    @Test public void onlyGitHubAssetHostsAcceptCredentialFreeRedirects() {
        assertTrue(AndroidUpdatePolicy.assetRedirect("https://release-assets.githubusercontent.com/github/a?sig=value"));
        for (String url : new String[]{"http://release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com.evil/a", "https://api.github.com/user", "https://u:p@objects.githubusercontent.com/a", "https://objects.githubusercontent.com:444/a", "https://objects.githubusercontent.com/a#part", "file:///data/app.apk"}) assertFalse(url, AndroidUpdatePolicy.assetRedirect(url));
    }
    @Test public void packageIdentityVersionAndEverySignerMustMatch() {
        String[] original = {"signer-a"};
        AndroidUpdatePolicy.verifyPackage("app", "app", "1.0.11", "1.0.11", 11, 10, original, original);
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.verifyPackage("other", "app", "1.0.11", "1.0.11", 11, 10, original, original));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.verifyPackage("app", "app", "1.0.12", "1.0.11", 11, 10, original, original));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.verifyPackage("app", "app", "1.0.11", "1.0.11", 10, 10, original, original));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.verifyPackage("app", "app", "1.0.11", "1.0.11", 11, 10, new String[]{"other"}, original));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.verifyPackage("app", "app", "1.0.11", "1.0.11", 11, 10, new String[]{"signer-a","extra"}, original));
        assertThrows(Exception.class, () -> AndroidUpdatePolicy.verifyPackage("app", "app", "1.0.11", "1.0.11", 11, 10, new String[0], original));
    }
    @Test public void publicConfigurationCannotInjectCodeOrCredentials() {
        assertTrue(AndroidUpdatePolicy.configured("owner/repo", "Ov23.example"));
        assertFalse(AndroidUpdatePolicy.configured("owner/repo\"", "Ov23.example"));
        assertFalse(AndroidUpdatePolicy.configured("https://token@example.com/repo", "Ov23.example"));
        assertFalse(AndroidUpdatePolicy.configured("owner/repo", ""));
    }
}
