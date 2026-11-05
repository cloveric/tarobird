package com.tarobot.client;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Proxy;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import javax.net.ssl.X509ExtendedTrustManager;
import okhttp3.Call;
import okhttp3.ConnectionPool;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.util.encoders.Base64;
import org.bouncycastle.util.encoders.Hex;
import org.json.JSONObject;

/** Native TLS only. Bootstrap never carries a device identity or credential.
 * Every pinned route owns its SSLContext and connection pool; session resumption
 * cannot cross a route/Hub identity/pin generation. Normal PKI checks remain on; QR-provided roots are route-scoped.
 * This class deliberately has no Android dependencies, so real TLS adversarial
 * tests can run on the JVM in addition to required Android-device acceptance. */
final class HubTls implements AutoCloseable {
    static final int MAX_FRAME = 1024 * 1024, MAX_PROOF = 4096;
    static final long PIN_AGE_NANOS = TimeUnit.MINUTES.toNanos(5);
    interface Track { void call(Call call) throws IOException; }
    static final class Route {
        final HttpUrl base;
        final OkHttpClient client;
        final long created = System.nanoTime();
        Route(HttpUrl base, OkHttpClient client) { this.base = base; this.client = client; }
        void retire() { client.connectionPool().evictAll(); }
    }
    private static final class Entry { volatile Route route; }
    private final X509ExtendedTrustManager normal;
    private final Map<String, Entry> routes = new HashMap<>();
    private final Map<String, HubTls> authorities = new HashMap<>();
    HubTls() throws Exception { this(systemTrust()); }
    // Package-private test trust is never exposed through the Capacitor bridge.
    HubTls(X509TrustManager normal) throws IOException {
        if(!(normal instanceof X509ExtendedTrustManager)) throw new IOException("native_tls_host_verification_unavailable");
        this.normal = (X509ExtendedTrustManager)normal;
    }
    private static X509TrustManager systemTrust() throws Exception {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore)null);
        for (TrustManager manager : factory.getTrustManagers()) if (manager instanceof X509TrustManager) return (X509TrustManager)manager;
        throw new IOException("system_tls_unavailable");
    }
    static HttpUrl origin(String raw) throws IOException {
        if (raw == null || raw.length() > 2048 || raw.indexOf('\\') >= 0) throw new IOException("invalid_hub_origin");
        HttpUrl url;
        try { url = HttpUrl.get(raw); } catch (IllegalArgumentException error) { throw new IOException("invalid_hub_origin"); }
        if (!url.username().isEmpty() || !url.password().isEmpty() || !url.encodedPath().equals("/") || url.query() != null || url.fragment() != null) throw new IOException("invalid_hub_origin");
        // Android loopback is shared by other applications. This client has no
        // on-device Hub; neither release nor development APKs bypass TLS here.
        if (!url.scheme().equals("https")) throw new IOException("https_required");
        return url;
    }
    static HttpUrl target(HttpUrl base, String path) throws IOException {
        if (path == null || path.length() > 8192 || !path.startsWith("/") || path.startsWith("//") || path.indexOf('\\') >= 0) throw new IOException("invalid_hub_path");
        HttpUrl url = base.resolve(path);
        if (url == null || !base.scheme().equals(url.scheme()) || !base.host().equals(url.host()) || base.port() != url.port()
            || url.fragment() != null || !(url.encodedPath().equals("/health") || url.encodedPath().startsWith("/api/"))
            ) throw new IOException("invalid_hub_path");
        String encoded=url.encodedPath().toLowerCase(Locale.ROOT);
        if(encoded.contains("%2f") || encoded.contains("%5c") || encoded.contains(";")) throw new IOException("invalid_hub_path");
        for(String part:url.pathSegments()) {
            if(part.isEmpty() || part.indexOf(';')>=0 || part.indexOf('%')>=0 || part.indexOf('\\')>=0 || part.indexOf('/')>=0) throw new IOException("invalid_hub_path");
        }
        if(url.pathSegments().size()>1 && url.pathSegments().get(1).equalsIgnoreCase("instance")) throw new IOException("invalid_hub_path");
        return url;
    }
    static byte[] decode(String value) throws IOException {
        try { byte[] bytes = Base64.decode(value); if (!Base64.toBase64String(bytes).equals(value)) throw new IOException("invalid_base64"); return bytes; }
        catch (RuntimeException error) { throw new IOException("invalid_base64"); }
    }
    static byte[] key(String value) throws IOException {
        if(value==null || value.length()!=60) throw new IOException("trusted_hub_key_required");
        byte[] bytes = decode(value);
        byte[] prefix = {0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
        if (bytes.length != 44 || !Arrays.equals(Arrays.copyOf(bytes,12), prefix)) throw new IOException("trusted_hub_key_required");
        return Arrays.copyOfRange(bytes, 12, 44);
    }
    static byte[] digest(byte[] bytes) throws IOException {
        try { return MessageDigest.getInstance("SHA-256").digest(bytes); } catch (Exception error) { throw new IOException("sha256_unavailable"); }
    }
    static void proof(byte[] data, String key, String nonce, byte[] certificate) throws IOException {
        try {
            if (data.length > MAX_PROOF) throw new IOException("tls_identity_too_large");
            JSONObject value = new JSONObject(new String(data, StandardCharsets.UTF_8));
            String hash = Hex.toHexString(digest(certificate));
            if (value.length() != 6 || !(value.opt("v") instanceof Number) || ((Number)value.opt("v")).doubleValue() != 1
                || !"tls.identity".equals(value.opt("type")) || !key.equals(value.opt("publicKey")) || !nonce.equals(value.opt("nonce"))
                || !hash.equals(value.opt("certificateSha256")) || !(value.opt("signature") instanceof String)) throw new IOException("tls_identity_mismatch");
            byte[] signature = decode(value.getString("signature"));
            if (signature.length != 64) throw new IOException("tls_identity_mismatch");
            byte[] message = ("[\"tarocub/tls-identity/v1\",\"" + key + "\",\"" + nonce + "\",\"" + hash + "\"]").getBytes(StandardCharsets.UTF_8);
            Ed25519Signer verifier = new Ed25519Signer(); verifier.init(false, new Ed25519PublicKeyParameters(key(key), 0));
            verifier.update(message, 0, message.length);
            if (!verifier.verifySignature(signature)) throw new IOException("tls_identity_mismatch");
        } catch (Exception error) { throw new IOException("tls_identity_mismatch", error); }
    }
    private OkHttpClient client(HttpUrl base, X509Certificate pinned) throws IOException {
        try {
            final byte[] expected = pinned == null ? null : digest(pinned.getEncoded());
            X509ExtendedTrustManager verifier = expected == null ? normal : new X509ExtendedTrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return normal.getAcceptedIssuers(); }
                public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { normal.checkClientTrusted(chain, auth); }
                public void checkClientTrusted(X509Certificate[] chain, String auth, Socket socket) throws CertificateException { normal.checkClientTrusted(chain, auth, socket); }
                public void checkClientTrusted(X509Certificate[] chain, String auth, SSLEngine engine) throws CertificateException { normal.checkClientTrusted(chain, auth, engine); }
                public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    normal.checkServerTrusted(chain, auth); pin(chain);
                }
                public void checkServerTrusted(X509Certificate[] chain, String auth, Socket socket) throws CertificateException {
                    normal.checkServerTrusted(chain, auth, socket); pin(chain);
                }
                public void checkServerTrusted(X509Certificate[] chain, String auth, SSLEngine engine) throws CertificateException {
                    normal.checkServerTrusted(chain, auth, engine); pin(chain);
                }
                private void pin(X509Certificate[] chain) throws CertificateException {
                    try { if (chain.length == 0 || !MessageDigest.isEqual(expected, digest(chain[0].getEncoded()))) throw new CertificateException("tls_identity_mismatch"); }
                    catch (IOException error) { throw new CertificateException("tls_identity_mismatch", error); }
                }
            };
            SSLContext context = SSLContext.getInstance("TLS"); context.init(null, new TrustManager[]{verifier}, new SecureRandom());
            // A new context and pool per generation isolates both full handshakes
            // and TLS-resumed sessions. Never reuse a bootstrap's unpinned pool.
            OkHttpClient.Builder builder = new OkHttpClient.Builder().sslSocketFactory(context.getSocketFactory(), verifier)
                .proxy(Proxy.NO_PROXY).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
                // Retire idle HTTP sockets before the Hub's 5 s keep-alive.
                // GET can otherwise reuse a peer-closed socket; global retries
                // must stay disabled so an uncertain POST is never replayed.
                .protocols(Collections.singletonList(Protocol.HTTP_1_1)).connectionPool(new ConnectionPool(4,4,TimeUnit.SECONDS))
                .connectTimeout(5,TimeUnit.SECONDS).readTimeout(30,TimeUnit.SECONDS).writeTimeout(30,TimeUnit.SECONDS);
            return builder.build();
        } catch (Exception error) { throw new IOException("native_transport_unavailable", error); }
    }
    Route prepare(String raw, String publicKey, String authority, Track track) throws IOException {
        if(authority==null) return prepare(raw,publicKey,track);
        if(authority.length()>4096) throw new IOException("invalid_host_authority");
        String id=origin(raw)+"\0"+publicKey+"\0"+authority;
        HubTls scoped;
        synchronized(authorities) {
            scoped=authorities.get(id);
            if(scoped==null) {
                try {
                    KeyStore roots=KeyStore.getInstance(KeyStore.getDefaultType()); roots.load(null,null);
                    java.security.cert.Certificate certificate=java.security.cert.CertificateFactory.getInstance("X.509")
                        .generateCertificate(new java.io.ByteArrayInputStream(decode(authority)));
                    roots.setCertificateEntry("tarobot-host",certificate);
                    TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init(roots);
                    for(TrustManager manager:factory.getTrustManagers()) if(manager instanceof X509TrustManager) scoped=new HubTls((X509TrustManager)manager);
                    if(scoped==null) throw new IOException("invalid_host_authority");
                    if(authorities.size()>=64) { for(HubTls old:authorities.values()) old.close(); authorities.clear(); }
                    authorities.put(id,scoped);
                } catch(Exception error) { throw new IOException("invalid_host_authority",error); }
            }
        }
        return scoped.prepare(raw,publicKey,track);
    }
    Route prepare(String raw, String publicKey, Track track) throws IOException {
        HttpUrl base = origin(raw);
        key(publicKey);
        String identity = routeIdentity(base,publicKey);
        Entry entry;
        synchronized (routes) {
            if (!routes.containsKey(identity) && routes.size() >= 64) { for (Entry previous : routes.values()) if (previous.route != null) previous.route.retire(); routes.clear(); }
            entry = routes.get(identity); if (entry == null) { entry = new Entry(); routes.put(identity, entry); }
        }
        synchronized (entry) {
            if (entry.route != null && System.nanoTime() - entry.route.created < PIN_AGE_NANOS) return entry.route;
            byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
            String nonce = Base64.toBase64String(random).replace('+','-').replace('/','_').replace("=","");
            OkHttpClient bootstrap = client(base, null);
            Call call = bootstrap.newCall(new Request.Builder().url(base.newBuilder().encodedPath("/api/tls-identity").addQueryParameter("nonce", nonce).build()).build());
            call.timeout().timeout(5, TimeUnit.SECONDS); track.call(call);
            try (Response response = call.execute()) {
                if (response.code() != 200 || response.body() == null || response.handshake() == null) throw new IOException("hub_tls_identity_required");
                X509Certificate certificate = (X509Certificate)response.handshake().peerCertificates().get(0);
                byte[] data = bounded(response.body().byteStream(), MAX_PROOF);
                proof(data, publicKey, nonce, certificate.getEncoded());
                Route next = new Route(base, client(base, certificate));
                if (entry.route != null) entry.route.retire(); entry.route = next; return next;
            } catch (IOException error) { throw error; }
            catch (Exception error) { throw new IOException("tls_identity_mismatch", error); }
            finally { bootstrap.connectionPool().evictAll(); bootstrap.dispatcher().executorService().shutdown(); }
        }
    }
    private static String routeIdentity(HttpUrl base,String key) { return base + "\0" + key; }
    static byte[] bounded(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[Math.min(8192,maximum+1)]; int n;
        while ((n=input.read(buffer)) != -1) { if (n > maximum - out.size()) throw new IOException("response_too_large"); out.write(buffer,0,n); }
        return out.toByteArray();
    }
    static boolean trustFailure(Throwable error) {
        for(int depth=0;error!=null && depth<16;depth++,error=error.getCause())
            if(error instanceof javax.net.ssl.SSLHandshakeException || error instanceof javax.net.ssl.SSLPeerUnverifiedException || error instanceof CertificateException) return true;
        return false;
    }
    void forget(String origin, String key, Route failed) {
        if(failed==null) return;
        synchronized(authorities) { for(HubTls scoped:authorities.values()) scoped.forget(origin,key,failed); }
        try { synchronized(routes) {
            String identity=routeIdentity(origin(origin),key); Entry entry=routes.get(identity);
            if(entry!=null && entry.route==failed) { routes.remove(identity); failed.retire(); }
        } } catch(IOException ignored) { }
    }
    public void close() { synchronized(authorities) { for(HubTls scoped:authorities.values()) scoped.close(); authorities.clear(); } synchronized (routes) { for (Entry entry : routes.values()) if (entry.route != null) entry.route.retire(); routes.clear(); } }
}
