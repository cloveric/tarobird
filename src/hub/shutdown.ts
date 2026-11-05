/** Shutdown phases must all be attempted; one failed flush must not leave the
 * listener, workers or control socket alive. Preserve each original cause. */
export class ShutdownErrors {
  readonly errors: Error[] = [];
  async run(phase: string, operation: () => unknown | Promise<unknown>): Promise<boolean> {
    try { await operation(); return true; }
    catch (cause) { this.errors.push(new Error(`${phase}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })); return false; }
  }
  finish(message: string): void { if (this.errors.length) throw new AggregateError(this.errors, `${message}: ${this.errors.map(error => error.message).join("; ")}`); }
}

/** Release ownership only after the Hub confirms its workers, listeners and DB
 * are closed. A failed flush may be reported while closure still succeeds. */
export async function closeHubRuntime(options: {
  hub: { beginShutdown(): void; close(): Promise<void>; readonly shutdownComplete: boolean };
  stopRelay?: () => void;
  stopRoutes?: () => Promise<void>;
  finishMaintenance?: () => Promise<unknown> | undefined;
  stopControl?: () => Promise<void>;
  releaseLock: () => Promise<void>;
}): Promise<void> {
  options.hub.beginShutdown();
  const errors = new ShutdownErrors();
  await errors.run("relay.stop", () => options.stopRelay?.());
  await errors.run("routes.stop", () => options.stopRoutes?.());
  await errors.run("maintenance.finish", () => options.finishMaintenance?.());
  await errors.run("hub.close", () => options.hub.close());
  const controlClosed = await errors.run("control.close", () => options.stopControl?.());
  if (options.hub.shutdownComplete && controlClosed) await errors.run("lock.release", options.releaseLock);
  else errors.errors.push(new Error("hub_shutdown_unconfirmed: instance lock retained"));
  errors.finish("hub_shutdown_failed");
}
