package com.tarobot.client;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
import android.app.KeyguardManager;
import android.os.PowerManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
    private volatile boolean screenForeground;
    private boolean screenReceiverRegistered;
    private final BroadcastReceiver screenReceiver=new BroadcastReceiver() {
        @Override public void onReceive(Context context,Intent intent) {
            // SCREEN_OFF may arrive after a rapid unlock/onResume. Retire only
            // when the device is still locked/off; onPause already closed the
            // old group synchronously, and must not kill a fresh explicit join.
            if(!screenUnlocked()) retireScreens("screen_locked");
        }
    };
    private boolean screenActive() { return screenForeground&&screenReceiverRegistered&&screenUnlocked(); }
    private boolean screenUnlocked() {
        PowerManager power=(PowerManager)getContext().getSystemService(Context.POWER_SERVICE);
        KeyguardManager lock=(KeyguardManager)getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return power!=null&&power.isInteractive()&&lock!=null&&!lock.isKeyguardLocked();
    }
    private void retireScreens(String reason) { screenForeground=false; if(transport!=null) transport.closeScreens(reason); }
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
            getBridge().execute(()->{ if(epoch.get()==generation && (!event.has("document") || transport!=null&&transport.screenEventCurrent(event))) notifyListeners("socket",payload); });
        },this::screenActive); getBridge().addWebViewListener(navigation); }
        catch(Exception error) { transport=null; return; }
        // Failure of a screen-only lifecycle observer must not disable chat/HTTP.
        try { getContext().registerReceiver(screenReceiver,new IntentFilter(Intent.ACTION_SCREEN_OFF)); screenReceiverRegistered=true; }
        catch(RuntimeException error) { screenForeground=false; }
    }
    private void perform(PluginCall call, Operation operation) {
        if(transport==null) { call.reject("native_transport_unavailable"); return; }
        try { io.execute(()->complete(call,operation)); }
        catch(RejectedExecutionException error) { call.reject("native_transport_busy"); }
    }
    // Control receipts cannot wait behind 32 blocked HTTP reads. These operations
    // only update bounded state / enqueue a socket frame, never wait for network IO.
    private void complete(PluginCall call,Operation operation) { try { if(transport==null) throw new IOException("native_transport_unavailable"); call.resolve(operation.run()); } catch(Exception error) { call.reject(HubTls.classifyError(error)); } }
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
        perform(call,()->{ transport.socketOpen(text(call,"id"),text(call,"origin"),call.getString("hubKey"),call.getString("certificateAuthority"),Boolean.TRUE.equals(call.getBoolean("edgeTls",false))); return new JSObject(); });
    }
    @PluginMethod public void socketSend(PluginCall call) { complete(call,()->{ transport.socketSend(text(call,"id"),text(call,"text")); return new JSObject(); }); }
    @PluginMethod public void socketAck(PluginCall call) { complete(call,()->{ Double sequence=call.getDouble("sequence"); if(sequence==null || sequence<0 || sequence>9007199254740991d || sequence!=Math.floor(sequence)) throw new IOException("invalid_socket_receipt"); transport.socketAck(text(call,"id"),sequence.longValue()); return new JSObject(); }); }
    @PluginMethod public void socketClose(PluginCall call) { complete(call,()->{ Integer code=call.getInt("code"); if(code==null) throw new IOException("invalid_socket_close"); return value(transport.socketClose(text(call,"id"),code,text(call,"reason"))); }); }
    private void screenComplete(PluginCall call,Operation operation,boolean asynchronous,boolean closing) {
        long generation=epoch.get();
        Runnable run=()->{ try {
            if(transport==null||epoch.get()!=generation) throw new IOException("native_document_retired");
            JSObject result=operation.run();
            if(epoch.get()!=generation||transport==null||!closing&&!transport.screenCurrent(text(call,"id"))) throw new IOException("native_document_retired");
            call.resolve(result);
        } catch(Exception error) { call.reject(HubTls.classifyError(error)); } };
        if(!asynchronous) { run.run(); return; }
        try { io.execute(run); } catch(RejectedExecutionException error) { call.reject("native_transport_busy"); }
    }
    private static long integer(PluginCall call,String name,long min,long max) throws IOException { Double value=call.getDouble(name); if(value==null||!Double.isFinite(value)||value<min||value>max||value!=Math.floor(value)) throw new IOException("invalid_screen_input"); return value.longValue(); }
    @PluginMethod public void screenOpen(PluginCall call) {
        if(!screenActive()||!hasListeners("socket")) { if(transport!=null) transport.cancel(call.getString("id")); call.reject("screen_inactive"); return; }
        screenComplete(call,()->{ transport.screenOpen(text(call,"id"),call.getObject("network"),call.getObject("join")); return new JSObject(); },true,false);
    }
    @PluginMethod public void screenSend(PluginCall call) {
        JSObject command=call.getObject("command");
        boolean retiring=command!=null&&("disconnect".equals(command.opt("type"))||"visibility".equals(command.opt("type"))&&Boolean.FALSE.equals(command.opt("visible")));
        screenComplete(call,()->{ transport.screenSend(text(call,"id"),command); return new JSObject(); },false,retiring);
    }
    @PluginMethod public void screenRead(PluginCall call) { screenComplete(call,()->{ JSObject result=new JSObject(); result.put("data",Base64.toBase64String(transport.screenRead(text(call,"id"),integer(call,"deliverySequence",1,9007199254740991L),(int)integer(call,"offset",0,1048576),(int)integer(call,"maxBytes",1,262144)))); return result; },false,false); }
    @PluginMethod public void screenAck(PluginCall call) { screenComplete(call,()->{ transport.screenAck(text(call,"id"),integer(call,"deliverySequence",1,9007199254740991L)); return new JSObject(); },false,false); }
    @PluginMethod public void screenClose(PluginCall call) { screenComplete(call,()->value(transport.screenClose(text(call,"id"))),false,true); }
    /** The most packets of one stream generation this layer holds for the page (see HubScreenSession.BINARY_WINDOW). */
    @PluginMethod public void screenWindow(PluginCall call) { call.resolve(value(HubScreenSession.BINARY_WINDOW)); }
    @Override protected void handleOnResume() { screenForeground=true; }
    @Override protected void handleOnPause() { retireScreens("screen_inactive"); }
    @Override protected void handleOnStop() { retireScreens("screen_inactive"); }
    @Override protected void handleOnDestroy() { retireScreens("screen_disconnected"); if(screenReceiverRegistered) { getContext().unregisterReceiver(screenReceiver); screenReceiverRegistered=false; } epoch.incrementAndGet(); getBridge().removeWebViewListener(navigation); if(transport!=null) transport.close(); io.shutdownNow(); }
}
