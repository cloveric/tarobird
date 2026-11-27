export const CANVAS_NODE_MAX_SOURCE_BYTES: number;
export function canvasNodeSourceURL(raw: unknown): string;
export interface CanvasNetworkInput {
  kind: "provider" | "prompts" | "source";
  url: string;
  httpMethod: "GET" | "POST";
  headers?: Record<string, string | undefined>;
  body?: Uint8Array;
}
export function canvasNetworkRequest(input: CanvasNetworkInput, active?: () => boolean): Promise<{ status: number; contentType: string; body: Uint8Array }>;
