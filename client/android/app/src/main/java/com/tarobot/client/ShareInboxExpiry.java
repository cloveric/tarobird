package com.tarobot.client;

import java.io.*;
import org.json.*;

/** Published shares keep their import lifetime when delivery metadata changes. */
final class ShareInboxExpiry {
    private static final int MAX_ITEM_BYTES = 1024 * 1024;
    private static final long SAFE_INTEGER = 9007199254740991L;

    static JSONObject readItem(File directory) throws IOException, JSONException {
        File file = new File(directory, "item.json");
        if (file.length() > MAX_ITEM_BYTES) throw new IOException("share_item_invalid");
        try (InputStream input = new FileInputStream(file); ByteArrayOutputStream data = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (data.size() + count > MAX_ITEM_BYTES) throw new IOException("share_item_invalid");
                data.write(buffer, 0, count);
            }
            return new JSONObject(data.toString("UTF-8"));
        }
    }

    static boolean isExpired(File directory, long now, long ttl) {
        long createdAt = directory.lastModified();
        try {
            Object value = readItem(directory).opt("createdAt");
            if (value instanceof Number) {
                double number = ((Number) value).doubleValue();
                if (Double.isFinite(number) && number > 0 && number <= SAFE_INTEGER
                        && number <= now && Math.rint(number) == number) {
                    createdAt = ((Number) value).longValue();
                }
            }
        } catch (IOException | JSONException ignored) {
            // Interrupted imports and malformed records retain their existing age-based cleanup.
        }
        return now - createdAt > ttl;
    }
}
