package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.view.inputmethod.InputMethodManager;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.MotionEvent;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual packaged WebView + Capacitor plugins + Keystore + pinned LAN TLS.
 * Requires an isolated test application ID; never opens the user's app data. */
@RunWith(AndroidJUnit4.class)
public class PairingJourneyTest {
    private MainActivity activity;
    private String js(String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView callback timed out", done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void waitFor(String expression) throws Exception {
        long until = System.currentTimeMillis() + 30000;
        while (System.currentTimeMillis() < until) { if ("true".equals(js(expression))) return; Thread.sleep(150); }
        fail("UI condition failed: " + expression + "\n" + js("document.body.innerText")
            + "\n" + js("JSON.stringify({links:Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(e=>({href:e.href,loaded:!!e.sheet})),resources:performance.getEntriesByType('resource').filter(e=>/assets/.test(e.name)).map(e=>({name:e.name,duration:e.duration})),sw:navigator.serviceWorker?.controller?.state})"));
    }
    private void click(String label) throws Exception {
        String selector = "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===" + JSONObject.quote(label) + " && !b.disabled)";
        waitFor("!!(" + selector + ")"); js(selector + ".click()");
    }
    private void control(int port, String path) throws Exception {
        // Test-only localhost control peer, separate from application networking.
        try (Socket socket = new Socket("10.0.2.2", port)) {
            socket.setSoTimeout(15000);
            socket.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            String response = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(response, response.startsWith("HTTP/1.1 200"));
        }
    }
    private void screenshot(String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync(); Thread.sleep(350);
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        try (OutputStream out = new FileOutputStream(new File(activity.getExternalFilesDir(null), name + ".png"))) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, out); }
    }
    private void verifyFontSettings() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        js("document.querySelector('[aria-label=\"打开会话列表\"]').click()");
        click("我的"); click("设置");
        js("Array.from(document.querySelectorAll('[aria-label=\"设置分类\"] button')).find(b=>b.textContent.startsWith('通用')).click()");
        waitFor("document.querySelector('#font-size')?.value === '14'");
        js("document.querySelector('#font-size').scrollIntoView({block:'center'})");
        Thread.sleep(250);
        JSONObject bounds = new JSONObject(js("(()=>{const r=document.querySelector('#font-size').getBoundingClientRect();return {x:r.x+r.width*.85,y:r.y+r.height/2,width:innerWidth,scroll:document.querySelector('.settings-content').scrollTop};})()"));
        AtomicReference<float[]> point = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            var web = activity.getBridge().getWebView(); int[] origin = new int[2]; web.getLocationOnScreen(origin);
            float scale = web.getWidth() / (float) bounds.optDouble("width");
            point.set(new float[]{origin[0] + (float) bounds.optDouble("x") * scale, origin[1] + (float) bounds.optDouble("y") * scale, scale});
        });
        // The old slider saved 19 on ACTION_DOWN before this vertical scroll.
        float[] p = point.get(); long down = SystemClock.uptimeMillis();
        for (int step = 0; step <= 9; step++) {
            int action = step == 0 ? MotionEvent.ACTION_DOWN : step == 9 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
            MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, p[0], p[1] - Math.min(step, 8) * 15 * p[2], 0);
            instrumentation.sendPointerSync(event); event.recycle(); SystemClock.sleep(25);
        }
        waitFor("document.querySelector('.settings-content').scrollTop > " + bounds.getDouble("scroll"));
        assertEquals("Scrolling must not change the font preference", "\"14\"", js("document.querySelector('#font-size').value"));
        js("document.querySelector('#font-size').scrollIntoView({block:'center'})");
        Thread.sleep(250);
        JSONObject track = new JSONObject(js("(()=>{const r=document.querySelector('#font-size').getBoundingClientRect();return {x:r.x+12+(r.width-24)*.25,end:r.x+12+(r.width-24)*.75,y:r.y+r.height/2,width:innerWidth};})()"));
        AtomicReference<float[]> drag = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            var web = activity.getBridge().getWebView(); int[] origin = new int[2]; web.getLocationOnScreen(origin);
            float scale = web.getWidth() / (float) track.optDouble("width");
            drag.set(new float[]{origin[0] + (float) track.optDouble("x") * scale, origin[0] + (float) track.optDouble("end") * scale, origin[1] + (float) track.optDouble("y") * scale});
        });
        float[] d = drag.get(); down = SystemClock.uptimeMillis();
        for (int step = 0; step <= 9; step++) {
            int action = step == 0 ? MotionEvent.ACTION_DOWN : step == 9 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
            MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, d[0] + (d[1] - d[0]) * Math.min(step, 8) / 8, d[2], 0);
            instrumentation.sendPointerSync(event); event.recycle(); SystemClock.sleep(25);
            if (step == 0) assertEquals("Touch-down must not jump", "\"14\"", js("document.querySelector('#font-size').value"));
        }
        waitFor("document.querySelector('#font-size').value === '18'");
        assertEquals("Card needs padding around labels and controls", "true", js("(()=>{const c=document.querySelector('#font-size').closest('.settings-group'),b=c.getBoundingClientRect();return Array.from(c.querySelectorAll('label,select,output,.settings-font-preview,.model-brand-toggle,#model-brand-setting')).every(e=>{const r=e.getBoundingClientRect();return r.left>=b.left+15&&r.right<=b.right-15})})()"));
        screenshot("14-font-slider-mono");
        js("document.querySelector('input[name=\"color-palette\"][value=\"cli\"]').click()");
        waitFor("document.documentElement.dataset.palette === 'cli' && document.querySelector('input[name=\"color-palette\"][value=\"cli\"]').checked");
        js("document.querySelector('#font-size').scrollIntoView({block:'center'})");
        screenshot("15-font-choice");
        js("document.querySelector('[aria-label=\"返回设置分类\"]').click()");
        js("document.querySelector('[aria-label=\"关闭设置\"]').click()");
        click("消息");
        js("Array.from(document.querySelectorAll('.mh-row')).find(b=>b.textContent.includes('原生配对验收')).click()");
        waitFor("!document.querySelector('.settings-content') && document.querySelector('.message.bot .markdown')?.getBoundingClientRect().height > 0");
        assertEquals("Chat must retain the selected size", "\"18px\"", js("getComputedStyle(document.querySelector('.message.bot .markdown')).fontSize"));
        js("window.__fontBeforeReload = true; location.reload()");
        waitFor("window.__fontBeforeReload !== true && !!document.querySelector('.connection-pill.online') && document.querySelector('.mh-row')?.getBoundingClientRect().height > 0");
        js("Array.from(document.querySelectorAll('.mh-row')).find(b=>b.textContent.includes('原生配对验收')).click()");
        waitFor("document.querySelector('.message.bot .markdown')?.getBoundingClientRect().height > 0");
        assertEquals("Reload must retain the theme", "\"cli\"", js("document.documentElement.dataset.palette"));
        assertEquals("Reload must retain the selected size", "\"18px\"", js("getComputedStyle(document.querySelector('.message.bot .markdown')).fontSize"));
        screenshot("16-font-chat-reloaded");
    }
    private void assertSafeHeader(String name, String selector) throws Exception {
        String expression = "(()=>{const e=document.querySelector(" + JSONObject.quote(selector) + ");if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:innerWidth,safe:getComputedStyle(document.documentElement).getPropertyValue('--app-safe-top'),native:getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top')};})()";
        JSONObject rect = new JSONObject(js(expression));
        AtomicReference<JSONObject> nativeRect = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            var web = activity.getBridge().getWebView();
            var decor = activity.getWindow().getDecorView();
            var insets = ViewCompat.getRootWindowInsets(decor).getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int[] origin = new int[2]; web.getLocationOnScreen(origin);
            int[] windowOrigin = new int[2]; decor.getLocationOnScreen(windowOrigin);
            try { nativeRect.set(new JSONObject().put("top", origin[1]).put("left", origin[0]).put("width", web.getWidth())
                .put("safeTop", windowOrigin[1] + insets.top).put("safeLeft", windowOrigin[0] + insets.left)
                .put("safeRight", windowOrigin[0] + decor.getWidth() - insets.right)
                .put("safeBottom", windowOrigin[1] + decor.getHeight() - Math.max(insets.bottom, ViewCompat.getRootWindowInsets(decor).getInsets(WindowInsetsCompat.Type.ime()).bottom))); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        JSONObject nativeBounds = nativeRect.get();
        double scale = nativeBounds.getDouble("width") / rect.getDouble("width");
        try (var out = new FileWriter(new File(activity.getExternalFilesDir(null), name + "-insets.json"))) {
            out.write(new JSONObject().put("dom", rect).put("native", nativeBounds).toString(2));
        }
        screenshot(name);
        assertTrue(name + " overlaps status bar: " + rect + " " + nativeBounds,
            nativeBounds.getDouble("top") + rect.getDouble("top") * scale >= nativeBounds.getDouble("safeTop") - 1);
        assertTrue(name + " overlaps left cutout", nativeBounds.getDouble("left") + rect.getDouble("left") * scale >= nativeBounds.getDouble("safeLeft") - 1);
        assertTrue(name + " overlaps right cutout", nativeBounds.getDouble("left") + rect.getDouble("right") * scale <= nativeBounds.getDouble("safeRight") + 1);
        assertTrue(name + " overlaps keyboard/navigation bar", nativeBounds.getDouble("top") + rect.getDouble("bottom") * scale <= nativeBounds.getDouble("safeBottom") + 1);
    }
    private void verifyCliTypography() throws Exception {
        for (String mode : new String[]{"dark"}) {
            js("document.querySelector('[aria-label=\"打开会话列表\"]').click()");
            click("我的"); click("设置");
            js("Array.from(document.querySelectorAll('[aria-label=\"设置分类\"] button')).find(b=>b.textContent.startsWith('通用')).click()");
            waitFor("!!document.querySelector('#font-size')");
            js("(()=>{const e=document.querySelector('#font-size');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'12');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
            waitFor("document.documentElement.dataset.theme === " + JSONObject.quote(mode) + " && getComputedStyle(document.documentElement).fontSize === '12px'");
            js("document.querySelector('[aria-label=\"返回设置分类\"]').click()");
            js("document.querySelector('[aria-label=\"关闭设置\"]').click()");
            click("消息");
            js("Array.from(document.querySelectorAll('.mh-row')).find(b=>b.textContent.includes('原生配对验收')).click()");
            waitFor("document.querySelector('.message.bot td')?.getBoundingClientRect().height > 0 && document.fonts.status === 'loaded'");
            JSONObject metrics = new JSONObject(js("(()=>{const m=document.querySelector('.message.bot .markdown'),c=document.createElement('canvas').getContext('2d'),s=getComputedStyle(m);c.font='12px '+s.fontFamily;return {family:s.fontFamily,body:getComputedStyle(m.querySelector('p')).fontSize,cell:getComputedStyle(m.querySelector('td')).fontSize,code:getComputedStyle(m.querySelector('pre code')).fontSize,loaded:document.fonts.check('12px '+JSON.stringify('JetBrains Mono'),'Wi01')&&document.fonts.check('12px '+JSON.stringify('Sarasa Term SC'),'中英'),han:c.measureText('中英').width,latin:c.measureText('Wi01').width};})()"));
            assertTrue(metrics.toString(), metrics.getString("family").contains("JetBrains Mono"));
            assertTrue("Bundled font must decode in Android WebView", metrics.getBoolean("loaded"));
            assertEquals("12px", metrics.getString("body")); assertEquals("12px", metrics.getString("cell")); assertEquals("12px", metrics.getString("code"));
            assertEquals("Chinese keeps its 12px reading size", 24, metrics.getDouble("han"), .1);
            assertEquals("Latin cells use the wider .6em face", 28.8, metrics.getDouble("latin"), .1);
            // Wait for the actual compositor, not just a JS/layout callback.
            CountDownLatch painted = new CountDownLatch(1);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.getBridge().getWebView().postVisualStateCallback(1, new android.webkit.WebView.VisualStateCallback() {
                @Override public void onComplete(long requestId) { painted.countDown(); }
            }));
            assertTrue("WebView paint timed out", painted.await(10, TimeUnit.SECONDS));
            String geometry = js("JSON.stringify(['.message-scroll','.virtual-messages','.message.bot','.message.bot td'].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {s,top:r.top,bottom:r.bottom,height:r.height,scroll:e.scrollTop,visibility:getComputedStyle(e).visibility,opacity:getComputedStyle(e).opacity};}))");
            try (var out = new FileWriter(new File(activity.getExternalFilesDir(null), "cli-" + mode + "-geometry.json"))) { out.write(geometry); }
            waitFor("(()=>{const t=document.querySelector('.message.bot td').getBoundingClientRect(),v=document.querySelector('.message-scroll').getBoundingClientRect();return t.top>=v.top && t.bottom<=v.bottom;})()");
            screenshot("17-cli-typography-" + mode);
        }
    }
    @Test public void scanWaitApproveChatAndReconnect() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        var context = instrumentation.getTargetContext();
        assertTrue("Must use isolated test ID", context.getPackageName().endsWith(".pairingtest"));
        JSONObject fixture = new JSONObject(new String(java.util.Base64.getDecoder().decode(InstrumentationRegistry.getArguments().getString("fixture")), StandardCharsets.UTF_8));
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity = (MainActivity) instrumentation.startActivitySync(intent);
        waitFor("document.body.innerText.includes('连接你的 TaroBird')"); screenshot("01-scan");
        click("扫描连接二维码"); waitFor("!!document.querySelector('input[type=file]')");
        js("(()=>{const bytes=Uint8Array.from(atob(" + JSONObject.quote(fixture.getString("qr")) + "),c=>c.charCodeAt(0));const input=document.querySelector('input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([bytes],'pairing.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
        waitFor("document.body.innerText.includes('已读取主机信息')");
        click("下一步：配对此设备"); waitFor("!!document.querySelector('.pair-code')"); screenshot("02-waiting");
        assertFalse(js("document.body.innerText").contains("已确认，连接"));
        String code = new org.json.JSONTokener(js("document.querySelector('.pair-code').textContent")).nextValue().toString();
        // Reload before approval proves durable enrollment and native key reuse.
        js("location.reload()"); waitFor("document.querySelector('.pair-code')?.textContent===" + JSONObject.quote(code));
        control(fixture.getInt("controlPort"), "/approve?code=" + code);
        waitFor("!document.querySelector('.pair-code') && !!document.querySelector('.mobile-home')");
        screenshot("03-connected");
        waitFor("document.body.innerText.includes('原生配对验收')");
        js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('原生配对验收')).click()");
        waitFor("document.body.innerText.includes('原生 TLS 聊天同步成功')"); screenshot("04-chat");
        if ("true".equals(InstrumentationRegistry.getArguments().getString("fontSettings"))) verifyFontSettings();
        if ("true".equals(InstrumentationRegistry.getArguments().getString("cliTypography"))) verifyCliTypography();
        if ("true".equals(InstrumentationRegistry.getArguments().getString("safeArea"))) {
            assertSafeHeader("06-chat-safe", ".chat-identity");
            js("location.reload()");
            waitFor("!!document.querySelector('.connection-pill.online') && !!document.querySelector('.chat-identity')");
            assertSafeHeader("07-reload-safe", ".chat-identity");
        }
        if ("true".equals(InstrumentationRegistry.getArguments().getString("nativeLayout"))) {
            // Native geometry must still work when no WebView CSS insets arrive.
            js("for(const edge of ['top','right','bottom','left'])document.documentElement.style.setProperty('--safe-area-inset-'+edge,'0px')");
            assertSafeHeader("08-no-css-insets", ".chat-identity");
            js("document.querySelector('[aria-label=\"更多聊天操作\"]').click()");
            waitFor("!!document.querySelector('dialog[open]')");
            screenshot("09-bot-shortcut"); click("查看此 Bot 的全部对话" + "原生验收助手");
            waitFor("!!document.querySelector('.mobile-home:not([hidden]) .mh-bot-scope select') || document.querySelector('.mobile-home')?.getBoundingClientRect().height > 0");
            waitFor("document.querySelector('.mh-titlebar[data-scoped]')?.textContent.includes('原生验收助手') === true");
            assertSafeHeader("10-bot-conversations", ".mh-titlebar");
            js("document.querySelector('.mh-row').click()");
            waitFor("document.querySelector('.chat-identity')?.getBoundingClientRect().width > 0");
            instrumentation.runOnMainSync(() -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            waitFor("innerWidth > innerHeight");
            assertSafeHeader("11-landscape", ".chat-identity");
            instrumentation.runOnMainSync(() -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            waitFor("innerHeight > innerWidth");
            js("document.querySelector('textarea[aria-label=\"消息\"]').focus()");
            instrumentation.runOnMainSync(() -> {
                var web = activity.getBridge().getWebView(); web.requestFocus();
                ((InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            });
            waitFor("document.documentElement.dataset.keyboardOpen === 'true'");
            assertSafeHeader("12-keyboard-header", ".chat-identity");
            assertSafeHeader("13-keyboard-composer", ".composer-input-row");
            instrumentation.runOnMainSync(() -> ((InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(activity.getBridge().getWebView().getWindowToken(), 0));
            waitFor("document.documentElement.dataset.keyboardOpen !== 'true'");
            assertSafeHeader("14-keyboard-closed", ".chat-identity");
        }
        control(fixture.getInt("controlPort"), "/restart");
        waitFor("!!document.querySelector('.connection-pill.online')");
        control(fixture.getInt("controlPort"), "/verify"); screenshot("05-reconnected");
        instrumentation.runOnMainSync(() -> activity.finish());
    }
}
