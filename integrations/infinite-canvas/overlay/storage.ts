import type { StorageAdapter } from "@infinite-canvas/shared/storage";
import { canvasDocumentSchema, sameCanvasVideoRun, type CanvasDocument } from "@infinite-canvas/shared/canvas/schema/canvas";
import { applyAssetEdits, assetLibraryKey } from "@infinite-canvas/shared/sync-records";
import { makeCollection } from "./collection";

function disabled(): never { throw Error("WORKSPACE_SYNC_DISABLED"); }

export function createEmbeddedStorage(): StorageAdapter {
    const state = makeCollection("state"), projects = makeCollection("projects"), preferences = makeCollection("preferences");
    const works = makeCollection("works"), chats = makeCollection("chats"), media = makeCollection("media"), images = makeCollection("images");
    const videoProofs = makeCollection("video-proofs");
    const pluginFiles = (owner: string) => makeCollection(`plugin-files:${owner}`);
    return {
        kind: "browser",
        async canvasVideoConnection(task, identity, originalFingerprint) {
            const key = JSON.stringify([task.projectId, task.nodeId, task.runId]);
            const existing = await videoProofs.getItem<{ identity: string; fingerprint: string }>(key);
            if (existing) return existing.identity === identity && (!originalFingerprint || existing.fingerprint === originalFingerprint) ? existing.fingerprint : null;
            if (!originalFingerprint) return null;
            const document = await projects.getItem<CanvasDocument>(task.projectId);
            const current = document?.nodes.find(node => node.id === task.nodeId && node.type === "video")?.metadata?.webVideoTask;
            if (!current || !sameCanvasVideoRun(current, task)) return null;
            await videoProofs.setItem(key, { identity, fingerprint: originalFingerprint });
            return originalFingerprint;
        },
        state, preferences, images, media,
        projects: {
            ...projects,
            async setItem(key, value) {
                if (canvasDocumentSchema.parse(value).id !== key) throw Error("STORAGE_INVALID");
                return projects.setItem(key, value);
            },
            async removeItem(key) {
                await projects.removeItem(key);
                const stale: string[] = [];
                await videoProofs.iterate((_, itemKey) => { if (JSON.parse(itemKey)[0] === key) stale.push(itemKey); });
                for (const itemKey of stale) await videoProofs.removeItem(itemKey);
            },
            async clear() {
                await projects.clear();
                await videoProofs.clear();
            },
        },
        works: {
            ...works,
            async create(work) {
                if (await works.getItem(work.workId)) return false;
                await works.setItem(work.workId, work);
                return true;
            },
            syncRecords: async () => disabled(), compareSync: async () => disabled(),
        },
        chats: {
            ...chats,
            syncRecords: async () => disabled(), compareSync: async () => disabled(),
            async deleteThread(id) { await chats.removeItem(id); },
        },
        previews: makeCollection("previews"),
        imageRecords: makeCollection("imageRecords"),
        videoRecords: makeCollection("videoRecords"),
        audioRecords: makeCollection("audioRecords"),
        agentRecords: makeCollection("agentRecords"),
        async editAssetLibrary(edits) {
            const raw = await state.getItem<string>(assetLibraryKey);
            await state.setItem(assetLibraryKey, JSON.stringify(applyAssetEdits(raw ? JSON.parse(raw) : null, edits)));
        },
        async installArchive({ target, files }, archivePreferences) {
            const id = target.kind === "canvas" ? target.document.id : target.work.workId;
            const collection = target.kind === "canvas" ? projects : works;
            if (await collection.getItem(id) !== null) return;
            for (const { resource, blob } of files) {
                const destination = resource.collection === "plugin-files" ? pluginFiles(resource.owner) : resource.collection === "images" ? images : media;
                await destination.setItem(resource.key, blob);
            }
            if (target.kind === "canvas") {
                for (const thread of target.threads) await chats.setItem(thread.id, thread);
                if (archivePreferences) await preferences.setItem(id, archivePreferences);
                await projects.setItem(id, canvasDocumentSchema.parse(target.document));
            } else {
                await works.setItem(id, target.work);
            }
        },
        pluginFiles,
        pluginData: owner => makeCollection(`plugin-data:${owner}`),
        comparePluginSyncData: async () => disabled(),
    };
}
