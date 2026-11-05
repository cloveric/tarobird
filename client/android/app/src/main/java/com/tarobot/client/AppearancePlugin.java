package com.tarobot.client;

import android.graphics.Color;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TaroBotAppearance")
public class AppearancePlugin extends Plugin {
    @Override public void load() {
        getBridge().addWebViewListener(new WebViewListener() {
            @Override public void onPageStarted(WebView webView) {
                // A reload drops every JavaScript reader lease without cleanup.
                getActivity().runOnUiThread(() -> NativeAppearance.resetReader(getActivity()));
            }
        });
    }

    @PluginMethod public void setCanvas(PluginCall call) {
        String color = call.getString("color", "");
        if (!color.matches("^#[0-9a-fA-F]{6}$")) { call.reject("invalid_canvas_color"); return; }
        int parsed = Color.parseColor(color);
        boolean darkIcons = Boolean.TRUE.equals(call.getBoolean("darkIcons", true));
        getActivity().runOnUiThread(() -> {
            NativeAppearance.save(getActivity(), parsed, darkIcons);
            getBridge().getWebView().setBackgroundColor(parsed);
            call.resolve();
        });
    }

    /** Transient reader canvas; omit color to return to the saved app theme. */
    @PluginMethod public void setReaderCanvas(PluginCall call) {
        String color = call.getString("color");
        if (color != null && !color.matches("^#[0-9a-fA-F]{6}$")) { call.reject("invalid_canvas_color"); return; }
        Integer parsed = color == null ? null : Color.parseColor(color);
        boolean darkIcons = Boolean.TRUE.equals(call.getBoolean("darkIcons", false));
        getActivity().runOnUiThread(() -> {
            NativeAppearance.setReader(getActivity(), parsed, darkIcons);
            call.resolve();
        });
    }

    /** Hide status and navigation bars; a swipe shows them transiently. */
    @PluginMethod public void setImmersive(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            NativeAppearance.setImmersive(getActivity(), enabled);
            call.resolve();
        });
    }
}
