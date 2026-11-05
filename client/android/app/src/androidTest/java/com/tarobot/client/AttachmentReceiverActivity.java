package com.tarobot.client;
import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
/** Test APK has a different UID: proves the actual content grant to a reader. */
public class AttachmentReceiverActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); String result;
        try {
            var uri = getIntent().getData();
            String bytes;
            try (var stream = getContentResolver().openInputStream(uri)) { var output = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[1024]; int size; while ((size = stream.read(buffer)) != -1) output.write(buffer, 0, size); bytes = new String(output.toByteArray(), StandardCharsets.UTF_8); }
            boolean readOnly = false;
            try (var stream = getContentResolver().openOutputStream(uri, "w")) {} catch (SecurityException denied) { readOnly = true; }
            result = "reader:" + bytes + ":" + uri.getScheme() + ":" + readOnly;
        } catch (Exception error) { result = "reader:FAILED:" + error.getClass().getSimpleName(); }
        TextView text = new TextView(this); text.setText(result); text.setTextSize(20); setContentView(text);
    }
}
