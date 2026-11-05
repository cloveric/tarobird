package com.tarobot.client;

import java.nio.file.Paths;
import org.junit.Test;

public class DeviceIdentityTest {
    @Test public void nativeIdentitySigningMigrationAndFailureChecks() throws Exception {
        DeviceIdentityChecks.main(new String[]{Paths.get(System.getProperty("tarobot.repoRoot"), "tests/fixtures/device-action-vector.json").toString()});
    }
}
