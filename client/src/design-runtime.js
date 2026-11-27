import { decodeBase64 } from "../../src/client-protocol/base64.js";
// Runs only in the opaque-origin Design iframe. It has no native bridge,
// cookies, parent DOM or network access. The MessagePort belongs to one tab.
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { legacySlideText } from "./workbench-slides-legacy.js";
export function startDesignRuntime(resources, boot, format = "canvas") {
  // Opaque data: iframes throw SecurityError when accessing localStorage/sessionStorage.
  // Provide an isolated in-memory Storage shim so editor preferences never crash.
  const makeMemoryStorage = () => {
    const map = new Map();
    return {
      get length() { return map.size; },
      key(i) { return [...map.keys()][i] ?? null; },
      getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
      setItem(k, v) { map.set(String(k), String(v)); },
      removeItem(k) { map.delete(String(k)); },
      clear() { map.clear(); },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    try { void globalThis[name]; } catch {
      try { Object.defineProperty(globalThis, name, { value: makeMemoryStorage(), configurable: true }); } catch {}
    }
  }
  const uuidShim = `if(!crypto.randomUUID)crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const s=Array.from(b,v=>v.toString(16).padStart(2,"0")).join("");return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20)};`;
  // A data-origin document is not a secure context. These algorithms use the
  // browser's CSPRNG and the same audited SHA-2 implementation as the App.
  Function(uuidShim)();
  if (!crypto.subtle) Object.defineProperty(crypto, "subtle", { value: { digest: async (algorithm, data) => {
    const hash = { "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512 }[typeof algorithm === "string" ? algorithm.toUpperCase() : algorithm.name];
    if (!hash) throw new Error("design_hash_unsupported"); return hash(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)).buffer;
  } } });
  const nativeFetch = fetch.bind(globalThis), pending = new Map(), sources = new Set(), failedWrites = new Set(); let port, serial = 0;
  const bytes = decodeBase64;
  const base = "https://design.invalid/", assetUrls = new Map(), projectAssetUrls = new Map(), projectAssetHashes = new Map();
  const rememberAsset = (id, file) => { if (!assetUrls.has(id)) assetUrls.set(id, URL.createObjectURL(new Blob([bytes(file.base64)], { type: file.contentType }))); };
  // Rewrites only the generated preview, not the stored project. The upstream
  // server normally serves /_blob; an opaque offline frame cannot request it.
  globalThis.__tarobotDesignAssets = html => typeof html !== "string" ? html : html
    .replace(/(?<![A-Za-z0-9_:/.-])(?:\.?\/)?_blob\/([a-f0-9]{32})(?![a-f0-9])/g, (ref, id) => assetUrls.get(id) ?? ref)
    .replace(/(?<![A-Za-z0-9_:/.-])(?:\.?\/)?(project\/ds\/[A-Za-z0-9_-]+\/assets\/[a-f0-9]{32})(?![A-Za-z0-9_./-])/g, (ref, path) => projectAssetUrls.get(path) ?? ref);
  const dsPrefix = format === "slides" ? "" : "/";
  const canonicalText = content => {
    for (const [id, url] of assetUrls) content = content.replaceAll(url, `/_blob/${id}`);
    for (const [path, url] of projectAssetUrls) content = content.replaceAll(url, `${dsPrefix}${path}`);
    return content;
  };
  const canonicalFiles = files => Object.fromEntries(Object.entries(files).map(([path, file]) => {
    if (!file?.base64 || !/^(text\/|application\/json|image\/svg\+xml)/.test(file.contentType)) return [path, file];
    const content = canonicalText(new TextDecoder().decode(bytes(file.base64)));
    const data = new TextEncoder().encode(content); let binary = '';
    for (let i=0;i<data.length;i+=32768) binary += String.fromCharCode(...data.subarray(i,i+32768));
    return [path, { ...file, base64: btoa(binary) }];
  }));
  const request = (operation, payload) => new Promise((resolve, reject) => {
    const id = ++serial;
    const writeKey = operation === "db.write" ? String(payload.path) : undefined;
    const timer = setTimeout(() => { pending.delete(id); if(writeKey)failedWrites.add(writeKey); reject(new Error("design_request_timeout")); }, 15000);
    pending.set(id, { resolve, reject, timer, writeKey }); port.postMessage({ id, operation, payload });
  });
  // Upstream repair actions use chat.suggestPrompt. Keep them on the existing
  // tab-owned draft path: no upstream session dispatch and no automatic send.
  // A declined composer must reject so upstream never reports success.
  globalThis.__tarobotDesignSuggest = async text => {
    if (globalThis.__tarobirdDesignRepairEnabled === false) throw new Error("design_repair_unavailable");
    if (typeof text !== "string" || !text.trim() || text.length > 10_000) throw new Error("design_invalid_prompt");
    const result = await request("comments.request", { text });
    if (result?.status !== 202 || result.body?.draft !== "opened") throw new Error("design_draft_unavailable");
  };
  // A shared edit can introduce assets after boot. Only fetch new/changed bytes,
  // and prepare their local URLs before the editor renders that edit.
  const syncAssets = async () => {
    for (const [id, file] of Object.entries(await request("assets", { known: [...assetUrls.keys()] }))) rememberAsset(id, file);
    const listing = await request("list", {});
    for (const [path, meta] of Object.entries(listing.files)) {
      const designSystem = /^project\/ds\/[A-Za-z0-9_-]+\/assets\/[a-f0-9]{32}$/.test(path);
      if (!designSystem || projectAssetHashes.get(path) === meta.sha256) continue;
      const file = await request("read", { path });
      if (!file) continue;
      projectAssetUrls.set(path, URL.createObjectURL(new Blob([bytes(file.base64)], { type: file.contentType })));
      projectAssetHashes.set(path, file.sha256);
    }
  };
  // Ordinary DB edits cannot introduce asset files. Only fetch resources for
  // references this frame has not seen; external file changes still synchronize.
  const needsAssets = event => {
    if (event.type === "external-change") return true;
    if (event.type !== "db-change") return false;
    const content = JSON.stringify(event.changes);
    for (const match of content.matchAll(/_blob\/([a-f0-9]{32})(?![a-f0-9])/g)) if (!assetUrls.has(match[1])) return true;
    for (const match of content.matchAll(/(project\/ds\/[A-Za-z0-9_-]+\/assets\/[a-f0-9]{32})(?![A-Za-z0-9_./-])/g)) if (!projectAssetUrls.has(match[1])) return true;
    return false;
  };
  let assetEvents = Promise.resolve();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const response = async (operation,payload={}) => { const result=await request(operation,payload);return json(result.body,result.status); };
  const rewriteValue = value => typeof value === "string" ? globalThis.__tarobotDesignAssets(value) : Array.isArray(value) ? value.map(rewriteValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewriteValue(item)])) : value;
  const canonicalValue = value => typeof value === "string" ? canonicalText(value) : Array.isArray(value) ? value.map(canonicalValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,canonicalValue(item)])) : value;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input.href, base);
    if (url.protocol === "blob:") return nativeFetch(input, options);
    if (url.origin !== new URL(base).origin || url.hash) throw new Error("design_network_unavailable");
    const path = decodeURIComponent(url.pathname.slice(1));
    if (path === "_api/session" || path === "__deck/session") return response("session");
    if (path === "_api/doc" || path === "_api/collection") {
      const result=await request(path.endsWith("doc")?"db.read":"db.list", {path:url.searchParams.get("path")});
      return json(rewriteValue(result.body),result.status);
    }
    if (path === "_api/write") {
      const result=await request("db.write",canonicalValue(JSON.parse(options.body)));
      return json(result?.body ?? result, result?.status ?? 200);
    }
    if (path === "__presence") return response("presence.patch",JSON.parse(options.body ?? "{}"));
    if (path === "__comments" || path.startsWith("__comments/")) {
      const method=(options.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), parts=path.split("/"), body=options.body?JSON.parse(options.body):{};
      if(parts.length===1 && method==="GET")return response("comments.snapshot");
      if(parts.length===1 && method==="POST")return response("comments.create",body);
      if(parts.length===3 && parts[1]==="agent" && parts[2]==="requests" && method==="POST")return response("comments.request",body);
      if(parts.length===2 && method==="PATCH")return response("comments.status",{...body,id:parts[1]});
      if(parts.length===2 && method==="DELETE")return response("comments.delete",{id:parts[1]});
      if(parts.length===3 && parts[2]==="messages" && method==="POST")return response("comments.reply",{...body,id:parts[1]});
      if(parts.length===4 && parts[2]==="messages" && method==="PATCH")return response("comments.edit",{...body,id:parts[1],messageId:parts[3]});
      if(parts.length===3 && parts[2]==="send" && method==="POST")return response("comments.send",{id:parts[1]});
      return json({code:"NOT_FOUND"},404);
    }
    if (url.search) throw new Error("design_network_unavailable");
    if (resources[path]) return new Response(bytes(resources[path].base64), { headers: { "Content-Type": resources[path].type } });
    if (path === "_files.json") return json(await request("list", {}));
    if (path === "__deck/publish") {
      const body = JSON.parse(options.body); const result = await request("publish", { ...body, files: canonicalFiles(body.files) }); return json(result.body, result.status);
    }
    if ((path === "__deck/assets" || path === "_api/upload")) {
      const data = new Uint8Array(await new Response(options.body).arrayBuffer());
      let binary = ""; for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
      const file = { base64: btoa(binary), contentType: new Headers(options.headers).get("Content-Type") };
      const result = await request("upload", file); rememberAsset(result.id, file); return json(result);
    }
    if (path.startsWith("project/") || path.startsWith("_blob/")) {
      const file = await request("read", { path });
      return file ? new Response(bytes(file.base64), { headers: { "Content-Type": file.contentType } }) : new Response(null, { status: 404 });
    }
    throw new Error("design_resource_unavailable");
  };
  // Bounded, tab-owned events: no polling service or ambient network socket.
  class PortEvents extends EventTarget {
    static CONNECTING=0; static OPEN=1; static CLOSED=2;
    readyState=0; busy=false; again=false;
    constructor(url) { super(); this.url=new URL(url,base); if(this.url.origin!==new URL(base).origin || !["/_api/events","/__deck/events","/__comments/events"].includes(this.url.pathname)) throw new Error("design_events_unavailable"); sources.add(this); queueMicrotask(()=>this.refresh()); }
    emit(type,body) {if(this.readyState!==2)this.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(body)}));}
    async refresh() {
      if(this.readyState===2)return; if(this.busy){this.again=true;return;} this.busy=true;
      try {
        const comments=this.url.pathname==="/__comments/events", db=this.url.pathname==="/_api/events";
        const data=await request(comments?"comments.snapshot":db?"db.list":"list",{}); if(this.readyState===2)return;
        if(this.readyState===0){this.readyState=1;this.dispatchEvent(new Event("open"));}
        this.emit(comments?"comments":"snapshot",db?rewriteValue(data.body):comments?data.body:data);
      }catch { if(this.readyState!==2)this.dispatchEvent(new Event("error")); }
      finally {this.busy=false;if(this.again){this.again=false;void this.refresh();}}
    }
    close(){this.readyState=2;sources.delete(this);}
  }
  const encodeBytes = data => {
    let binary = "";
    for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
    return btoa(binary);
  };
  const inferContentType = path => {
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
    if (path.endsWith(".svg")) return "image/svg+xml";
    return "text/plain";
  };
  const artifactError = (code, message, paths) => {
    const err = new Error(message || code);
    err.name = "ArtifactError";
    err.code = code;
    if (paths) err.paths = paths;
    return err;
  };
  const mapCommentAuthor = author => ({
    kind: author?.kind === "agent" ? "agent" : "person",
    name: author?.name || (author?.kind === "agent" ? "Bot" : "You"),
  });
  const mapCommentThread = thread => ({
    id: thread.id,
    anchor: thread.anchor,
    label: thread.label,
    ...(thread.detail ? { detail: thread.detail } : {}),
    location: thread.location ?? {},
    status: thread.status === "resolved" ? "resolved" : "open",
    ...(thread.agent ? { agent: { status: thread.agent.status, ...(thread.agent.via === "chat" ? { drafted: true } : {}) } } : {}),
    messages: (thread.messages ?? []).map(m => ({
      id: m.id,
      author: mapCommentAuthor(m.author),
      text: m.text,
      at: m.at,
      ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    })),
  });
  const artifactChangeListeners = new Set(), commentChangeListeners = new Set(), peerListeners = new Set(), roomMessageListeners = new Set(), agentStatusListeners = new Set();
  const lastKnownHashes = new Map();

  const installOpenArtifactRuntime = init => {
    const artifactId = typeof init.designId === "string" && init.designId ? init.designId : "presentation";
    let deckTitle = typeof init.title === "string" && init.title ? init.title : "Presentation";
    const forcedReadOnly = init.readOnly === true;
    const repairEnabled = globalThis.__tarobirdDesignRepairEnabled !== false;
    const selfPeerId = crypto.randomUUID();
    let cachedPeers = [];
    const loadSession = async () => {
      const res = await request("session");
      return res?.body ?? { canEdit: false, role: "viewer" };
    };
    const loadAgentStatus = async () => {
      if (forcedReadOnly || !repairEnabled) return { available: false, busy: false, name: "Bot", wakesIdle: true };
      try {
        const res = await request("comments.snapshot");
        const available = res?.status === 200 && res?.body?.agent?.available === true;
        return { available, busy: false, name: "Bot", wakesIdle: true };
      } catch {
        return { available: false, busy: false, name: "Bot", wakesIdle: true };
      }
    };
    const capabilities = {
      user: {
        async me() {
          const s = await loadSession();
          const role = forcedReadOnly ? "viewer" : (s.role || (s.canEdit ? "owner" : "viewer"));
          return { id: s.userId || "local", name: s.userName || "You", role };
        },
      },
      artifact: {
        id: artifactId,
        async title() { return deckTitle; },
        async list() {
          const listing = await request("list", {});
          const out = {};
          lastKnownHashes.clear();
          for (const [path, meta] of Object.entries(listing?.files ?? {})) {
            out[path] = { sha256: meta.sha256, size: meta.size };
            lastKnownHashes.set(path, meta.sha256);
          }
          return out;
        },
        async readText(path) {
          const file = await request("read", { path });
          if (!file) { lastKnownHashes.delete(path); throw artifactError("not_found", `Missing file: ${path}`); }
          if (typeof file.sha256 === "string") lastKnownHashes.set(path, file.sha256);
          const text = new TextDecoder("utf-8").decode(bytes(file.base64));
          // A slide saved by the 1.6.0 editor: the editor is given a form it places
          // the same way. The stored file and its hash (the editor's ifMatch) stay.
          return /^project\/slides\/[^/]+\.html$/.test(path) ? legacySlideText(text) : text;
        },
        async readBytes(path) {
          const file = await request("read", { path });
          if (!file) { lastKnownHashes.delete(path); throw artifactError("not_found", `Missing file: ${path}`); }
          if (typeof file.sha256 === "string") lastKnownHashes.set(path, file.sha256);
          return bytes(file.base64);
        },
        async publish(batch) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          const files = {};
          const expectedHashes = {};
          for (const [path, entry] of Object.entries(batch ?? {})) {
            if (entry === null) {
              const known = lastKnownHashes.get(path);
              files[path] = { delete: true, ...(known !== undefined ? { ifMatch: known } : {}) };
              expectedHashes[path] = known ?? null;
            } else {
              const contentType = inferContentType(path);
              const base64 = entry.encoding === "base64"
                ? entry.content
                : encodeBytes(new TextEncoder().encode(canonicalText(entry.content)));
              files[path] = {
                base64,
                contentType,
                ...(entry.ifMatch !== undefined ? { ifMatch: entry.ifMatch } : {}),
              };
              if (entry.ifMatch !== undefined) expectedHashes[path] = entry.ifMatch;
            }
          }
          const result = await request("publish", { files: canonicalFiles(files) });
          if (result?.status === 200) {
            const shas = result.body?.shas ?? {};
            const hashes = {};
            for (const path of Object.keys(batch ?? {})) {
              const nextHash = Object.prototype.hasOwnProperty.call(shas, path) ? shas[path] : null;
              hashes[path] = nextHash;
              if (nextHash === null) lastKnownHashes.delete(path);
              else lastKnownHashes.set(path, nextHash);
            }
            return { hashes };
          }
          if (result?.status === 403) throw artifactError("not_writer", result.body?.message || "Read-only");
          if (result?.status === 409) {
            const latest = await request("list", {}).catch(() => null);
            const latestFiles = latest?.files;
            if (latestFiles && typeof latestFiles === "object") {
              lastKnownHashes.clear();
              for (const [p, meta] of Object.entries(latestFiles)) {
                if (typeof meta?.sha256 === "string") lastKnownHashes.set(p, meta.sha256);
              }
            }
            const conflictPaths = [];
            for (const [path, expected] of Object.entries(expectedHashes)) {
              const actual = latestFiles?.[path]?.sha256 ?? null;
              if (actual !== expected) conflictPaths.push({ path, expected, actual });
            }
            throw artifactError("conflict", result.body?.message || "Conflict", conflictPaths.length ? conflictPaths : Object.keys(batch ?? {}).map(path => ({ path, expected: expectedHashes[path] ?? null, actual: latestFiles?.[path]?.sha256 ?? null })));
          }
          throw artifactError("invalid", result?.body?.message || "Could not save presentation");
        },
        onChange(listener) {
          artifactChangeListeners.add(listener);
          return () => artifactChangeListeners.delete(listener);
        },
      },
      assets: forcedReadOnly ? null : {
        async upload(data, _options) {
          const raw = new Uint8Array(await data.arrayBuffer());
          const contentType = data.type || "application/octet-stream";
          const file = { base64: encodeBytes(raw), contentType };
          const result = await request("upload", file);
          rememberAsset(result.id, file);
          return { id: result.id, url: `/_blob/${result.id}`, sizeBytes: result.sizeBytes ?? raw.byteLength, contentType };
        },
      },
      downloads: {
        browser: true,
        async check() {},
        async save({ name, data }) {
          await globalThis.__tarobotDesignSave({ filename: name, data });
          return {};
        },
      },
      agent: forcedReadOnly || !repairEnabled ? null : {
        async status() { return loadAgentStatus(); },
        onStatus(listener) {
          agentStatusListeners.add(listener);
          void loadAgentStatus().then(s => { if (agentStatusListeners.has(listener)) listener(s); });
          return () => agentStatusListeners.delete(listener);
        },
        async send(req) {
          if (globalThis.__tarobirdDesignRepairEnabled === false) return { status: "failed", reason: "Not available here." };
          const text = typeof req?.text === "string" ? req.text.trim() : "";
          if (!text) return { status: "failed", reason: "Empty request" };
          const res = await request("comments.request", { text: text.slice(0, 10000), ...(req?.title ? { label: String(req.title).slice(0, 1000) } : {}) });
          if (res?.status === 202 && res.body?.draft === "opened") return { status: "delivered", drafted: true };
          return { status: "failed", reason: res?.body?.message || "Use the conversation composer to ask the Bot." };
        },
      },
      comments: {
        async list() {
          const res = await request("comments.snapshot");
          if (res?.status !== 200) return [];
          return (res.body?.threads ?? []).map(mapCommentThread);
        },
        async create(input) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          const res = await request("comments.create", {
            anchor: input.anchor,
            label: input.label,
            ...(input.detail ? { detail: input.detail } : {}),
            text: input.text,
          });
          if (res?.status >= 400 || !res?.body?.thread) throw artifactError(res?.status === 403 ? "not_writer" : "invalid", res?.body?.message || "Could not create comment");
          return mapCommentThread(res.body.thread);
        },
        async reply(threadId, text) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          const res = await request("comments.reply", { id: threadId, text });
          if (res?.status >= 400 || !res?.body?.thread) throw artifactError(res?.status === 403 ? "not_writer" : "invalid", res?.body?.message || "Could not reply");
          return mapCommentThread(res.body.thread);
        },
        async edit(threadId, messageId, text) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          const res = await request("comments.edit", { id: threadId, messageId, text });
          if (res?.status >= 400 || !res?.body?.thread) throw artifactError(res?.status === 403 ? "not_writer" : "invalid", res?.body?.message || "Could not edit");
          return mapCommentThread(res.body.thread);
        },
        async react(threadId) {
          const list = await capabilities.comments.list();
          const found = list.find(t => t.id === threadId);
          if (!found) throw artifactError("not_found", "Thread not found");
          return found;
        },
        async setResolved(threadId, resolved) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          const res = await request("comments.status", { id: threadId, status: resolved ? "resolved" : "open" });
          if (res?.status >= 400 || !res?.body?.thread) throw artifactError(res?.status === 403 ? "not_writer" : "invalid", res?.body?.message || "Could not update status");
          return mapCommentThread(res.body.thread);
        },
        async move(threadId, anchor, location) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          if (typeof anchor !== "string" || !anchor) throw artifactError("invalid", "Invalid comment anchor");
          const label = typeof location?.label === "string" && location.label.trim() ? location.label.trim() : undefined;
          const res = await request("comments.move", { id: threadId, anchor, ...(label ? { label } : {}) });
          if (res?.status >= 400 || !res?.body?.thread) throw artifactError(res?.status === 403 ? "not_writer" : res?.status === 404 ? "not_found" : "invalid", res?.body?.message || "Could not move comment");
          return mapCommentThread(res.body.thread);
        },
        async remove(threadId) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          const res = await request("comments.delete", { id: threadId });
          if (res?.status >= 400) throw artifactError(res?.status === 403 ? "not_writer" : "invalid", res?.body?.message || "Could not delete");
        },
        async sendToAgent(threadId) {
          if (forcedReadOnly) throw artifactError("not_writer", "Read-only preview");
          if (!repairEnabled) throw artifactError("unavailable", "Not available here.");
          const res = await request("comments.send", { id: threadId });
          if (res?.status !== 202 || res.body?.draft !== "opened") throw artifactError("unavailable", res?.body?.message || "Draft unavailable");
          const thread = res.body?.thread ? mapCommentThread(res.body.thread) : (await capabilities.comments.list()).find(t => t.id === threadId);
          if (!thread) throw artifactError("not_found", "Thread not found");
          // Opening a chat composer draft does not send the message yet; keep the
          // actual server thread state so the user can retry if the draft is cleared.
          return thread;
        },
        onChange(listener) {
          commentChangeListeners.add(listener);
          return () => commentChangeListeners.delete(listener);
        },
      },
      room: {
        async self() { return selfPeerId; },
        async presence(patch) { try { await request("presence.patch", patch ?? {}); } catch {} },
        async peers() { return cachedPeers; },
        onPeers(listener) {
          peerListeners.add(listener);
          return () => peerListeners.delete(listener);
        },
        async emit() {},
        onMessage(listener) {
          roomMessageListeners.add(listener);
          return () => roomMessageListeners.delete(listener);
        },
      },
    };
    const runtime = Object.freeze({
      version: "1.4.0",
      async use(name) {
        const cap = Object.prototype.hasOwnProperty.call(capabilities, name) ? capabilities[name] : null;
        return cap ? Object.freeze(cap) : null;
      },
    });
    if (!globalThis.openartifact) {
      Object.defineProperty(globalThis, "openartifact", { value: runtime, configurable: false, enumerable: true, writable: false });
    }
    return {
      onExternalChange(event) {
        const changes = event?.files ?? {};
        for (const [p, h] of Object.entries(changes)) {
          if (h === null) lastKnownHashes.delete(p);
          else lastKnownHashes.set(p, h);
        }
        const author = event?.by?.agent ? "agent" : event?.by?.name;
        for (const fn of [...artifactChangeListeners]) { try { fn({ changes, ...(author ? { author } : {}) }); } catch {} }
      },
      onComments(snapshot) {
        const threads = (snapshot?.threads ?? []).map(mapCommentThread);
        for (const fn of [...commentChangeListeners]) { try { fn(threads); } catch {} }
      },
      onPeers(peers) {
        cachedPeers = Array.isArray(peers) ? peers.map(p => ({ id: String(p.id ?? p.userId ?? ""), name: String(p.name ?? ""), kind: "person", state: p.state ?? {} })) : [];
        for (const fn of [...peerListeners]) { try { fn(cachedPeers); } catch {} }
      },
      onTitle(nextTitle) {
        if (typeof nextTitle !== "string" || !nextTitle.trim()) return;
        deckTitle = nextTitle.trim();
        document.title = deckTitle;
        try { globalThis.__tarobotSlidesSetTitle?.(deckTitle); } catch {}
      },
    };
  };

  let openArtifactBridge = null;
  globalThis.EventSource = PortEvents;
  if (format === "canvas") {
    globalThis.__tarobotLegacySave = (blob,filename) => globalThis.__tarobotDesignSave({filename,data:blob}).then(()=>({shown:filename}));
  }
  // The Slides host omits the shell download adapter. Route it through the same
  // bounded, user-gesture-gated parent export used by the canvas. No direct
  // iframe download permission or filesystem access is granted.
  globalThis.__tarobotDesignSave = ({filename, data}) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = outcome => {
      clearTimeout(timer); removeEventListener("message", receive);
      if (outcome === "saved") resolve();
      else reject(artifactError(outcome, outcome === "declined" ? "Export cancelled" : "Export was not saved"));
    };
    const receive = event => {
      if (event.source === parent && event.data?.type === "editor:save-file-result" && event.data.requestId === requestId) finish(event.data.outcome);
    };
    const timer = setTimeout(() => finish("failed"), 180000);
    addEventListener("message", receive);
    parent.postMessage({type:"editor:save-file", requestId, filename, data}, "*");
  });
  // Nested previews share only this opaque origin. Report user focus so the
  // App freezes the correct design tab when composing a Bot request in split.
  const attached = new WeakSet(), watched = new WeakSet();
  const focus = event => { if (event.isTrusted) parent.postMessage({ type: "tarobot-design-focus" }, "*"); };
  const wire = doc => {
    if (!doc || attached.has(doc)) return; attached.add(doc);
    doc.addEventListener("pointerdown", focus, true); doc.addEventListener("focusin", focus, true);
    const scan = () => { for (const frame of doc.querySelectorAll("iframe")) {
      if (!watched.has(frame)) { watched.add(frame); frame.addEventListener("load", () => { try { wire(frame.contentDocument); } catch {} }); }
      try { wire(frame.contentDocument); } catch {}
    } };
    new MutationObserver(scan).observe(doc, { childList: true, subtree: true }); scan();
  };
  wire(document);
  const flags = { design_fast_edit: false, appifact_extra_export_formats: true, design_theme_tab: true, slides_theme_tab: true, appifact_icon_set: true, appifact_bottom_toolbar: false };
  globalThis.__appifact_flags = { version: "appifact-flags:v1", ready: async () => true, get: (key, fallback) => flags[key] ?? fallback, all: () => ({ ...flags }) };
  const setTheme = dark => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("data-mode", dark ? "dark" : "light");
  };
  addEventListener("message", async function initialize(event) {
    if (event.source !== parent) return;
    if (event.data?.type === "tarobot-design-theme" && port && typeof event.data.dark === "boolean") { setTheme(event.data.dark); return; }
    if (event.data?.type === "tarobot-design-title" && port && typeof event.data.title === "string") { openArtifactBridge?.onTitle(event.data.title); return; }
    if (event.data?.type !== "tarobot-design-init" || port || !event.ports[0]) return;
    // Host-owned presentation capability, settled before the editor boots.
    // iOS keeps editing and error details, but omits automatic repair requests.
    Object.defineProperty(globalThis, "__tarobirdDesignRepairEnabled", { value: event.data.repairRequests !== false });
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if(data?.type === "design-event") {
        const event=data.event;
        const deliver = () => {
          if (openArtifactBridge) {
            if (event.type === "external-change") openArtifactBridge.onExternalChange(event);
            else if (event.type === "comments") openArtifactBridge.onComments(event.snapshot);
            else if (event.type === "peers") openArtifactBridge.onPeers(event.peers);
          }
          for(const source of sources) {
            if(event.type==="comments" && source.url.pathname==="/__comments/events") source.emit("comments",event.snapshot);
            else if(event.type==="db-change" && source.url.pathname==="/_api/events") source.emit("change",rewriteValue({changes:event.changes}));
            else if(event.type==="external-change" && source.url.pathname==="/__deck/events") source.emit("external-change",event);
            else if(event.type==="peers") source.emit("peers",event.peers);
          }
        };
        if(needsAssets(event)) {
          assetEvents=assetEvents.catch(()=>{}).then(async()=>{await syncAssets();deliver();}).catch(()=>{parent.postMessage({type:"tarobot-design-error",code:"design_resource_unavailable"},"*");});
        } else deliver();
        return;
      }
      if(data?.type === "document-changed") return;
      const task = pending.get(data?.id); if (!task) return;
      pending.delete(data.id); clearTimeout(task.timer); if(task.writeKey) {if(data.error || (data.result?.status ?? 200)>=400)failedWrites.add(task.writeKey);else failedWrites.delete(task.writeKey);}
      data.error ? task.reject(new Error(data.error)) : task.resolve(data.result);
    };
    setTheme(event.data.dark);
    if (format === "slides") {
      openArtifactBridge = installOpenArtifactRuntime(event.data);
    }
    for (const [name, resource] of Object.entries(resources)) {
      if (!name.endsWith(".js")) continue;
      resource.url = URL.createObjectURL(new Blob([uuidShim, bytes(resource.base64)], { type: resource.type }));
    }
    globalThis.__tarobotDesignResource = name => { if (!resources[name]?.url) throw new Error("design_resource_unavailable"); return resources[name].url; };
    for (const [name, file] of [["dc-runtime-file", "artifact-type/dc-runtime.js"], ["dc-babel-file", "artifact-type/babel.min.js"]]) if (resources[file]) document.querySelector(`meta[name="${name}"]`).content = resources[file].url;
    try {
      // Native img/CSS loads cannot use the MessagePort fetch adapter.
      await syncAssets();
      await boot();

    } catch { parent.postMessage({ type: "tarobot-design-error", code: "design_editor_load_failed" }, "*"); }
  });
  parent.postMessage({ type: "tarobot-design-ready" }, "*");
}
