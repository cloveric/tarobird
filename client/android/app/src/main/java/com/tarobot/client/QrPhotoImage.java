package com.tarobot.client;

/** A connection QR rendered by TaroBot, validated before it may enter the
 * photo gallery: a bounded PNG with TaroBot's fixed name format. This is not a
 * general media import path. Pure Java, so it can be tested on the JVM. */
final class QrPhotoImage {
    static final int MAX_BYTES = 512 * 1024;
    static final int MAX_SIDE = 4096;
    private static final byte[] SIGNATURE = { (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
    final String name;
    final byte[] bytes;

    private QrPhotoImage(String name, byte[] bytes) { this.name = name; this.bytes = bytes; }

    static QrPhotoImage parse(String data, String name) {
        if (name == null || !name.matches("TaroBot-QR-[0-9]{8}-[0-9]{6}\\.png")) throw new IllegalArgumentException("photos_name_invalid");
        if (data == null || data.isEmpty() || data.length() > (MAX_BYTES + 2) / 3 * 4) throw new IllegalArgumentException("photos_image_invalid");
        byte[] bytes = decode(data);
        if (bytes == null || bytes.length < 33 || bytes.length > MAX_BYTES) throw new IllegalArgumentException("photos_image_invalid");
        for (int i = 0; i < SIGNATURE.length; i++) if (bytes[i] != SIGNATURE[i]) throw new IllegalArgumentException("photos_image_invalid");
        // The first chunk of a PNG is a 13-byte IHDR carrying width and height.
        if (readInt(bytes, 8) != 13 || bytes[12] != 'I' || bytes[13] != 'H' || bytes[14] != 'D' || bytes[15] != 'R') throw new IllegalArgumentException("photos_image_invalid");
        long width = readInt(bytes, 16) & 0xffffffffL, height = readInt(bytes, 20) & 0xffffffffL;
        if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new IllegalArgumentException("photos_image_invalid");
        return new QrPhotoImage(name, bytes);
    }

    private static int readInt(byte[] bytes, int offset) {
        return (bytes[offset] & 0xff) << 24 | (bytes[offset + 1] & 0xff) << 16 | (bytes[offset + 2] & 0xff) << 8 | bytes[offset + 3] & 0xff;
    }

    /** Strict standard Base64 with padding; java.util.Base64 needs API 26. */
    private static byte[] decode(String text) {
        if (text.length() % 4 != 0) return null;
        int padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
        byte[] out = new byte[text.length() / 4 * 3 - padding];
        int index = 0;
        for (int i = 0; i < text.length(); i += 4) {
            int value = 0;
            for (int j = 0; j < 4; j++) {
                char c = text.charAt(i + j);
                int digit;
                if (c >= 'A' && c <= 'Z') digit = c - 'A';
                else if (c >= 'a' && c <= 'z') digit = c - 'a' + 26;
                else if (c >= '0' && c <= '9') digit = c - '0' + 52;
                else if (c == '+') digit = 62;
                else if (c == '/') digit = 63;
                else if (c == '=' && i + 4 == text.length() && j >= 4 - padding) digit = 0;
                else return null;
                value = value << 6 | digit;
            }
            for (int shift = 16; shift >= 0 && index < out.length; shift -= 8) out[index++] = (byte) (value >> shift);
        }
        return out;
    }
}
