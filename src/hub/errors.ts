/** Shared by storage and transport without creating a store/index import cycle. */
export class HubError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
