package com.tarobot.client;

import java.util.Map;

/** A bounded, plain-text Hub preview. The existing wire body carries a readable
 * conversation line followed by the event excerpt; older Hubs keep fallbacks. */
final class NotificationMessage {
    private static String[] preview(Map<String, String> data) {
        String body = data.get("body"), kind = data.get("kind");
        if (body == null || body.length() > 200) return null;
        String[] lines = body.split("\n", -1);
        if (lines.length != 2 || !lines[0].matches("^「[^「」\\p{Cntrl}]{1,48}」(?: · [^\\p{Cntrl}]{1,24})?$")) return null;
        if (lines[1].trim().isEmpty() || body.matches("(?s).*[\\x00-\\x09\\x0B-\\x1F\\x7F-\\x9F\\u202A-\\u202E\\u2066-\\u2069].*")) return null;
        // Background updates stay "answer" and unconfirmed delivery stays "error"
        // on the v1 wire; their Hub prefixes never claim completion.
        boolean matches = "answer".equals(kind) ? lines[1].startsWith("回复完成：") || lines[1].startsWith("收到") || lines[1].startsWith("后台任务更新：")
            : "action".equals(kind) ? lines[1].startsWith("待处理：")
            : "error".equals(kind) && (lines[1].startsWith("任务未完成：") || lines[1].startsWith("交付未确认："));
        return matches ? lines : null;
    }
    static String title(Map<String, String> data, String fallback) {
        String[] preview = preview(data);
        return preview == null ? fallback : preview[0];
    }
    static String body(Map<String, String> data) {
        String[] preview = preview(data);
        if (preview != null) return preview[1];
        return genericBody(data);
    }
    static String genericBody(Map<String, String> data) {
        String kind = data.get("kind");
        if ("error".equals(kind)) return preview(data) != null || "任务未完成，点按查看当前进展。".equals(data.get("body"))
            ? "任务未完成，点按查看当前进展。" : "任务遇到错误，请打开对话查看。";
        if ("action".equals(kind)) return "有一项操作等待你确认。";
        if ("answer".equals(kind)) {
            if ("Bot 发来了文件，点按查看。".equals(data.get("body"))) return "Bot 发来了文件，点按查看。";
            if ("Bot 已完成回复，点按查看。".equals(data.get("body"))) return "Bot 已完成回复，点按查看。";
            // Sent when the device hides notification previews.
            if ("后台任务有更新，点按查看。".equals(data.get("body"))) return "后台任务有更新，点按查看。";
        }
        return "收到新消息，打开 TaroBird 查看。";
    }
}
