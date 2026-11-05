package com.tarobot.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import android.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES wrapping keys stay in AndroidKeyStore. Ed25519 seeds exist only in native
 * memory while signing; this is not a claim of hardware-backed Ed25519 signing. */
final class DeviceKeyStore implements DeviceIdentity.Store {
    private final SharedPreferences current, legacy;
    DeviceKeyStore(Context context) {
        current = context.getSharedPreferences("TaroCubNativeIdentityV1", Context.MODE_PRIVATE);
        legacy = context.getSharedPreferences("WSSecureStorageSharedPreferences", Context.MODE_PRIVATE);
    }
    private static String alias(String key, boolean old) {
        return old ? "capacitor-storage_tarocub." + (key.equals("app-lock") ? key : "device." + key) : "com.tarobot.native-identity.v1." + key;
    }
    private static KeyStore vault() throws Exception { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); return store; }
    public String read(String key, boolean old) throws Exception {
        String name = alias(key, old), encoded = (old ? legacy : current).getString(name, null);
        if (encoded == null) return null;
        String[] parts = encoded.split("\u0010", -1);
        if (parts.length != 2) throw new IllegalStateException("device_storage_invalid");
        SecretKey secret = (SecretKey) vault().getKey(name, null);
        if (secret == null) throw new IllegalStateException("device_key_unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(128, Base64.decode(parts[1], Base64.DEFAULT)));
        if (!old) cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] bytes = cipher.doFinal(Base64.decode(parts[0], Base64.DEFAULT));
        try { return new String(bytes, StandardCharsets.UTF_8); } finally { Arrays.fill(bytes, (byte) 0); }
    }
    public void write(String key, String value) throws Exception {
        String name = alias(key, false); SecretKey secret = (SecretKey) vault().getKey(name, null);
        if (secret == null) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            secret = generator.generateKey();
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret);
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        String encrypted;
        try { encrypted = Base64.encodeToString(cipher.doFinal(plain), Base64.NO_WRAP) + "\u0010" + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP); }
        finally { Arrays.fill(plain, (byte) 0); }
        if (!current.edit().putString(name, encrypted).commit()) throw new IllegalStateException("device_key_write_failed");
    }
    public void remove(String key, boolean old) throws Exception {
        String name = alias(key, old);
        // Commit removal first: a crash may leave an unused alias, never a value
        // that appears present but cannot be decrypted on a migration retry.
        if (!(old ? legacy : current).edit().remove(name).commit()) throw new IllegalStateException("device_key_delete_failed");
        vault().deleteEntry(name);
    }
}
