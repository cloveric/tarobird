export class HubHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "HubHttpError"; }
}
export function transientUploadError(error: unknown): boolean {
  if (error instanceof HubHttpError) return error.status === 0 || [408, 429, 502, 503, 504].includes(error.status) || error.status === 401 && error.code === "token_expired_or_invalid";
  return error instanceof TypeError || error instanceof DOMException && ["AbortError", "TimeoutError", "NetworkError"].includes(error.name);
}
