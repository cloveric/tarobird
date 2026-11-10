import { t } from "./i18n.js";

const ROOT = "tarocub-download-tmp-v1", MEMORY_LIMIT = 16 * 1024 ** 2, HANDOFF_TTL = 24 * 60 * 60 * 1000;
const validName = (name: string) => /^[0-9a-f-]{36}$/.test(name);
const lockName = (name: string) => `${ROOT}:${name}`;
export class TemporaryDownloadError extends Error {
  constructor(cause: unknown) { super(t("临时文件写入失败，请检查剩余空间后重试。"), { cause }); this.name = "TemporaryDownloadError"; }
}

/** Each consumer owns a lease. Closing a preview must not remove bytes still
 * being saved or copied into a browser download response. */
export interface AttachmentSource {
  readonly blob: Blob;
  readonly storage: "memory" | "disk";
  readonly browserLock?: string;
  retain(): AttachmentSource;
  dispose(): Promise<void>;
}
export function leasedSource(blob: Blob, storage: AttachmentSource["storage"], dispose: () => Promise<void>, browserLock?: string): AttachmentSource {
  let references = 0;
  const lease = (): AttachmentSource => {
    references++; let released = false;
    return { blob, storage, browserLock,
      retain: () => { if (released) throw new Error("attachment_source_released"); return lease(); },
      dispose: async () => { if (!released) { released = true; if (--references === 0) await dispose(); } },
    };
  };
  return lease();
}
export const memoryAttachment = (blob: Blob): AttachmentSource => leasedSource(blob, "memory", async () => undefined);

/** Skip files held by any tab. A crashed tab releases its Web Lock; its
 * unverified temporary bytes are removed before the next large download. */
export async function sweepTemporaryDownloads(): Promise<void> {
  if (!globalThis.navigator?.storage?.getDirectory || !navigator.locks) return;
  let root: FileSystemDirectoryHandle;
  try { root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT); } catch { return; }
  for await (const [name, entry] of root.entries()) {
    if (entry.kind !== "directory" || !validName(name)) continue;
    await navigator.locks.request(lockName(name), { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      try {
        const directory = await root.getDirectoryHandle(name);
        const handoff = await directory.getFileHandle("handoff").then((handle) => handle.getFile()).catch(() => undefined);
        if (handoff && handoff.lastModified > Date.now() - HANDOFF_TTL) return;
        await root.removeEntry(name, { recursive: true });
      } catch { /* Already removed by another tab, or temporarily unavailable. */ }
    });
  }
}

type Disk = { root: FileSystemDirectoryHandle; directory: FileSystemDirectoryHandle; name: string; handle: FileSystemFileHandle; writer?: FileSystemWritableFileStream; unlock: () => void };

/** Small files and older/private WebViews retain the existing Blob path.
 * Once disk writing starts, failures never silently restart in RAM. */
export class DownloadBuffer {
  private parts: Blob[] = [];
  private size = 0;
  private disk?: Disk;
  private unavailable = false;
  private diskUsed = false;
  constructor(private readonly preferDisk: boolean) {}
  private async openDisk(): Promise<Disk | undefined> {
    if (!this.preferDisk || this.unavailable || !globalThis.navigator?.storage?.getDirectory || !navigator.locks) return;
    const name = crypto.randomUUID(); let unlock!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    let root: FileSystemDirectoryHandle | undefined;
    try {
      const locking = navigator.locks.request(lockName(name), { mode: "shared" }, async () => { acquired(); await held; });
      await Promise.race([ready, locking]);
      await sweepTemporaryDownloads();
      root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
      const directory = await root.getDirectoryHandle(name, { create: true }), handle = await directory.getFileHandle("data", { create: true });
      if (typeof handle.createWritable !== "function") throw new DOMException("Unsupported storage", "NotSupportedError");
      const writer = await handle.createWritable();
      this.diskUsed = true;
      return { root, directory, handle, writer, name, unlock };
    } catch (error) {
      await root?.removeEntry(name, { recursive: true }).catch(() => undefined); unlock();
      // No file bytes were written yet. Private WebKit can expose OPFS but
      // reject creation with UnknownError; keep its existing compatibility path.
      if (!this.diskUsed && error instanceof DOMException && ["NotSupportedError", "SecurityError", "UnknownError", "InvalidStateError"].includes(error.name)) { this.unavailable = true; return; }
      throw new TemporaryDownloadError(error);
    }
  }
  async append(part: Blob): Promise<void> {
    try {
      if (!this.disk && this.size + part.size > MEMORY_LIMIT) {
        this.disk = await this.openDisk();
        if (this.disk) { for (const previous of this.parts) await this.disk.writer!.write(previous); this.parts = []; }
      }
      if (this.disk) await this.disk.writer!.write(part); else this.parts.push(part);
      this.size += part.size;
    } catch (error) { throw error instanceof TemporaryDownloadError ? error : new TemporaryDownloadError(error); }
  }
  async reset(): Promise<void> {
    this.parts = []; this.size = 0;
    const disk = this.disk; this.disk = undefined;
    if (disk) {
      try { await disk.writer?.abort().catch(() => undefined); await disk.root.removeEntry(disk.name, { recursive: true }).catch(() => undefined); }
      finally { disk.unlock(); }
    }
  }
  async finish(mime: string): Promise<AttachmentSource> {
    if (!this.disk) { const blob = new Blob(this.parts, { type: mime }); this.parts = []; return memoryAttachment(blob); }
    const disk = this.disk;
    try {
      await disk.writer!.close(); disk.writer = undefined;
      const file = await disk.handle.getFile();
      if (file.size !== this.size) throw new Error("temporary_file_size_mismatch");
      const blob = file.slice(0, file.size, mime);
      const source = leasedSource(blob, "disk", async () => {
        disk.unlock();
        // The worker may outlive the originating page. Delete only after its
        // shared read lock has ended. Consumers keep their lease until the
        // browser transfer settles, including its initial ready handshake.
        await navigator.locks.request(lockName(disk.name), async () => {
          await disk.root.removeEntry(disk.name, { recursive: true }).catch(() => undefined);
        }).catch(() => undefined);
      }, lockName(disk.name));
      this.disk = undefined; return source;
    } catch (error) { throw new TemporaryDownloadError(error); }
  }
}
