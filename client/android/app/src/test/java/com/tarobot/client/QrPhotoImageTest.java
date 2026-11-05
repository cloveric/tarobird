package com.tarobot.client;

import static org.junit.Assert.*;
import org.junit.Test;

public class QrPhotoImageTest {
    // 1x1 PNG.
    private static final String PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    private static final String NAME = "TaroBot-QR-20261028-013000.png";

    @Test public void acceptsOnlyABoundedTaroBotQrPng() {
        QrPhotoImage image = QrPhotoImage.parse(PNG, NAME);
        assertEquals(NAME, image.name);
        assertEquals((byte) 0x89, image.bytes[0]);
        assertEquals(70, image.bytes.length);
    }
    @Test public void rejectsOtherNamesAndPaths() {
        for (String name : new String[] { null, "photo.png", "TaroBot-QR-20261028-013000.jpg", "../TaroBot-QR-20261028-013000.png", "TaroBot-QR-2026-1028-013000.png", "TaroBot-QR-20261028-013000.png/x" }) {
            assertThrows(IllegalArgumentException.class, () -> QrPhotoImage.parse(PNG, name));
        }
    }
    @Test public void rejectsNonPngMalformedAndOversizedData() {
        String jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
        for (String data : new String[] { null, "", jpeg, PNG.substring(1), PNG.replace('A', '*'), "iVBORw0KGgo=" }) {
            assertThrows(IllegalArgumentException.class, () -> QrPhotoImage.parse(data, NAME));
        }
        String huge = PNG.substring(0, 40) + "A".repeat((QrPhotoImage.MAX_BYTES + 2) / 3 * 4);
        assertThrows(IllegalArgumentException.class, () -> QrPhotoImage.parse(huge, NAME));
    }
}
