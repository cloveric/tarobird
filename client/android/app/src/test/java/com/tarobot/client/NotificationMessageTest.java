package com.tarobot.client;

import static org.junit.Assert.*;
import java.util.Map;
import org.junit.Test;

public class NotificationMessageTest {
    @Test public void distinguishesCompletionFileErrorAndApproval() {
        assertEquals("Bot 已完成回复，点按查看。", NotificationMessage.body(Map.of("kind", "answer", "body", "Bot 已完成回复，点按查看。")));
        assertEquals("Bot 发来了文件，点按查看。", NotificationMessage.body(Map.of("kind", "answer", "body", "Bot 发来了文件，点按查看。")));
        assertEquals("任务遇到错误，请打开对话查看。", NotificationMessage.body(Map.of("kind", "error")));
        assertEquals("任务未完成，点按查看当前进展。", NotificationMessage.body(Map.of("kind", "error", "body", "任务未完成，点按查看当前进展。")));
        assertEquals("有一项操作等待你确认。", NotificationMessage.body(Map.of("kind", "action")));
    }
    @Test public void olderHubRemindersDoNotClaimCompletion() {
        assertEquals("收到新消息，打开 TaroBird 查看。", NotificationMessage.body(Map.of("kind", "answer")));
        assertEquals("收到新消息，打开 TaroBird 查看。", NotificationMessage.body(Map.of("kind", "answer", "body", "收到一条新回复或提醒。")));
    }
    @Test public void conversationAndResultAreShownWithTheOriginalKind() {
        var reply = Map.of("kind", "answer", "body", "「发布准备」 · CC1\n回复完成：已修复侧栏并保留草稿。");
        assertEquals("「发布准备」 · CC1", NotificationMessage.title(reply, "TaroBot"));
        assertEquals("回复完成：已修复侧栏并保留草稿。", NotificationMessage.body(reply));
        assertEquals("收到文件：版本报告.pdf", NotificationMessage.body(Map.of("kind", "answer", "body", "「工作」\n收到文件：版本报告.pdf")));
        assertEquals("待处理：请确认发布。", NotificationMessage.body(Map.of("kind", "action", "body", "「工作」\n待处理：请确认发布。")));
        assertEquals("任务未完成：连接中断。", NotificationMessage.body(Map.of("kind", "error", "body", "「工作」\n任务未完成：连接中断。")));
        assertEquals("任务未完成，点按查看当前进展。", NotificationMessage.genericBody(Map.of("kind", "error", "body", "「工作」\n任务未完成：用户已停止。")));
    }
    @Test public void backgroundUpdatesAndUnconfirmedDeliveryKeepTheirConversationAndStatus() {
        var update = Map.of("kind", "answer", "body", "「工作」 · Alpha\n后台任务更新：仍在处理第二批文件。");
        assertEquals("「工作」 · Alpha", NotificationMessage.title(update, "TaroBot"));
        assertEquals("后台任务更新：仍在处理第二批文件。", NotificationMessage.body(update));
        var unconfirmed = Map.of("kind", "error", "body", "「工作」 · Alpha\n交付未确认：成片已导出：final.mp4");
        assertEquals("「工作」 · Alpha", NotificationMessage.title(unconfirmed, "TaroBot"));
        assertEquals("交付未确认：成片已导出：final.mp4", NotificationMessage.body(unconfirmed));
        assertEquals("任务未完成，点按查看当前进展。", NotificationMessage.genericBody(unconfirmed));
        // A completion prefix still cannot pass under the wrong kind.
        assertEquals("TaroBot", NotificationMessage.title(Map.of("kind", "answer", "body", "「工作」\n交付未确认：x"), "TaroBot"));
    }
    @Test public void hiddenPreviewSentencesNeverNameTheConversation() {
        for (String[] item : new String[][]{{"answer", "Bot 已完成回复，点按查看。"}, {"answer", "Bot 发来了文件，点按查看。"}, {"answer", "后台任务有更新，点按查看。"}, {"action", "有一项操作等待你确认。"}, {"error", "任务未完成，点按查看当前进展。"}}) {
            var data = Map.of("kind", item[0], "body", item[1]);
            assertEquals("TaroBot", NotificationMessage.title(data, "TaroBot"));
            assertEquals(item[1], NotificationMessage.body(data));
        }
    }
    @Test public void malformedPreviewCannotSpoofCompletionOrOverflowTheNotification() {
        for (String body : new String[]{"「工作」\n回复完成：" + "x".repeat(201), "「工作」\n回复完成：第一行\n第二行", "「工作」\n回复完成：\u202E反向文字", "「工作」\n任务未完成：SECRET"}) {
            var data = Map.of("kind", "answer", "body", body);
            assertEquals("TaroBot", NotificationMessage.title(data, "TaroBot"));
            assertEquals("收到新消息，打开 TaroBird 查看。", NotificationMessage.body(data));
        }
        assertFalse(NotificationMessage.body(Map.of("kind", "error", "body", "「工作」\n回复完成：安装成功")).contains("成功"));
    }
    @Test public void arbitraryRemoteTextCannotReachTheLockScreen() {
        for (String kind : new String[]{"answer", "action", "error", "unknown"}) {
            assertFalse(NotificationMessage.body(Map.of("kind", kind, "body", "SECRET: contract.docx and message content")).contains("SECRET"));
        }
        assertEquals("收到新消息，打开 TaroBird 查看。", NotificationMessage.body(Map.of()));
    }
}
