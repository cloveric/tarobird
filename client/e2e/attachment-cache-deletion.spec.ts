import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html";
});
test.afterAll(async () => { await server.close(); });

for (const method of ["blob", "file"] as const) for (const phase of ["download", "cache-write"] as const) {
  test(`a deleted attachment is not cached by a late ${method} ${phase}`, async ({ page }) => {
    await page.goto(url);
    const result = await page.evaluate(async ({ method, phase }) => {
      const storagePath = "/src/storage.ts", connectionPath = "/src/connection.ts";
      const { ClientCache } = await import(storagePath), { HubConnection } = await import(connectionPath);
      const cache = new ClientCache(`attachment-delete-${crypto.randomUUID()}`);
      const connection = new HubConnection({ deviceId: "fixture", publicKey: "fixture", name: "Fixture", routes: [] }, cache);
      connection.state.status = "online";
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      // Only the network response is synthetic; use the real download assembler
      // and IndexedDB cache. No authenticated user Host or production data.
      connection.readAttachment = async (_id: string, _headers: HeadersInit, consume: (response: Response) => Promise<unknown>) => {
        if (phase === "download") { entered(); await gate; }
        return consume(new Response("attachment fixture", { status: 200, headers: { "Content-Type": "text/plain" } }));
      };
      if (phase === "cache-write") {
        const save = cache.saveAttachment.bind(cache);
        cache.saveAttachment = (id: string, blob: Blob, ...rest: unknown[]) => {
          const read = blob.arrayBuffer.bind(blob);
          blob.arrayBuffer = async () => { entered(); await gate; return read(); };
          return save(id, blob, ...rest);
        };
      }
      try {
        const pending = connection[method]("att_deleted", {});
        await started;
        await connection.forgetDeletedAttachments(["att_deleted"]);
        release();
        const downloaded = await pending;
        if (method === "file") await downloaded.dispose();
        const cached = await cache.attachment("att_deleted");
        return { deleted: connection.attachmentDeleted("att_deleted"), cached: !!cached };
      } finally { release(); connection.close(); cache.close(); }
    }, { method, phase });
    expect(result).toEqual({ deleted: true, cached: false });
  });
}
