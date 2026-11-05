package com.tarobot.client;
import java.io.File;
import java.io.IOException;
final class AttachmentOpenPolicy {
    static File exportFile(File cache, String path) throws IOException {
        File root = new File(cache, "tarocub-exports").getCanonicalFile();
        File file = new File(path).getCanonicalFile();
        File folder = file.getParentFile();
        if (folder == null || !root.equals(folder.getParentFile()) || !folder.getName().matches("[0-9]+-[0-9a-f-]+") || !file.isFile()) throw new IOException("attachment_path_invalid");
        return file;
    }
}
