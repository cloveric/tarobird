package com.tarobot.client;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.cert.CertificateException;
import java.net.Socket;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.util.encoders.Base64;
import org.bouncycastle.util.encoders.Hex;
import org.json.*;

/** JVM acceptance of the exact Android core. This is not an APK/device test. */
public final class NativeTlsAudit {
    static final JSONObject result=new JSONObject();
    static final List<JSONObject> events=new ArrayList<>();
    static HubTransport transport;
    static String document,key;
    static void check(boolean condition,String name) throws Exception { if(!condition) throw new Exception(name); result.put(name,true); System.out.println(name); }
    interface Work { void run() throws Exception; }
    static void rejects(Work work,String name) throws Exception { boolean denied=false; try { work.run(); } catch(Exception expected) { denied=true; } check(denied,name); }
    static JSONObject input(String origin,String path,String method,String body,JSONArray headers) throws Exception {
        return new JSONObject().put("origin",origin).put("hubKey",key).put("path",path).put("method",method)
            .put("body",body==null?JSONObject.NULL:Base64.toBase64String(body.getBytes(StandardCharsets.UTF_8))).put("headers",headers);
    }
    static String open(String origin,String path,String method,String body,JSONArray headers) throws Exception {
        String id=transport.allocate("http",document); JSONObject response=transport.httpOpen(id,input(origin,path,method,body,headers));
        if(response.getInt("status")<200 || response.getInt("status")>=300) { transport.cancel(id); throw new Exception("unexpected HTTP "+response.getInt("status")); } return id;
    }
    static byte[] read(String id) throws Exception { ByteArrayOutputStream all=new ByteArrayOutputStream(); byte[] next; while((next=transport.httpRead(id)).length>0) all.write(next); return all.toByteArray(); }
    static String get(String origin,String path) throws Exception { return new String(read(open(origin,path,"GET",null,new JSONArray())),StandardCharsets.UTF_8); }
    static JSONObject event(String id,String kind) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        synchronized(events) { while(true) {
            for(int i=0;i<events.size();i++) { JSONObject e=events.get(i); if(id.equals(e.optString("id")) && kind.equals(e.optString("kind"))) { events.remove(i); return e; } }
            long left=deadline-System.nanoTime(); if(left<=0) throw new Exception("event timeout: "+kind); TimeUnit.NANOSECONDS.timedWait(events,left);
        } }
    }
    static String socket(String origin) throws Exception { String id=transport.allocate("socket",document); transport.socketOpen(id,origin,key); event(id,"open"); return id; }
    static JSONObject message(String id) throws Exception { JSONObject e=event(id,"message"); transport.socketAck(id,e.getLong("sequence")); return new JSONObject(e.getString("data")); }
    static X509TrustManager trust(Path ca) throws Exception {
        KeyStore store=KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null);
        try(InputStream in=Files.newInputStream(ca)) { store.setCertificateEntry("temporary-test-ca",CertificateFactory.getInstance("X.509").generateCertificate(in)); }
        TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init(store);
        for(TrustManager manager:factory.getTrustManagers()) if(manager instanceof X509TrustManager) return (X509TrustManager)manager;
        throw new Exception("test CA unavailable");
    }
    // Reproduce Android RootTrustManager's requirement for a host-aware call
    // whenever a domain-specific network security configuration exists.
    static final class HostAwareTrust extends X509ExtendedTrustManager {
        final X509ExtendedTrustManager base; int hostCalls,unawareCalls;
        HostAwareTrust(X509TrustManager base) { this.base=(X509ExtendedTrustManager)base; }
        public X509Certificate[] getAcceptedIssuers() { return base.getAcceptedIssuers(); }
        public void checkClientTrusted(X509Certificate[] chain,String auth) throws CertificateException { base.checkClientTrusted(chain,auth); }
        public void checkClientTrusted(X509Certificate[] chain,String auth,Socket socket) throws CertificateException { base.checkClientTrusted(chain,auth,socket); }
        public void checkClientTrusted(X509Certificate[] chain,String auth,SSLEngine engine) throws CertificateException { base.checkClientTrusted(chain,auth,engine); }
        public void checkServerTrusted(X509Certificate[] chain,String auth) throws CertificateException { unawareCalls++; throw new CertificateException("domain-specific policy requires host context"); }
        public void checkServerTrusted(X509Certificate[] chain,String auth,Socket socket) throws CertificateException { hostCalls++; base.checkServerTrusted(chain,auth,socket); }
        public void checkServerTrusted(X509Certificate[] chain,String auth,SSLEngine engine) throws CertificateException { hostCalls++; base.checkServerTrusted(chain,auth,engine); }
    }
    static String command(BufferedWriter input,BufferedReader output,String text) throws Exception { input.write(text+"\n"); input.flush(); return output.readLine(); }
    public static void main(String[] args) throws Exception {
        Path repo=Paths.get(args[0]),scratch=Paths.get(args[1]),receipt=Paths.get(args[2]);
        Process fixture=null; ExecutorService worker=Executors.newFixedThreadPool(6); boolean ok=false;
        try {
            fixture=new ProcessBuilder("node","--import","tsx","tests/helpers/native-tls-fixture.ts",scratch.toString()).directory(repo.toFile()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            BufferedReader output=new BufferedReader(new InputStreamReader(fixture.getInputStream(),StandardCharsets.UTF_8));
            BufferedWriter stdin=new BufferedWriter(new OutputStreamWriter(fixture.getOutputStream(),StandardCharsets.UTF_8));
            JSONObject peers=new JSONObject(output.readLine()); String hub=peers.getString("hub"),proxy=peers.getString("proxy"),rotating=peers.getString("rotating"); key=peers.getString("key");
            result.put("surface","JVM running Android HubTls and HubTransport source; no Android device");
            try(HubTls system=new HubTls()) {
                rejects(()->system.prepare(hub,key,c->{}),"untrustedCaRejected");
                String qrCa=Base64.toBase64String(Files.readAllBytes(scratch.resolve("ca.der")));
                check(system.prepare(hub,key,qrCa,c->{}).client!=null,"qrScopedAuthorityAccepted");
                rejects(()->system.prepare(hub.replace("127.0.0.1","localhost"),key,qrCa,c->{}),"qrAuthorityStillChecksHostname");
                rejects(()->system.prepare(hub,key,c->{}),"qrAuthorityNeverChangesSystemTrust");
            }
            HostAwareTrust domainPolicy=new HostAwareTrust(trust(scratch.resolve("ca.der")));
            HubTls core=new HubTls(domainPolicy);
            rejects(()->core.prepare("http://localhost:1",null,c->{}),"localhostCleartextRejected");
            rejects(()->core.prepare("http://127.0.0.1:1",key,c->{}),"loopbackCleartextRejected");
            rejects(()->HubTls.origin("http://192.168.1.2"),"remoteCleartextRejected");
            rejects(()->HubTls.key(String.join("",Collections.nCopies(1000,"x"))),"oversizedHubKeyRejected");
            for(String target:Arrays.asList("/api/instance","/api/instance?x","/api//instance/x","/api/instance%2Fx","/api/Instance/x","/api/instance;p/x","/api/%69nstance/x","/api/instance%3bp/x","/api/%2569nstance/x")) rejects(()->HubTls.target(HubTls.origin(hub),target),"internalPathAliasesRejected");
            rejects(()->core.prepare(hub.replace("127.0.0.1","localhost"),key,c->{}),"wrongHostnameRejected");
            transport=new HubTransport(core,e->{ synchronized(events) { events.add(e); events.notifyAll(); } }); document=transport.document();
            rejects(()->get(proxy,"/health"),"terminatingProxyRejected");
            rejects(()->open(proxy,"/api/pair","POST","synthetic-device-must-not-leak",new JSONArray()),"proxyReceivesNoPairingPost");
            String bad=transport.allocate("socket",document); rejects(()->transport.socketOpen(bad,proxy,key),"proxySocketRejected");
            check(event(bad,"close").getInt("code")==1006,"proxySocketAbnormalClose");
            check(new JSONObject(get(hub,"/health")).getString("publicKey").equals(key),"realHubIdentity");
            List<Future<String>> idleHealth=new ArrayList<>();
            for(int i=0;i<3;i++) idleHealth.add(worker.submit(()->get(hub,"/health")));
            for(Future<String> pending:idleHealth) check(new JSONObject(pending.get(10,TimeUnit.SECONDS)).getBoolean("ok"),"parallelHealthWarmup");
            // The real Hub closes keep-alive connections after 5 s (+ buffer).
            // The very first health request after that must work, without retries.
            Thread.sleep(6500);
            check(new JSONObject(get(hub,"/health")).getBoolean("ok"),"firstHealthAfterServerIdleClose");
            Ed25519PrivateKeyParameters privateKey=new Ed25519PrivateKeyParameters(new SecureRandom());
            byte[] spki=new byte[44],prefix=Hex.decode("302a300506032b6570032100"); System.arraycopy(prefix,0,spki,0,12); System.arraycopy(privateKey.generatePublicKey().getEncoded(),0,spki,12,32);
            String body=new JSONObject().put("deviceId","android-native-jvm-test").put("name","Isolated Android core").put("platform","android").put("publicKey",Base64.toBase64String(spki)).put("invite",peers.getString("invite")).put("requestId",Base64.toBase64String(HubTls.digest(spki)).replace('+','-').replace('/','_').replace("=","")).toString();
            JSONObject pairing=new JSONObject(new String(read(open(hub,"/api/pair","POST",body,new JSONArray().put(new JSONArray().put("content-type").put("application/json")))),StandardCharsets.UTF_8));
            check("ok".equals(command(stdin,output,"approve:"+pairing.getString("code"))),"realOwnerPairing");
            String ws=socket(hub),nonce=String.join("",Collections.nCopies(43,"a"));
            transport.socketSend(ws,new JSONObject().put("v",1).put("type","hello").put("deviceId","android-native-jvm-test").put("nonce",nonce).put("protocolVersions",new JSONArray().put(1)).put("capabilities",new JSONArray()).put("cursors",new JSONObject()).toString());
            JSONObject challenge=message(ws); check(challenge.getString("type").equals("challenge"),"nativeSocketChallenge");
            byte[] text=("tarocub/device/v1\0android-native-jvm-test\0"+challenge.getString("nonce")+"\0"+nonce).getBytes(StandardCharsets.UTF_8);
            Ed25519Signer signer=new Ed25519Signer(); signer.init(true,privateKey); signer.update(text,0,text.length);
            transport.socketSend(ws,new JSONObject().put("v",1).put("type","auth").put("signature",Base64.toBase64String(signer.generateSignature())).toString());
            JSONObject ready=message(ws); check(ready.getString("type").equals("ready"),"realNativeAuthentication");
            String chats=new String(read(open(hub,"/api/conversations","GET",null,new JSONArray().put(new JSONArray().put("authorization").put("Bearer "+ready.getString("sessionToken"))))),StandardCharsets.UTF_8);
            check(chats.equals("[]"),"authenticatedHttp"); transport.socketClose(ws,1000,""); JSONObject close=event(ws,"close"); check(close.getInt("code")==1000 && close.getBoolean("clean"),"peerConfirmedClose");
            char[] upload=new char[8*1024*1024]; Arrays.fill(upload,'a'); byte[] echo=read(open(rotating,"/api/echo","POST",new String(upload),new JSONArray()));
            check(echo.length==upload.length && MessageDigest.isEqual(HubTls.digest(echo),HubTls.digest(new String(upload).getBytes(StandardCharsets.UTF_8))),"upload8MiB");
            rejects(()->get(rotating,"/api/redirect"),"redirectRejected");
            String download=open(rotating,"/api/large","GET",null,new JSONArray()); long bytes=0,started=System.nanoTime(); int maxChunk=0,reads=0; MessageDigest actual=MessageDigest.getInstance("SHA-256"),expected=MessageDigest.getInstance("SHA-256"); byte[] chunk;
            while((chunk=transport.httpRead(download)).length>0) { reads++; bytes+=chunk.length; maxChunk=Math.max(maxChunk,chunk.length); actual.update(chunk); }
            byte[] a=new byte[65536]; Arrays.fill(a,(byte)'a'); for(int i=0;i<8192;i++) expected.update(a);
            check(bytes==512L*1024*1024 && maxChunk<=256*1024 && MessageDigest.isEqual(actual.digest(),expected.digest()),"download512MiBHash");
            check(reads==2048,"boundedChunksCoalesced");
            result.put("download",new JSONObject().put("bytes",bytes).put("maximumChunk",maxChunk).put("dataReads",reads).put("elapsedMs",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)));
            String stalled=open(rotating,"/api/hang","GET",null,new JSONArray()); Future<?> read=worker.submit(()->{ try { transport.httpRead(stalled); throw new AssertionError("late data"); } catch(Exception expectedError) {} });
            String retired=document; document=transport.document(); read.get(3,TimeUnit.SECONDS); check(true,"reloadCancelsBlockedRead");
            rejects(()->transport.allocate("http",retired),"oldDocumentCannotReclaim");
            rejects(()->transport.httpOpen(stalled,input(rotating,"/api/echo","POST","late",new JSONArray())),"latePostCannotStart");
            String stalledUpload=transport.allocate("http",document); JSONObject stalledInput=input(rotating,"/api/stalled-upload","POST",new String(upload),new JSONArray());
            Future<?> sending=worker.submit(()->{ try { transport.httpOpen(stalledUpload,stalledInput); throw new AssertionError("stalled upload unexpectedly completed"); } catch(Exception expectedError) {} });
            long waitUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(new JSONObject(command(stdin,output,"stats")).getInt("stalledUploads")==0) { if(System.nanoTime()>waitUntil) throw new Exception("upload did not start"); Thread.sleep(10); }
            transport.cancel(stalledUpload); sending.get(3,TimeUnit.SECONDS); check(true,"cancelBlockedUpload");
            List<String> uploadSlots=new ArrayList<>(); List<Future<?>> uploads=new ArrayList<>();
            for(int i=0;i<4;i++) { String id=transport.allocate("http",document); uploadSlots.add(id); uploads.add(worker.submit(()->{ try { transport.httpOpen(id,stalledInput); throw new AssertionError("stalled upload completed"); } catch(Exception expectedError) {} })); }
            waitUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(new JSONObject(command(stdin,output,"stats")).getInt("stalledUploads")<5) { if(System.nanoTime()>waitUntil) throw new Exception("aggregate uploads did not start"); Thread.sleep(10); }
            String fifth=transport.allocate("http",document); boolean budgetRejected=false;
            try { transport.httpOpen(fifth,stalledInput); } catch(IOException limited) { budgetRejected=limited.getMessage().equals("native_upload_backpressure"); }
            check(budgetRejected,"aggregateUploadBudget"); for(String id:uploadSlots) transport.cancel(id); for(Future<?> future:uploads) future.get(3,TimeUnit.SECONDS);
            check(new String(read(open(rotating,"/api/echo","POST","after upload cancellation",new JSONArray())),StandardCharsets.UTF_8).equals("after upload cancellation"),"uploadBudgetRecovers");
            rejects(()->open(rotating,"/api/drop-after-upload","POST","single delivery",new JSONArray()),"uncertainUploadNotRetried");
            for(int i=0;i<33;i++) { String malformed=transport.allocate("http",document); rejects(()->transport.httpOpen(malformed,new JSONObject()),"malformedHttpReleasesQuota"); }
            for(int i=0;i<33;i++) rejects(()->open(rotating,"/api/redirect","GET",null,new JSONArray()),"failedHttpReleasesQuota");
            String echoSocket=socket(rotating); transport.socketSend(echoSocket,"$audit:burst"); for(int i=0;i<8;i++) event(echoSocket,"message");
            transport.socketClose(echoSocket,3334,"client done"); JSONObject burstClose=event(echoSocket,"close");
            check(burstClose.getBoolean("clean") && burstClose.getInt("code")==3334,"closeWithExhaustedCredits");
            String pausedReader=socket(rotating); transport.socketSend(pausedReader,"$audit:burst"); long pausedSequence=0;
            for(int i=0;i<8;i++) pausedSequence=event(pausedReader,"message").getLong("sequence");
            // Model a suspended renderer without acknowledgements for longer
            // than the former 10 s deadline; the process itself remains alive.
            Thread.sleep(11_000);
            synchronized(events) {
                boolean unexpected=false;
                for(JSONObject e:events) if(pausedReader.equals(e.optString("id"))) unexpected=true;
                check(!unexpected,"suspendedReaderRemainsBoundedAndOpen");
            }
            transport.socketAck(pausedReader,pausedSequence);
            check(event(pausedReader,"message").getLong("sequence")==9,"suspendedReaderResumesAfterAck"); transport.cancel(pausedReader);
            String retiredReader=socket(rotating); transport.socketSend(retiredReader,"$audit:burst");
            for(int i=0;i<8;i++) event(retiredReader,"message");
            long retireStarted=System.nanoTime(); document=transport.document();
            check(event(retiredReader,"close").getInt("code")==1006 && System.nanoTime()-retireStarted<TimeUnit.SECONDS.toNanos(1),"retirementCancelsCreditWait");
            String oversized=socket(rotating); transport.socketSend(oversized,"$audit:oversize"); check(!event(oversized,"close").getBoolean("clean"),"oversizedMessageNotDelivered");
            // Retain the old OkHttp path as a comparison: no early rejection
            // occurs when only an oversized frame header arrives, without body.
            CountDownLatch oldOpen=new CountDownLatch(1),oldClosed=new CountDownLatch(1);
            HubTls.Route baselineRoute=core.prepare(rotating,key,c->{});
            okhttp3.WebSocket baseline=baselineRoute.client.newWebSocket(new okhttp3.Request.Builder().url(rotating+"/ws").build(),new okhttp3.WebSocketListener() {
                public void onOpen(okhttp3.WebSocket socket,okhttp3.Response response) { oldOpen.countDown(); }
                public void onFailure(okhttp3.WebSocket socket,Throwable error,okhttp3.Response response) { oldClosed.countDown(); }
                public void onClosed(okhttp3.WebSocket socket,int code,String reason) { oldClosed.countDown(); }
            });
            check(oldOpen.await(3,TimeUnit.SECONDS),"baselineSocketOpened"); baseline.send("$audit:oversize-header");
            check(!oldClosed.await(350,TimeUnit.MILLISECONDS),"oldReaderDidNotRejectHeaderOnly"); baseline.cancel();
            for(String attack:Arrays.asList("oversize-header","fragment-overflow","fragment-empty","masked","masked-split")) {
                String victim=socket(rotating); long began=System.nanoTime(); transport.socketSend(victim,"$audit:"+attack);
                check(!event(victim,"close").getBoolean("clean") && System.nanoTime()-began<TimeUnit.SECONDS.toNanos(3),"earlyReject_"+attack);
                synchronized(events) { boolean leaked=false; for(JSONObject e:events) if(victim.equals(e.optString("id")) && "message".equals(e.optString("kind"))) leaked=true; check(!leaked,"oversizeNeverCrossesBridge"); }
            }
            String validFragments=socket(rotating); transport.socketSend(validFragments,"$audit:fragment-valid"); JSONObject complete=event(validFragments,"message");
            check(complete.getString("data").length()==HubTls.MAX_FRAME,"maximumFragmentedMessageAccepted"); transport.socketAck(validFragments,complete.getLong("sequence")); transport.cancel(validFragments);
            String unicode=socket(rotating); transport.socketSend(unicode,"$audit:fragment-unicode");
            check(event(unicode,"message").getString("data").equals("你好"),"splitUtf8FragmentsAccepted"); transport.cancel(unicode);
            for(String attack:Arrays.asList("large-header","extension","redirect")) {
                command(stdin,output,"ws-mode:"+attack); String victim=transport.allocate("socket",document); long began=System.nanoTime(); transport.socketOpen(victim,rotating,key);
                check(!event(victim,"close").getBoolean("clean") && System.nanoTime()-began<TimeUnit.SECONDS.toNanos(3),"upgradeRejected_"+attack);
                synchronized(events) { boolean opened=false; for(JSONObject e:events) if(victim.equals(e.optString("id")) && "open".equals(e.optString("kind"))) opened=true; check(!opened,"badUpgradeNeverOpens"); }
            }
            int previousUpgrades=new JSONObject(command(stdin,output,"stats")).getInt("rawUpgrades");
            command(stdin,output,"ws-mode:hang"); String hangingSocket=transport.allocate("socket",document); transport.socketOpen(hangingSocket,rotating,key);
            waitUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
            while(new JSONObject(command(stdin,output,"stats")).getInt("rawUpgrades")==previousUpgrades) { if(System.nanoTime()>waitUntil) throw new Exception("upgrade did not reach fixture"); Thread.sleep(10); }
            long reloadStart=System.nanoTime(); document=transport.document();
            check(!event(hangingSocket,"close").getBoolean("clean") && System.nanoTime()-reloadStart<TimeUnit.SECONDS.toNanos(1),"reloadCancelsPendingUpgrade");
            HubTls.Route retiredRoute=core.prepare(rotating,key,c->{}); core.forget(rotating,key,retiredRoute); HubTls.Route replacementRoute=core.prepare(rotating,key,c->{});
            core.forget(rotating,key,retiredRoute); check(core.prepare(rotating,key,c->{throw new IOException("old callback evicted fresh route");})==replacementRoute,"oldFailureCannotEvictNewRoute");
            for(int i=0;i<8;i++) { String peerClosing=socket(rotating); transport.socketSend(peerClosing,"$audit:peer-close"); JSONObject remoteClose=event(peerClosing,"close"); check(remoteClose.getBoolean("clean") && remoteClose.getInt("code")==3333,"peerInitiatedCloseStatus"); }
            waitUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(3); JSONObject closeStats;
            do { closeStats=new JSONObject(command(stdin,output,"stats")); if(closeStats.getInt("peerCloseConfirmed")+closeStats.getInt("peerCloseAborted")>=8) break; Thread.sleep(10); } while(System.nanoTime()<waitUntil);
            check(closeStats.getInt("peerCloseConfirmed")==8 && closeStats.getInt("peerCloseAborted")==0,"peerReceivesCloseReplies");
            String countClose=socket(rotating); transport.socketSend(countClose,"$audit:count-close"); JSONObject counting=event(countClose,"message"); transport.socketAck(countClose,counting.getLong("sequence"));
            transport.socketClose(countClose,3334,"once"); check(event(countClose,"close").getBoolean("clean"),"countedCloseHandshake");
            check(new JSONObject(command(stdin,output,"stats")).getInt("clientCloseFrames")==1,"exactlyOneClientCloseFrame");
            String ignored=socket(rotating); transport.socketSend(ignored,"$audit:ignore-close"); JSONObject ignoring=event(ignored,"message"); transport.socketAck(ignored,ignoring.getLong("sequence"));
            transport.socketClose(ignored,1000,""); JSONObject unanswered=event(ignored,"close"); check(!unanswered.getBoolean("clean") && unanswered.getInt("code")==1006,"noPeerCloseIsNotClean");
            String byteCredit=socket(rotating); transport.socketSend(byteCredit,"$audit:byte-burst"); JSONObject firstLarge=event(byteCredit,"message"); Thread.sleep(150);
            synchronized(events) { boolean extra=false; for(JSONObject e:events) if(byteCredit.equals(e.optString("id")) && "message".equals(e.optString("kind"))) extra=true; check(!extra,"incomingByteCreditsBoundBridge"); }
            transport.socketAck(byteCredit,firstLarge.getLong("sequence")); JSONObject secondLarge=event(byteCredit,"message"); transport.socketAck(byteCredit,secondLarge.getLong("sequence")); event(byteCredit,"message"); transport.cancel(byteCredit);
            String stalledSocket=socket(rotating); transport.socketSend(stalledSocket,"$audit:stall-writes"); JSONObject stallReady=event(stalledSocket,"message"); transport.socketAck(stalledSocket,stallReady.getLong("sequence"));
            String largeSend=String.join("",Collections.nCopies(HubTls.MAX_FRAME,"x")); int accepted=0;
            for(;accepted<128;accepted++) { try { transport.socketSend(stalledSocket,largeSend); } catch(IOException limited) { break; } }
            check(accepted<128,"outgoingBackpressureBounded"); result.put("acceptedBeforeBackpressure",accepted); long cancelStart=System.nanoTime(); transport.cancel(stalledSocket); check(System.nanoTime()-cancelStart<TimeUnit.SECONDS.toNanos(1),"cancelBlockedSocketWriterPromptly");
            String stalledClose=socket(rotating); transport.socketSend(stalledClose,"$audit:stall-writes"); JSONObject closeReady=event(stalledClose,"message"); transport.socketAck(stalledClose,closeReady.getLong("sequence"));
            for(int i=0;i<80;i++) { try { transport.socketSend(stalledClose,largeSend); } catch(IOException limited) {} Thread.sleep(10); }
            command(stdin,output,"ws-close-all"); JSONObject noWrittenClose=event(stalledClose,"close");
            check(!noWrittenClose.getBoolean("clean") && noWrittenClose.getInt("code")==1006,"unwrittenCloseReplyIsNotClean");
            List<String> quota=new ArrayList<>(); for(int i=0;i<8;i++) quota.add(transport.allocate("socket",document));
            rejects(()->transport.allocate("socket",document),"socketAggregateQuota"); for(String id:quota) transport.cancel(id);
            String afterQuota=socket(rotating); transport.socketSend(afterQuota,"recovered"); check(event(afterQuota,"message").getString("data").equals("recovered"),"socketQuotaRecovers"); transport.cancel(afterQuota);
            HubTls.Route resolved=core.prepare(rotating,key,c->{});
            HubTls.Route multipleAddresses=new HubTls.Route(resolved.base,resolved.client.newBuilder().dns(host->Arrays.asList(java.net.InetAddress.getByName("127.0.0.2"),java.net.InetAddress.getByName("127.0.0.1"))).build());
            ScheduledThreadPoolExecutor isolatedDeadline=new ScheduledThreadPoolExecutor(1); CountDownLatch fallbackOpen=new CountDownLatch(1),fallbackMessage=new CountDownLatch(1); java.util.concurrent.atomic.AtomicInteger fallbackFailures=new java.util.concurrent.atomic.AtomicInteger();
            HubSocket alternative=new HubSocket(multipleAddresses,new HubSocket.Listener() {
                public void opened() { fallbackOpen.countDown(); }
                public void message(String text) { if(text.equals("address fallback")) fallbackMessage.countDown(); }
                public void closed(int code,String reason,boolean clean) { }
                public void failed(Exception error) { fallbackFailures.incrementAndGet(); }
            },isolatedDeadline);
            try { alternative.start(); check(fallbackOpen.await(3,TimeUnit.SECONDS) && alternative.sendText("address fallback") && fallbackMessage.await(3,TimeUnit.SECONDS),"alternateAddressUsesSamePinnedTls"); }
            finally { alternative.cancel(); alternative.onError(new SSLException("test late cancellation error")); isolatedDeadline.shutdownNow(); }
            check(fallbackFailures.get()==0,"lateCancelErrorDoesNotReportFailure");
            CountDownLatch openingFailed=new CountDownLatch(1); java.util.concurrent.atomic.AtomicInteger openingFailures=new java.util.concurrent.atomic.AtomicInteger(),lateOpens=new java.util.concurrent.atomic.AtomicInteger();
            ScheduledThreadPoolExecutor quickDeadline=new ScheduledThreadPoolExecutor(1) {
                @Override public ScheduledFuture<?> schedule(Runnable task,long delay,TimeUnit unit) { return super.schedule(task,unit.toSeconds(delay)==10?100:unit.toMillis(delay),TimeUnit.MILLISECONDS); }
            };
            HubTls.Route slowDns=new HubTls.Route(resolved.base,resolved.client.newBuilder().dns(host->{ try { Thread.sleep(400); } catch(InterruptedException error) { Thread.currentThread().interrupt(); } return Collections.singletonList(java.net.InetAddress.getByName("127.0.0.1")); }).build());
            HubSocket pendingDns=new HubSocket(slowDns,new HubSocket.Listener() {
                public void opened() { lateOpens.incrementAndGet(); }
                public void message(String text) { }
                public void closed(int code,String reason,boolean clean) { }
                public void failed(Exception error) { openingFailures.incrementAndGet(); openingFailed.countDown(); }
            },quickDeadline);
            Future<?> starting=worker.submit(pendingDns::start);
            try { check(openingFailed.await(300,TimeUnit.MILLISECONDS),"openingDeadlineReportsDuringDns"); starting.get(2,TimeUnit.SECONDS); check(openingFailures.get()==1 && lateOpens.get()==0,"openingTimeoutIsTerminalExactlyOnce"); }
            finally { pendingDns.cancel(); quickDeadline.shutdownNow(); }
            String abruptly=socket(rotating); transport.socketSend(abruptly,"$audit:terminate"); JSONObject abrupt=event(abruptly,"close"); check(!abrupt.getBoolean("clean") && abrupt.getInt("code")==1006,"abruptEofNotClean");
            // Prewarm another independent route cache to check both stale HTTP and WS pins.
            get(rotating,"/health");
            HubTls secondCore=new HubTls(trust(scratch.resolve("ca.der"))); secondCore.prepare(rotating,key,c->{});
            try(HubTransport second=new HubTransport(secondCore,e->{ synchronized(events) { events.add(e); events.notifyAll(); } })) {
                check("ok".equals(command(stdin,output,"rotate")),"certificateRotated");
                rejects(()->get(rotating,"/health"),"staleHttpPinRejected");
                String secondDocument=second.document(),staleSocket=second.allocate("socket",secondDocument); second.socketOpen(staleSocket,rotating,key);
                JSONObject staleClose=event(staleSocket,"close"); check(!staleClose.getBoolean("clean"),"staleSocketPinRejected");
                check(new JSONObject(get(rotating,"/health")).getBoolean("ok"),"freshSignedRotationRecovers");
            }
            check(domainPolicy.hostCalls>0 && domainPolicy.unawareCalls==0,"hostAwareTrustPreserved");
            JSONObject stats=new JSONObject(command(stdin,output,"stats")); check(stats.getInt("sensitive")==0 && stats.getInt("proofs")>=3,"zeroProxyCredentialsOrPayloads"); check(stats.getInt("acceptedDroppedUploads")==1,"uploadDeliveredOnlyOnce"); result.put("proxy",stats); ok=true;
        } catch(Throwable error) { result.put("error",error.toString()); error.printStackTrace(); }
        finally {
            if(transport!=null) transport.close(); worker.shutdownNow();
            if(fixture!=null) { fixture.destroy(); if(!fixture.waitFor(5,TimeUnit.SECONDS)) fixture.destroyForcibly().waitFor(); }
            result.put("ok",ok); Files.write(receipt,result.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        System.exit(ok?0:1);
    }
}
