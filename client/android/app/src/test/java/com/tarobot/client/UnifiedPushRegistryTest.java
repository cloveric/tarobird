package com.tarobot.client;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class UnifiedPushRegistryTest {
    static final String A = "hub_" + "a".repeat(64), B = "hub_" + "b".repeat(64), DEVICE = "same_device";
    static class Disk implements UnifiedPushRegistry.Storage {
        String value; JSONObject old; boolean fail;
        public String read() { return value; }
        public JSONObject legacy() throws Exception { return old == null ? null : new JSONObject(old.toString()); }
        public boolean commit(String next) { if (fail) return false; value = next; old = null; return true; }
    }
    private JSONObject add(UnifiedPushRegistry registry, String host) throws Exception { return registry.prepare(UnifiedPushRegistry.instance(host, DEVICE), host, DEVICE, false, "distributor.one"); }
    private JSONObject ready(UnifiedPushRegistry registry, JSONObject item) throws Exception { return registry.endpoint(item.getString("registrationId"), "https://push.example.test/endpoint_" + item.getString("registrationId"), "B".repeat(87), "a".repeat(22)); }
    @Test public void sameDeviceOnDifferentHostsIsIsolatedAndSurvivesReload() throws Exception {
        Disk disk = new Disk(); UnifiedPushRegistry registry = new UnifiedPushRegistry(disk);
        JSONObject a = ready(registry, add(registry,A)), b = ready(registry, add(registry,B));
        assertNotEquals(a.getString("instance"), b.getString("instance")); assertNotEquals(a.getString("registrationId"), b.getString("registrationId"));
        assertEquals("up_68d73792edf56c750f9e2ea5a9189f3bd30ce0da42b82ad04c98f6f7e7eded9e", UnifiedPushRegistry.instance(A, DEVICE));
        UnifiedPushRegistry restored = new UnifiedPushRegistry(disk);
        assertEquals(a.getString("endpoint"), restored.state(a.getString("instance"),A,DEVICE,false).getString("endpoint"));
        assertEquals(b.getString("endpoint"), restored.state(b.getString("instance"),B,DEVICE,false).getString("endpoint"));
    }
    @Test public void removalFencesAllOldCallbacksAndReaddUsesNewGeneration() throws Exception {
        Disk disk = new Disk(); UnifiedPushRegistry registry = new UnifiedPushRegistry(disk);
        JSONObject a = ready(registry, add(registry,A)), b = ready(registry, add(registry,B)); String key = a.getString("instance"), id = a.getString("registrationId");
        registry.beginRemoval(key,true);
        assertNull(registry.callback(id)); assertNull(registry.failure(id,"late")); assertNull(ready(registry,a));
        assertFalse(registry.state(key,A,DEVICE,false).has("endpoint")); assertTrue(registry.state(key,A,DEVICE,false).getBoolean("remoteRemoval"));
        assertNotNull(registry.callback(b.getString("registrationId")));
        registry.finishRemoval(key,id); JSONObject next = add(registry,A); assertNotEquals(id,next.getString("registrationId"));
        assertNull(registry.endpoint(id,"https://push.example.test/old","B".repeat(87),"a".repeat(22)));
    }
    @Test public void failedWritesLeaveDurableStateAndPendingRemovalCanRetry() throws Exception {
        Disk disk = new Disk(); UnifiedPushRegistry registry = new UnifiedPushRegistry(disk); JSONObject a = ready(registry,add(registry,A));
        disk.fail=true; assertThrows(IllegalStateException.class,()->registry.beginRemoval(a.getString("instance"),true)); assertNotNull(registry.callback(a.getString("registrationId")));
        disk.fail=false; registry.beginRemoval(a.getString("instance"),true); disk.fail=true;
        assertThrows(IllegalStateException.class,()->registry.finishRemoval(a.getString("instance"),a.getString("registrationId")));
        disk.fail=false; UnifiedPushRegistry restored = new UnifiedPushRegistry(disk); assertNull(restored.callback(a.getString("registrationId")));
        restored.finishRemoval(a.getString("instance"),a.getString("registrationId")); assertTrue(restored.instances().isEmpty());
    }
    @Test public void legacyIsOnlyClaimedByOriginalCacheAndKeepsItsConnectorIdentity() throws Exception {
        Disk disk=new Disk(); disk.old=new JSONObject().put("instance","legacy").put("deviceId",DEVICE).put("registrationId",DEVICE).put("distributor","distributor.one").put("phase","active").put("endpoint","https://push.example.test/legacy").put("keys",new JSONObject().put("p256dh","B".repeat(87)).put("auth","a".repeat(22)));
        UnifiedPushRegistry registry=new UnifiedPushRegistry(disk);
        assertFalse(registry.state(UnifiedPushRegistry.instance(B,DEVICE),B,DEVICE,false).has("registrationId"));
        JSONObject a=registry.state(UnifiedPushRegistry.instance(A,DEVICE),A,DEVICE,true);
        assertEquals(DEVICE,a.getString("registrationId")); assertTrue(a.has("keys")); assertEquals(A,registry.callback(DEVICE).getString("hostId"));
        add(registry,B); assertEquals(2,registry.instances().size());
    }
    @Test public void anotherDistributorCannotSilentlyReplaceExistingHosts() throws Exception {
        UnifiedPushRegistry registry=new UnifiedPushRegistry(new Disk()); JSONObject a=add(registry,A);
        assertThrows(IllegalStateException.class,()->registry.prepare(UnifiedPushRegistry.instance(B,DEVICE),B,DEVICE,false,"distributor.two"));
        assertEquals(1,registry.instances().size()); assertNotNull(registry.callback(a.getString("registrationId")));
        registry.beginRemoval(a.getString("instance"),false); registry.finishRemoval(a.getString("instance"),a.getString("registrationId"));
        assertEquals("distributor.two",registry.prepare(UnifiedPushRegistry.instance(B,DEVICE),B,DEVICE,false,"distributor.two").getString("distributor"));
    }
    @Test public void invalidEndpointsClearOnlyTheirOwnUsableKeysAndCopiesCannotMutateDisk() throws Exception {
        UnifiedPushRegistry registry=new UnifiedPushRegistry(new Disk()); JSONObject a=ready(registry,add(registry,A)),b=ready(registry,add(registry,B));
        JSONObject invalid=registry.endpoint(a.getString("registrationId"),"http://localhost/path","B".repeat(87),"a".repeat(22));
        assertFalse(invalid.has("endpoint")); assertEquals("unifiedpush_endpoint_invalid",invalid.getString("error"));
        b.put("hostId",A); assertEquals(B,registry.callback(b.getString("registrationId")).getString("hostId"));
    }
    @Test public void confirmationRequiresTheExactCurrentEndpointAndGeneration() throws Exception {
        Disk disk = new Disk(); UnifiedPushRegistry registry = new UnifiedPushRegistry(disk); JSONObject a = ready(registry, add(registry,A));
        assertFalse(a.getBoolean("confirmed"));
        assertThrows(IllegalStateException.class,()->registry.confirm(a.getString("instance"),"old",a.getString("endpoint")));
        assertThrows(IllegalStateException.class,()->registry.confirm(a.getString("instance"),a.getString("registrationId"),"https://push.example.test/wrong"));
        registry.confirm(a.getString("instance"),a.getString("registrationId"),a.getString("endpoint"));
        assertTrue(new UnifiedPushRegistry(disk).state(a.getString("instance"),A,DEVICE,false).getBoolean("confirmed"));
        registry.beginRemoval(a.getString("instance"),true);
        assertThrows(IllegalStateException.class,()->registry.confirm(a.getString("instance"),a.getString("registrationId"),a.getString("endpoint")));
    }
    @Test public void legacyNotificationsRemainUnscopedUntilLocalMigrationThenRejectForgedHosts() throws Exception {
        Disk disk = new Disk(); disk.old = new JSONObject().put("instance","legacy").put("deviceId",DEVICE).put("registrationId",DEVICE).put("phase","active").put("distributor","distributor.one").put("confirmed",true);
        UnifiedPushRegistry registry = new UnifiedPushRegistry(disk);
        assertEquals("",registry.notificationHost(DEVICE,null)); assertEquals("",registry.notificationHost(DEVICE,B));
        JSONObject migrated = registry.state(UnifiedPushRegistry.instance(A,DEVICE),A,DEVICE,true);
        assertTrue(migrated.getBoolean("confirmed")); assertEquals(A,registry.notificationHost(DEVICE,null));
        assertNull(registry.notificationHost(DEVICE,B)); assertEquals(A,registry.notificationHost(DEVICE,A));
        registry.beginRemoval(migrated.getString("instance"),true); assertNull(registry.notificationHost(DEVICE,A));
    }
}
