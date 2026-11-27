import { hostBridge } from "./host-bridge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encodeStoredValue(value: unknown): Promise<Uint8Array> {
    if (value instanceof Blob) {
        const header = encoder.encode(JSON.stringify({ type: value.type, blob: true }) + "\n");
        const encoded = new Uint8Array(header.length + value.size);
        encoded.set(header);
        encoded.set(new Uint8Array(await value.arrayBuffer()), header.length);
        return encoded;
    }
    return encoder.encode(JSON.stringify({ value }));
}

export function decodeStoredValue(bytes: Uint8Array): unknown {
    if (bytes[0] !== 123) throw Error("STORAGE_INVALID");
    const line = bytes.indexOf(10);
    if (line === -1) return JSON.parse(decoder.decode(bytes)).value;
    const header = JSON.parse(decoder.decode(bytes.subarray(0, line)));
    if (header.blob !== true || typeof header.type !== "string") throw Error("STORAGE_INVALID");
    return new Blob([bytes.slice(line + 1)], { type: header.type });
}

type HostData = Pick<typeof hostBridge, "dataGet" | "dataPut" | "dataRemove" | "dataKeys">;

export function makeCollection(name: string, host: HostData = hostBridge) {
    const prefix = `${name}/`;
    const keyOf = (key: string) => `${prefix}${key}`;
    const keys = async () => (await host.dataKeys()).filter(key => key.startsWith(prefix));
    return {
        async getItem<T>(key: string) {
            const bytes = await host.dataGet(keyOf(key));
            return (bytes ? decodeStoredValue(bytes) : null) as T | null;
        },
        async setItem<T>(key: string, value: T) {
            await host.dataPut(keyOf(key), await encodeStoredValue(value));
            return value;
        },
        async removeItem(key: string) { await host.dataRemove(keyOf(key)); },
        async clear() {
            for (const key of await keys()) await host.dataRemove(key);
        },
        async iterate<T, R>(visit: (value: T, key: string, index: number) => R) {
            let index = 0;
            for (const key of await keys()) {
                const bytes = await host.dataGet(key);
                if (!bytes) continue;
                const result = visit(decodeStoredValue(bytes) as T, key.slice(prefix.length), ++index);
                if (result !== undefined) return result;
            }
        },
    };
}
