package com.tarobot.client;

import java.util.ArrayList;
import java.util.List;

/** Owns Firebase Task receipts, not Capacitor's unscoped retained broadcasts.
 * A UI timeout releases its reply but never pretends the SDK Task was cancelled.
 * Shared device token deletion waits for the real registration Task to finish. */
final class FirebaseTokenOperations {
    static final class Owner { private boolean active = true; }
    interface Completion { void done(String token, String error); }
    interface Backend {
        void autoInit(boolean enabled);
        void token(Completion completion);
        void delete(Completion completion);
    }
    interface Reply { void success(String token); void failure(String code); }
    interface Cancel { void cancel(); }
    interface Scheduler { Cancel after(long millis, Runnable callback); }
    private static final int MAX_WAITERS = 32;
    private final Backend backend;
    private final Scheduler scheduler;
    private Job registration;
    private Job clearing;
    private boolean disabled, deleting;

    private static final class Waiter {
        Owner owner;
        Reply reply;
        Cancel timeout;
        Waiter(Owner owner, Reply reply) { this.owner = owner; this.reply = reply; }
    }
    private static final class Job { final List<Waiter> waiters = new ArrayList<>(); }
    FirebaseTokenOperations(Backend backend, Scheduler scheduler) {
        this.backend = backend; this.scheduler = scheduler;
    }
    private void waitFor(Job job, Owner owner, Reply reply, String timeoutCode) {
        if (job.waiters.size() >= MAX_WAITERS) { reply.failure("firebase_busy"); return; }
        Waiter waiter = new Waiter(owner, reply); job.waiters.add(waiter);
        waiter.timeout = scheduler.after(20_000, () -> {
            synchronized (FirebaseTokenOperations.this) {
                job.waiters.remove(waiter); finish(waiter, null, timeoutCode);
            }
        });
    }
    private void finish(Waiter waiter, String token, String error) {
        Reply reply = waiter.reply; waiter.reply = null; waiter.owner = null;
        if (waiter.timeout != null) { waiter.timeout.cancel(); waiter.timeout = null; }
        if (reply != null) { if (error == null) reply.success(token); else reply.failure(error); }
    }
    private void finishAll(Job job, String token, String error) {
        List<Waiter> waiters = new ArrayList<>(job.waiters); job.waiters.clear();
        for (Waiter waiter : waiters) finish(waiter, token, error);
    }
    synchronized void register(Owner owner, Reply reply) {
        if (!owner.active) { reply.failure("firebase_request_cancelled"); return; }
        if (clearing != null) { reply.failure("firebase_cleanup_pending"); return; }
        if (registration != null) { waitFor(registration, owner, reply, "firebase_registration_timeout"); return; }
        Job job = new Job(); registration = job;
        waitFor(job, owner, reply, "firebase_registration_timeout");
        try {
            backend.token((token, error) -> registered(job, token, error));
        } catch (Exception error) { registered(job, null, "firebase_registration_failed"); }
    }
    private synchronized void registered(Job job, String token, String error) {
        if (registration != job) return;
        registration = null;
        if (clearing != null) {
            finishAll(job, null, "firebase_cleanup_pending");
            deleteWhenReady();
        } else {
            if (error == null && (token == null || token.isEmpty() || token.length() > 4096)) error = "firebase_registration_failed";
            // Enable automatic refresh only after a successful explicit request;
            // a failed first attempt must not schedule new auto-init retries.
            if (error == null && !job.waiters.isEmpty()) {
                try { backend.autoInit(true); } catch (Exception failure) { error = "firebase_registration_failed"; }
            }
            finishAll(job, token, error);
        }
    }
    synchronized void clear(Owner owner, Reply reply) {
        if (!owner.active) { reply.failure("firebase_request_cancelled"); return; }
        if (clearing == null) { clearing = new Job(); disabled = false; }
        waitFor(clearing, owner, reply, "firebase_cleanup_timeout");
        // Do not delete while getToken is still capable of creating a token.
        try { backend.autoInit(false); disabled = true; }
        catch (Exception error) { finishAll(clearing, null, "firebase_unregister_failed"); return; }
        if (registration != null) finishAll(registration, null, "firebase_cleanup_pending");
        deleteWhenReady();
    }
    private void deleteWhenReady() {
        if (clearing == null || registration != null || deleting || !disabled) return;
        Job job = clearing; deleting = true;
        try { backend.delete((ignored, error) -> deleted(job, error)); }
        catch (Exception error) { deleted(job, "firebase_unregister_failed"); }
    }
    private synchronized void deleted(Job job, String error) {
        if (clearing != job) return;
        deleting = false;
        if (error == null) clearing = null;
        // Failure leaves the cleanup fence in place; an explicit clear retries.
        finishAll(job, null, error);
    }
    synchronized void abandon(Owner owner) {
        owner.active = false;
        for (Job job : new Job[]{registration, clearing}) if (job != null) {
            for (Waiter waiter : new ArrayList<>(job.waiters)) if (waiter.owner == owner) {
                job.waiters.remove(waiter); finish(waiter, null, "firebase_request_cancelled");
            }
        }
    }
}
