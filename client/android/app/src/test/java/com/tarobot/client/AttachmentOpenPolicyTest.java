package com.tarobot.client;
import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
public class AttachmentOpenPolicyTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();
    @Test public void acceptsOnlyCompletePreparedFilesAndRejectsEscapes() throws Exception {
        File cache = temp.newFolder("cache"), folder = new File(cache, "tarocub-exports/123-abc-def"); folder.mkdirs();
        File valid = new File(folder, "分类账本.xlsx"); Files.write(valid.toPath(), new byte[]{1,2,3});
        assertEquals(valid.getCanonicalFile(), AttachmentOpenPolicy.exportFile(cache, valid.getPath()));
        File secret = temp.newFile("private.db");
        for (String path : new String[]{secret.getPath(), folder.getPath(), new File(folder, "missing.xlsx").getPath(), new File(folder, "../../private.db").getPath()}) {
            assertThrows(java.io.IOException.class, () -> AttachmentOpenPolicy.exportFile(cache, path));
        }
        File link = new File(folder, "link.xlsx"); Files.createSymbolicLink(link.toPath(), secret.toPath());
        assertThrows(java.io.IOException.class, () -> AttachmentOpenPolicy.exportFile(cache, link.getPath()));
    }
}
