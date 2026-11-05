package com.tarobot.client;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
import java.io.IOException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.bouncycastle.util.encoders.Base64;

@CapacitorPlugin(name="TaroCubHubTransport")
public class HubTransportPlugin extends Plugin {
    private final ThreadPoolExecutor io=new ThreadPoolExecutor(32,32,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(64));
    private HubTransport transport;
    private final AtomicLong epoch=new AtomicLong();
    private final WebViewListener navigation=new WebViewListener() {
        @Override public void onPageStarted(WebView webView) { getBridge().execute(()->{ epoch.incrementAndGet(); removeAllListeners(); if(transport!=null) transport.reset(); }); }
    };
    private interface Operation { JSObject run() throws Exception; }
    @Override public void load() {
        io.allowCoreThreadTimeOut(true);
        try { transport=new HubTransport(new HubTls(),event->{
            long generation=epoch.get();
            // Convert inside the transport's error boundary, before queuing the
            // Runnable: Capacitor's JSONObject conversion can throw on Android.
            JSObject payload=JSObject.fromJSONObject(event);
            getBridge().execute(()->{ if(epoch.get()==generation) notifyListeners("socket",payload); });
        }); getBridge().addWebViewListener(navigation); }
        catch(Exception error) { transport=null; }
    }
    private void perform(PluginCall call, Operation operation) {
        if(transport==null) { call.reject("native_transport_unavailable"); return; }
        try { io.execute(()->complete(call,operation)); }
        catch(RejectedExecutionException error) { call.reject("native_transport_busy"); }
    }
    // Control receipts cannot wait behind 32 blocked HTTP reads. These operations
    // only update bounded state / enqueue a socket frame, never wait for network IO.
    private void complete(PluginCall call,Operation operation) { try { if(transport==null) throw new IOException("native_transport_unavailable"); call.resolve(operation.run()); } catch(Exception error) { call.reject(error instanceof IOException?error.getMessage():"native_transport_failed"); } }
    private static JSObject value(Object value) { JSObject result=new JSObject(); result.put("value",value); return result; }
    private static String text(PluginCall call, String name) throws IOException { String value=call.getString(name); if(value==null) throw new IOException("invalid_native_input"); return value; }
    // Claim synchronously on the ordered bridge thread before later operations.
    @PluginMethod public void document(PluginCall call) { try { if(transport==null) throw new IOException("native_transport_unavailable"); epoch.incrementAndGet(); removeAllListeners(); call.resolve(value(transport.document())); } catch(Exception error) { call.reject("native_transport_unavailable"); } }
    @PluginMethod public void allocate(PluginCall call) { complete(call,()->value(transport.allocate(text(call,"kind"),text(call,"document")))); }
    @PluginMethod public void cancel(PluginCall call) { if(transport!=null) transport.cancel(call.getString("id")); call.resolve(); }
    @PluginMethod public void httpOpen(PluginCall call) { perform(call,()->JSObject.fromJSONObject(transport.httpOpen(text(call,"id"),call.getObject("input")))); }
    @PluginMethod public void httpRead(PluginCall call) { perform(call,()->{ JSObject result=new JSObject(); result.put("data",Base64.toBase64String(transport.httpRead(text(call,"id")))); return result; }); }
    @PluginMethod public void socketOpen(PluginCall call) {
        if(!hasListeners("socket")) { if(transport!=null) transport.cancel(call.getString("id")); call.reject("native_socket_listener_required"); return; }
        perform(call,()->{ transport.socketOpen(text(call,"id"),text(call,"origin"),call.getString("hubKey"),call.getString("certificateAuthority")); return new JSObject(); });
    }
    @PluginMethod public void socketSend(PluginCall call) { complete(call,()->{ transport.socketSend(text(call,"id"),text(call,"text")); return new JSObject(); }); }
    @PluginMethod public void socketAck(PluginCall call) { complete(call,()->{ Double sequence=call.getDouble("sequence"); if(sequence==null || sequence<0 || sequence>9007199254740991d || sequence!=Math.floor(sequence)) throw new IOException("invalid_socket_receipt"); transport.socketAck(text(call,"id"),sequence.longValue()); return new JSObject(); }); }
    @PluginMethod public void socketClose(PluginCall call) { complete(call,()->{ Integer code=call.getInt("code"); if(code==null) throw new IOException("invalid_socket_close"); return value(transport.socketClose(text(call,"id"),code,text(call,"reason"))); }); }
    @Override protected void handleOnDestroy() { epoch.incrementAndGet(); getBridge().removeWebViewListener(navigation); if(transport!=null) transport.close(); io.shutdownNow(); }
}
