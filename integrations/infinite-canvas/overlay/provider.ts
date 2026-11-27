import type { AxiosAdapter } from "axios";
import { callHost, type HostHelloInfo } from "./host-bridge";

let allowedDomains = new Set<string>();
export function setAllowedDomains(info: Pick<HostHelloInfo, "grantedDomains">) {
    allowedDomains = new Set(info.grantedDomains ?? []);
}

const readEndpoint = /^\/(?:v1\/)?(?:models|videos\/[A-Za-z0-9._~-]+(?:\/content)?)\/?$/;
const writeEndpoint = /^\/(?:v1\/)?(?:images\/(?:generations|edits)|responses|chat\/completions|videos)\/?$/;
export async function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol === "blob:" || url.protocol === "data:") return fetch(request);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedDomains.has(url.hostname)) {
        throw Error("MODEL_DESTINATION_DENIED");
    }
    if (!((request.method === "GET" && readEndpoint.test(url.pathname)) || (request.method === "POST" && writeEndpoint.test(url.pathname)))) {
        throw Error("MODEL_ENDPOINT_DENIED");
    }
    const headers: Record<string, string> = {};
    for (const key of ["authorization", "accept", "content-type"]) {
        const value = request.headers.get(key);
        if (value) headers[key] = value;
    }
    request.signal.throwIfAborted();
    const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined;
    request.signal.throwIfAborted();
    const result = await callHost<{ status: number; contentType: string; body: Uint8Array }>(
        "canvas.provider.request", { url: url.href, httpMethod: request.method, headers, ...(body && { body }) },
    );
    request.signal.throwIfAborted();
    return new Response([204, 205, 304].includes(result.status) ? null : new Uint8Array(result.body), {
        status: result.status, headers: { "content-type": result.contentType },
    });
}

export const providerAxios: AxiosAdapter = async config => {
    const headers = new Headers(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)]));
    if (config.data instanceof FormData) headers.delete("content-type");
    const response = await providerFetch(config.url ?? "", {
        method: config.method ?? "GET",
        headers,
        body: config.data,
        signal: config.signal as AbortSignal | undefined,
    });
    const data = config.responseType === "blob" ? await response.blob()
        : config.responseType === "arraybuffer" ? await response.arrayBuffer()
        : await response.text();
    const result = {
        status: response.status,
        statusText: response.statusText,
        data,
        config,
        headers: Object.fromEntries(response.headers.entries()),
    };
    if (config.validateStatus && !config.validateStatus(result.status)) {
        const { AxiosError, AxiosHeaders } = await import("axios");
        const safeConfig = { method: config.method, headers: new AxiosHeaders() };
        throw new AxiosError("MODEL_REQUEST_FAILED", "ERR_BAD_RESPONSE", safeConfig, undefined, { ...result, config: safeConfig, data: "" });
    }
    return result;
};

const promptSourcePath = /^\/yukkcat\/image-prompts\/main\/dist\/sources\/(banana-prompt-quicker|davidwu-gpt-image2-prompts|freestylefly-gpt-image-2|awesome-gpt-image|awesome-gpt4o-image-prompts|youmind-gpt-image-2|youmind-nano-banana-pro)\.json$/;

export async function fetchApprovedPromptSource(input: string, signal?: AbortSignal): Promise<Response> {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com" ||
        url.username || url.password || url.port || url.search || url.hash ||
        !allowedDomains.has(url.hostname) || !promptSourcePath.test(url.pathname)) throw Error("PROMPT_SOURCE_DENIED");
    signal?.throwIfAborted();
    const result = await callHost<{ status: number; contentType: string; body: Uint8Array }>("canvas.prompts.request", { url: url.href });
    signal?.throwIfAborted();
    return new Response(new Uint8Array(result.body), { status: result.status, headers: { "content-type": result.contentType } });
}
