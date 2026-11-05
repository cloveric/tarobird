package com.tarobot.client;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/** One instance per Capacitor WebView. The bridge serializes UI emissions;
 * blocking HTTP reads execute off the UI thread. All queued native work is
 * fenced by its allocated slot, including work racing page reload/cancellation. */
final class HubTransport implements AutoCloseable {
    interface Events { void send(JSONObject event) throws org.json.JSONException; }
    private static final int BODY_LIMIT = 8 * 1024 * 1024, READ_BYTES = 256 * 1024, CREDITS = 8;
    private final HubTls network;
    private final Events events;
    private final Map<String, Slot> slots = new HashMap<>();
    private int retiringHttp;
    private final java.util.concurrent.ThreadPoolExecutor cleanup = new java.util.concurrent.ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,new java.util.concurrent.ArrayBlockingQueue<>(32));
    private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1);
    private String document;
    private int uploadBytes;
    private static final int UPLOAD_BUDGET = 32 * 1024 * 1024;
    private boolean destroyed;
    private static final class Slot {
        final String id, document, kind;
        final Object reader = new Object();
        boolean cancelled, started, open, closing, terminal, eof;
        long sent, acknowledged;
        int outstandingBytes;
        final java.util.LinkedHashMap<Long,Integer> credits = new java.util.LinkedHashMap<>();
        Call call;
        Response response;
        byte[] readBuffer;
        HubSocket socket;
        ScheduledFuture<?> deadline;
        Slot(String id, String document, String kind) { this.id=id; this.document=document; this.kind=kind; }
    }
    HubTransport(HubTls network, Events events) { this.network=network; this.events=events; deadlines.setRemoveOnCancelPolicy(true); cleanup.allowCoreThreadTimeOut(true); }
    synchronized String document() throws IOException {
        if (destroyed) throw new IOException("native_transport_destroyed");
        reset();
        document = UUID.randomUUID().toString(); return document;
    }
    synchronized void reset() { document=null; for(Slot slot:new ArrayList<>(slots.values())) cancel(slot); }
    synchronized String allocate(String kind, String document) throws IOException {
        if (destroyed || this.document == null || !this.document.equals(document)) throw new IOException("native_document_retired");
        if (!kind.equals("http") && !kind.equals("socket")) throw new IOException("invalid_native_kind");
        int count=0; for (Slot slot : slots.values()) if (slot.kind.equals(kind)) count++;
        if (count + (kind.equals("http") ? retiringHttp : 0) >= (kind.equals("http") ? 32 : 8)) throw new IOException("native_transport_busy");
        Slot slot = new Slot(UUID.randomUUID().toString(), document, kind); slots.put(slot.id, slot);
        slot.deadline=deadlines.schedule(() -> { synchronized (HubTransport.this) { if (slots.get(slot.id)==slot) cancel(slot); } },kind.equals("http")?300:1200,TimeUnit.SECONDS);
        return slot.id;
    }
    private synchronized Slot get(String id, String kind) throws IOException {
        Slot slot=slots.get(id); if (slot==null || slot.cancelled || !slot.kind.equals(kind) || !slot.document.equals(document)) throw new IOException("native_request_cancelled"); return slot;
    }
    private synchronized void alive(Slot slot) throws IOException {
        if (destroyed || slot.cancelled || slots.get(slot.id)!=slot || !slot.document.equals(document)) throw new IOException("native_request_cancelled");
    }
    private synchronized void start(Slot slot) throws IOException { alive(slot); if(slot.started) throw new IOException("native_request_already_started"); slot.started=true; }
    private synchronized void track(Slot slot, Call call) throws IOException { try { alive(slot); slot.call=call; } catch(IOException error) { call.cancel(); throw error; } }
    synchronized void cancel(String id) { Slot slot=slots.get(id); if(slot!=null) cancel(slot); }
    private void cancel(Slot slot) {
        if(slot.cancelled) return;
        slot.cancelled=true; slots.remove(slot.id); notifyAll();
        if(slot.deadline!=null) slot.deadline.cancel(false);
        if(slot.call!=null) try { slot.call.cancel(); } catch(RuntimeException ignored) { }
        if(slot.socket!=null) try { slot.socket.cancel(); } catch(RuntimeException ignored) { }
        if(slot.response!=null) {
            // Cross-thread cancellation only aborts the Call. Body.close() may
            // mutate Okio's read buffer; serialize disposal with the reader on
            // a separate executor, never under the global transport monitor.
            retiringHttp++; Response response=slot.response;
            cleanup.execute(()->{
                try { synchronized(slot.reader) { response.close(); } }
                finally { synchronized(HubTransport.this) { retiringHttp--; } }
            });
        }
        if(slot.kind.equals("socket")) terminal(slot,1006,"",false);
    }
    private synchronized void reserveUpload(Slot slot,int count) throws IOException {
        alive(slot); if(count>UPLOAD_BUDGET-uploadBytes) throw new IOException("native_upload_backpressure"); uploadBytes+=count;
    }
    private synchronized void releaseUpload(int count) { uploadBytes-=count; }
    private static final class UploadBody extends RequestBody {
        byte[] bytes; final int length;
        UploadBody(byte[] bytes) { this.bytes=bytes; length=bytes.length; }
        @Override public MediaType contentType() { return null; }
        @Override public long contentLength() { return length; }
        @Override public boolean isOneShot() { return true; }
        @Override public void writeTo(okio.BufferedSink sink) throws IOException {
            byte[] data=bytes; if(data==null) throw new IOException("native_upload_retired"); sink.write(data);
        }
        void retire() { bytes=null; }
    }
    private static String string(JSONObject value, String name) throws IOException { Object raw=value.opt(name); if(!(raw instanceof String)) throw new IOException("invalid_native_input"); return (String)raw; }
    JSONObject httpOpen(String id, JSONObject input) throws Exception {
        Slot slot=get(id,"http"); start(slot);
        String origin=null, key=null; HubTls.Route activeRoute=null; int reserved=0; UploadBody payload=null;
        try {
            origin=string(input,"origin"); key=input.isNull("hubKey")?null:string(input,"hubKey");
            String method=string(input,"method");
            if(!Arrays.asList("GET","HEAD","POST","PUT","PATCH","DELETE").contains(method)) throw new IOException("invalid_http_method");
            String body=input.isNull("body")?null:string(input,"body");
            if(body!=null && (body.length()>((BODY_LIMIT+2)/3)*4 || method.equals("GET") || method.equals("HEAD"))) throw new IOException("invalid_http_body");
            if(body!=null) {
                int estimate=body.length()/4*3-(body.endsWith("==")?2:body.endsWith("=")?1:0);
                if(estimate<0 || estimate>BODY_LIMIT || body.length()%4!=0) throw new IOException("invalid_http_body");
                reserveUpload(slot,estimate); reserved=estimate;
            }
            byte[] bytes=body==null?null:HubTls.decode(body);
            if(bytes!=null && bytes.length>BODY_LIMIT) throw new IOException("native_body_too_large");
            JSONArray headers=input.getJSONArray("headers"); if(headers.length()>32) throw new IOException("invalid_http_headers");
            HubTls.Route route=network.prepare(origin,key,input.has("certificateAuthority") ? string(input,"certificateAuthority") : null,call->track(slot,call)); activeRoute=route; alive(slot);
            Request.Builder request=new Request.Builder().url(HubTls.target(route.base,string(input,"path"))); int total=0;
            for(int i=0;i<headers.length();i++) {
                JSONArray pair=headers.getJSONArray(i); if(pair.length()!=2) throw new IOException("invalid_http_headers");
                Object name=pair.get(0), value=pair.get(1); if(!(name instanceof String) || !(value instanceof String)) throw new IOException("invalid_http_headers");
                total+=((String)name).length()+((String)value).length();
                if(total>16384 || !Arrays.asList("authorization","content-type","accept","range","if-range","if-none-match").contains(((String)name).toLowerCase(Locale.ROOT))) throw new IOException("invalid_http_headers");
                request.addHeader((String)name,(String)value);
            }
            payload=bytes!=null?new UploadBody(bytes):Arrays.asList("POST","PUT","PATCH").contains(method)?new UploadBody(new byte[0]):null;
            Call call=route.client.newCall(request.method(method,payload).build()); call.timeout().timeout(300,TimeUnit.SECONDS); track(slot,call);
            Response response=call.execute();
            boolean accepted=false;
            try { synchronized(this) {
                alive(slot);
                if(response.code()>=300 && response.code()<400 && response.code()!=304) throw new IOException("hub_redirect_rejected");
                slot.response=response; accepted=true;
            } } finally { if(!accepted) response.close(); }
            JSONArray fields=new JSONArray(); for(int i=0;i<response.headers().size();i++) fields.put(new JSONArray().put(response.headers().name(i)).put(response.headers().value(i)));
            return new JSONObject().put("status",response.code()).put("headers",fields);
        } catch(Exception error) { if(HubTls.trustFailure(error)) network.forget(origin,key,activeRoute); cancel(id); throw error; }
        finally { if(payload!=null) payload.retire(); releaseUpload(reserved); }
    }
    byte[] httpRead(String id) throws Exception {
        Slot slot=get(id,"http");
        try { synchronized(slot.reader) {
            alive(slot); Response response; synchronized(this) { response=slot.response; }
            if(response==null || response.body()==null) throw new IOException("native_response_unavailable");
            if(slot.eof) { cancel(id); return new byte[0]; }
            // OkHttp commonly exposes 8 KiB segments. Coalesce into one bounded
            // IPC chunk instead of 65,536 bridge round trips per 512 MiB file.
            // The per-slot buffer also avoids allocating 256 KiB for every 8 KiB.
            if(slot.readBuffer==null) slot.readBuffer=new byte[READ_BYTES];
            int used=0;
            while(used<READ_BYTES) {
                int n=response.body().byteStream().read(slot.readBuffer,used,READ_BYTES-used); alive(slot);
                if(n<0) { slot.eof=true; break; }
                used+=n;
            }
            if(used==0) { cancel(id); return new byte[0]; }
            return Arrays.copyOf(slot.readBuffer,used);
        } } catch(Exception error) { cancel(id); throw error; }
    }
    void socketOpen(String id, String origin, String key) throws Exception { socketOpen(id,origin,key,null); }
    void socketOpen(String id, String origin, String key, String authority) throws Exception {
        Slot slot=get(id,"socket"); start(slot);
        try {
            HubTls.Route route=network.prepare(origin,key,authority,call->track(slot,call));
            HubSocket socket=new HubSocket(route,new HubSocket.Listener() {
                public void opened() { synchronized(HubTransport.this) {
                    if(slot.cancelled || slots.get(slot.id)!=slot) { slot.socket.cancel(); return; }
                    slot.open=true; emit(slot,"open");
                } }
                public void message(String text) {
                    int bytes=text.getBytes(StandardCharsets.UTF_8).length;
                    synchronized(HubTransport.this) {
                        // A background WebView may stop acknowledging for an
                        // arbitrary duration. Keep the bounded receive window
                        // and apply backpressure instead of expiring a healthy
                        // socket while JS is suspended. Ack, close, cancellation
                        // and document retirement all wake this waiter.
                        while(!slot.cancelled && !slot.closing && !slot.terminal &&
                              (slot.sent-slot.acknowledged>=CREDITS || slot.outstandingBytes+bytes>HubTls.MAX_FRAME)) {
                            try { HubTransport.this.wait(); }
                            catch(InterruptedException error) { Thread.currentThread().interrupt(); cancel(slot); return; }
                        }
                        if(slot.cancelled || slot.closing || slot.terminal) return;
                        slot.outstandingBytes+=bytes; slot.credits.put(++slot.sent,bytes);
                        emit(slot,"message","data",text,"sequence",slot.sent);
                    }
                }
                public void closed(int code,String reason,boolean clean) { synchronized(HubTransport.this) { terminal(slot,code,reason,clean); } }
                public void failed(Exception error) {
                    synchronized(HubTransport.this) {
                        if(slot.cancelled || slot.terminal) return;
                        emit(slot,"error","error","native_socket_failed"); terminal(slot,1006,"",false);
                    }
                    if(HubTls.trustFailure(error)) network.forget(origin,key,route);
                }
            },deadlines);
            synchronized(this) { alive(slot); slot.socket=socket; }
            socket.start();
        } catch(Exception error) { cancel(id); throw error; }
    }
    synchronized void socketSend(String id, String text) throws Exception {
        Slot slot=get(id,"socket");
        if(!slot.open || slot.closing || text.getBytes(StandardCharsets.UTF_8).length>HubTls.MAX_FRAME) throw new IOException("native_socket_not_open");
        if(!slot.socket.sendText(text)) throw new IOException("native_socket_backpressure");
    }
    synchronized void socketAck(String id, long sequence) throws Exception {
        Slot slot=get(id,"socket"); if(sequence<0 || sequence>slot.sent) throw new IOException("invalid_socket_receipt");
        slot.acknowledged=Math.max(slot.acknowledged,sequence);
        java.util.Iterator<Map.Entry<Long,Integer>> it=slot.credits.entrySet().iterator();
        while(it.hasNext()) { Map.Entry<Long,Integer> credit=it.next(); if(credit.getKey()<=slot.acknowledged) { slot.outstandingBytes-=credit.getValue(); it.remove(); } }
        notifyAll();
    }
    synchronized boolean socketClose(String id, int code, String reason) throws Exception {
        Slot slot=slots.get(id); if(slot==null || slot.cancelled || !slot.kind.equals("socket")) return false;
        if(!(code==1000 || code>=3000 && code<5000) || reason.getBytes(StandardCharsets.UTF_8).length>123) throw new IOException("invalid_socket_close");
        if(!slot.open) { cancel(slot); return false; }
        slot.closing=true; notifyAll(); return slot.socket.beginClose(code,reason);
    }
    private void emit(Slot slot, String kind, Object... extra) {
        try { JSONObject event=new JSONObject().put("id",slot.id).put("kind",kind); for(int i=0;i<extra.length;i+=2) event.put((String)extra[i],extra[i+1]); events.send(event); }
        catch(Exception error) { if(!slot.terminal) cancel(slot); }
    }
    private void terminal(Slot slot, int code, String reason, boolean clean) {
        if(slot.terminal) return; slot.terminal=true; slot.open=false; slots.remove(slot.id); notifyAll();
        if(slot.deadline!=null) slot.deadline.cancel(false);
        slot.credits.clear(); slot.outstandingBytes=0;
        emit(slot,"close","code",code,"reason",reason,"clean",clean);
    }
    public synchronized void close() {
        if(destroyed) return;
        destroyed=true; for(Slot slot:new ArrayList<>(slots.values())) cancel(slot); deadlines.shutdownNow();
        // Activity destruction runs on Android's main thread. Evicting pooled
        // TLS connections may send close_notify; do it after the bounded body
        // cleanup queue, never on the UI thread (NetworkOnMainThreadException).
        cleanup.execute(network::close); cleanup.shutdown();
    }
}
