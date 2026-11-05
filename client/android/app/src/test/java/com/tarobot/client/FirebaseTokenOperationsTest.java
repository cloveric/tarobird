package com.tarobot.client;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class FirebaseTokenOperationsTest {
    static class Clock implements FirebaseTokenOperations.Scheduler {
        long now;
        static class Timer { long at; Runnable run; Timer(long at, Runnable run) { this.at = at; this.run = run; } }
        List<Timer> timers = new ArrayList<>();
        public FirebaseTokenOperations.Cancel after(long delay, Runnable run) {
            Timer timer = new Timer(now + delay, run); timers.add(timer); return () -> timers.remove(timer);
        }
        void advance(long duration) {
            now += duration;
            for (Timer timer : new ArrayList<>(timers)) if (timer.at <= now && timers.remove(timer)) timer.run.run();
        }
    }
    static class Backend implements FirebaseTokenOperations.Backend {
        List<FirebaseTokenOperations.Completion> reads = new ArrayList<>(), deletes = new ArrayList<>();
        List<Boolean> enabled = new ArrayList<>();
        public void autoInit(boolean value) { enabled.add(value); }
        public void token(FirebaseTokenOperations.Completion done) { reads.add(done); }
        public void delete(FirebaseTokenOperations.Completion done) { deletes.add(done); }
    }
    static class Receipt implements FirebaseTokenOperations.Reply {
        List<String> results = new ArrayList<>();
        public void success(String token) { results.add(token == null ? "cleared" : token); }
        public void failure(String error) { results.add(error); }
        void only(String expected) { assertEquals(List.of(expected), results); }
    }
    final Clock clock = new Clock();
    final Backend backend = new Backend();
    final FirebaseTokenOperations operations = new FirebaseTokenOperations(backend, clock);
    final FirebaseTokenOperations.Owner owner = new FirebaseTokenOperations.Owner();
    Receipt register() { Receipt reply = new Receipt(); operations.register(owner, reply); return reply; }
    Receipt clear() { Receipt reply = new Receipt(); operations.clear(owner, reply); return reply; }

    @Test public void concurrentHostsShareOneTaskAndHaveIndependentDeadlines() {
        Receipt first = register(); clock.advance(10_000); Receipt second = register();
        assertEquals(1, backend.reads.size()); clock.advance(10_000);
        first.only("firebase_registration_timeout"); assertTrue(second.results.isEmpty());
        backend.reads.get(0).done("shared-token", null);
        first.only("firebase_registration_timeout"); second.only("shared-token");
        assertEquals(List.of(true), backend.enabled); assertTrue(clock.timers.isEmpty());
    }
    @Test public void failedTaskCanRetryWithoutAnOldCompletionSettlingTheNewCall() {
        Receipt first = register(); backend.reads.get(0).done(null, "firebase_registration_failed");
        first.only("firebase_registration_failed"); assertTrue(backend.enabled.isEmpty());
        Receipt second = register(); backend.reads.get(0).done("old-token", null);
        assertTrue(second.results.isEmpty()); backend.reads.get(1).done("new-token", null);
        second.only("new-token"); assertTrue(clock.timers.isEmpty());
    }
    @Test public void timeoutThenCleanupWaitsForActualTokenCreationBeforeDeleting() {
        Receipt registration = register(); clock.advance(20_000);
        registration.only("firebase_registration_timeout"); Receipt clear = clear();
        assertEquals(List.of(false), backend.enabled); assertTrue(backend.deletes.isEmpty());
        register().only("firebase_cleanup_pending");
        backend.reads.get(0).done("late-native-token", null);
        assertEquals(1, backend.deletes.size()); assertTrue(clear.results.isEmpty());
        backend.deletes.get(0).done(null, null); clear.only("cleared");
        registration.only("firebase_registration_timeout");
        Receipt next = register(); backend.reads.get(1).done("fresh", null); next.only("fresh");
    }
    @Test public void cleanupTimeoutKeepsFenceUntilTheRealTasksComplete() {
        Receipt registration = register(), clear = clear();
        registration.only("firebase_cleanup_pending"); clock.advance(20_000);
        clear.only("firebase_cleanup_timeout"); assertTrue(clock.timers.isEmpty());
        register().only("firebase_cleanup_pending");
        backend.reads.get(0).done(null, "firebase_registration_failed");
        assertEquals(1, backend.deletes.size()); register().only("firebase_cleanup_pending");
        backend.deletes.get(0).done(null, null); clear.only("firebase_cleanup_timeout");
        register(); assertEquals(2, backend.reads.size());
    }
    @Test public void failedDeleteStaysRecoverableAndDoesNotEnableRegistration() {
        Receipt first = clear(); backend.deletes.get(0).done(null, "firebase_unregister_failed");
        first.only("firebase_unregister_failed"); register().only("firebase_cleanup_pending");
        Receipt second = clear(); assertEquals(2, backend.deletes.size());
        backend.deletes.get(1).done(null, null); second.only("cleared");
    }
    @Test public void destroyDropsOnlyItsOwnConsumersAndDoesNotDeleteSharedTokens() {
        Receipt first = register(), second = new Receipt();
        operations.register(new FirebaseTokenOperations.Owner(), second); operations.abandon(owner);
        first.only("firebase_request_cancelled"); assertEquals(1, clock.timers.size());
        backend.reads.get(0).done("other-host-token", null); second.only("other-host-token");
        assertTrue(backend.deletes.isEmpty()); assertTrue(clock.timers.isEmpty());
    }
    @Test public void noConsumersMeansLateSuccessDoesNotEnableBackgroundAutoInit() {
        Receipt first = register(); clock.advance(20_000); backend.reads.get(0).done("late", null);
        first.only("firebase_registration_timeout"); assertTrue(backend.enabled.isEmpty());
        assertTrue(clock.timers.isEmpty());
    }
    @Test public void emptyTokenCannotBecomeASuccessfulRegistration() {
        Receipt first = register(); backend.reads.get(0).done("", null);
        first.only("firebase_registration_failed"); assertTrue(backend.enabled.isEmpty());
    }
    @Test public void destroyedActivityCannotAdmitQueuedRegistrationOrCleanup() {
        operations.abandon(owner);
        register().only("firebase_request_cancelled"); clear().only("firebase_request_cancelled");
        assertTrue(backend.reads.isEmpty()); assertTrue(backend.deletes.isEmpty());
        assertTrue(backend.enabled.isEmpty()); assertTrue(clock.timers.isEmpty());
        Receipt fresh = new Receipt(); operations.register(new FirebaseTokenOperations.Owner(), fresh);
        backend.reads.get(0).done("new-activity-token", null); fresh.only("new-activity-token");
    }
    @Test public void tooManyPendingConsumersAreRejectedWithoutMoreSdkTasks() {
        for (int i = 0; i < 32; i++) register();
        register().only("firebase_busy"); assertEquals(1, backend.reads.size());
        clock.advance(20_000); assertTrue(clock.timers.isEmpty());
    }
}
