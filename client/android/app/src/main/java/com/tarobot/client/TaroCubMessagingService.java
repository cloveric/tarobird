package com.tarobot.client;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Data-only FCM messages do not collapse reminders while the app is asleep. */
public class TaroCubMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(@NonNull String token) {
        PushNotificationsPlugin.onNewToken(token);
    }
    @Override public void onMessageReceived(@NonNull RemoteMessage message) {
        PushNotificationsPlugin.sendRemoteMessage(message);
        TaroCubNotifications.show(this, message.getData());
    }
}
