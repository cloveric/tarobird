package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Tests the actual Capacitor WebView/OS decoder; browser E2E covers Hub delivery
 * and the React attachment controls. No paired host, real media or audio output. */
@RunWith(AndroidJUnit4.class)
public class MediaPlaybackTest {
    private MainActivity activity;
    private String js(String code) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation();
        var result = new AtomicReference<String>(); var done = new CountDownLatch(1);
        instrument.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void until(String expression) throws Exception {
        long deadline = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(js(expression))) return;
            Thread.sleep(100);
        }
        fail("Playback condition failed: " + expression + "; " + js("({error:window.probe?.error?.code,playError:window.playError,time:window.probe?.currentTime,ready:window.probe?.readyState})"));
    }
    @Test public void standardAudioAndH264VideoPlayPauseAndSeekInNativeWebView() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var context = instrument.getTargetContext();
        assertTrue("Disposable app only", context.getPackageName().endsWith(".mediatest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            until("!!document.body && !!window.Capacitor");
            String[][] formats = {{"tone.wav", "audio/wav"}, {"tone.mp3", "audio/mpeg"}, {"tone.m4a", "audio/mp4"}, {"clip.mp4", "video/mp4"}};
            for (String[] format : formats) {
                byte[] bytes;
                try (var input = instrument.getContext().getAssets().open(format[0])) { bytes = input.readAllBytes(); }
                String encoded = Base64.encodeToString(bytes, Base64.NO_WRAP);
                js("window.playError=null;window.probe=document.createElement(" + JSONObject.quote(format[1].startsWith("video/") ? "video" : "audio") + ");" +
                    "probe.controls=true;probe.muted=true;probe.playsInline=true;probe.style.cssText='position:fixed;top:0;left:0;width:300px;height:180px;z-index:2147483647';document.body.appendChild(probe);" +
                    "probe.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(" + JSONObject.quote(encoded) + "),c=>c.charCodeAt(0))],{type:" + JSONObject.quote(format[1]) + "}));");
                until("probe.readyState>=2 && Number.isFinite(probe.duration) && probe.duration>2");
                js("probe.play().catch(e=>window.playError=e.message)");
                until("probe.currentTime>.2 && !probe.paused && !probe.error");
                js("probe.pause();probe.currentTime=1.5");
                until("probe.paused && !probe.seeking && Math.abs(probe.currentTime-1.5)<.15");
                js("probe.play().catch(e=>window.playError=e.message)");
                until("probe.currentTime>1.7 && !probe.error");
                var result = new JSONObject(js("({duration:probe.duration,time:probe.currentTime,width:probe.videoWidth||0,height:probe.videoHeight||0,frames:probe.getVideoPlaybackQuality?.().totalVideoFrames||0})"));
                if (format[1].startsWith("video/")) {
                    assertEquals(160, result.getInt("width")); assertEquals(90, result.getInt("height")); assertTrue(result.getInt("frames") > 0);
                }
                System.out.println("NATIVE_MEDIA_OK " + format[0] + " " + result);
                js("probe.pause();URL.revokeObjectURL(probe.src);probe.remove();window.probe=null");
            }
        } finally { instrument.runOnMainSync(() -> activity.finish()); }
    }
}
