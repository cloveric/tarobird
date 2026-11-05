import { designPath } from "../../src/client-protocol/workbench-design.js";
import { decodeDesignFile, designTextFile, type DesignDocument, type DesignFile } from "./workbench-design.js";

export type DesignSystemSource = { scope: string; id: string; title: string };
const text = (file: DesignFile) => new TextDecoder("utf-8", {fatal:true}).decode(decodeDesignFile(file));
const wire = (file: DesignFile, prior?: DesignFile) => ({base64:file.base64,contentType:file.contentType,ifMatch:prior?.sha256 ?? null});
/** Copy the selected immutable source snapshot; never execute its README/code.
 * Sync refuses to overwrite local changes, including source-deleted files. */
export function designSystemInstall(target: DesignDocument, source: DesignDocument, identity: DesignSystemSource) {
  if(![undefined,"canvas","slides"].includes(target.format) || source.format!=="design-system" || source.id!==identity.id) throw new Error("design_system_wrong_format");
  const namespace=`system-${source.id.replace(/[^A-Za-z0-9_-]/g,"").slice(0,48).toLowerCase()}`;
  const prefix=`project/ds/${namespace}/`, metaPath=`${prefix}tarobot-source.json`;
  // The executable/exportable project carries only an opaque reference. The
  // real source scope stays in the local library and is matched on each sync.
  const sourceRef=designTextFile(JSON.stringify([identity.scope,identity.id])).sha256;
  const prior = target.files[metaPath] ? JSON.parse(text(target.files[metaPath])) : undefined;
  const legacy=prior?.schema===1;
  if(prior && (legacy ? prior.id!==identity.id || prior.scope!==identity.scope : prior.schema!==2 || prior.sourceRef!==sourceRef)) throw new Error("design_system_namespace_conflict");
  const indexPath=target.format==="slides"?"project/deck.json":"project/canvas.json";
  const index=JSON.parse(text(target.files[indexPath]));
  const records=Array.isArray(index.designSystems)?index.designSystems:Object.values(index.designSystems ?? {});
  const previous=records.find((record:any)=>record.namespace===namespace);
  const artifact=`tarobot-design:${sourceRef}`;
  if(previous && previous.artifact!==artifact && !(legacy && previous.artifact===`tarobot-design:${encodeURIComponent(identity.scope)}/${identity.id}`))throw new Error("design_system_namespace_conflict");
  if(!previous && records.length>=4)throw new Error("design_system_limit");
  const copies:Record<string,DesignFile>={};
  for(const [path,file] of Object.entries(source.files)) {
    const name=path.slice("project/".length);if(name==="tarobot-source.json" || name.startsWith("db/"))continue;
    const destination=designPath.parse(prefix+name);
    // Content-addressed asset URLs become portable project-file references in
    // this copy. The source itself is never altered.
    copies[destination]=/^(text\/|application\/json|image\/svg\+xml)/.test(file.contentType)
      ? designTextFile(text(file).replace(/(?<![\w:/.-])(?:\.?\/)?_blob\/([a-f0-9]{32})(?![a-f0-9])/g,(_all,id)=>`/${prefix}assets/${id}`),file.contentType):file;
  }
  const batch:Record<string,unknown>={};
  const oldHashes:Record<string,string>=prior?.hashes ?? {};
  for(const path of new Set([...Object.keys(copies),...Object.keys(oldHashes)])) {
    if(!path.startsWith(prefix) || !designPath.safeParse(path).success)throw new Error("design_system_invalid_source");
    const current=target.files[path];
    if(current && current.sha256!==oldHashes[path] && current.sha256!==copies[path]?.sha256)throw new Error("design_system_local_changes");
    if(!current && oldHashes[path] && copies[path])throw new Error("design_system_local_changes");
    if(copies[path])batch[path]=wire(copies[path],current);
    else if(current)batch[path]={delete:true,ifMatch:current.sha256};
  }
  batch[metaPath]=wire(designTextFile(JSON.stringify({schema:2,sourceRef,title:identity.title,revision:source.revision,hashes:Object.fromEntries(Object.entries(copies).map(([path,file])=>[path,file.sha256]))}),"application/json"),target.files[metaPath]);
  index.designSystems=[...records.filter((record:any)=>record.namespace!==namespace),{namespace,title:identity.title,artifact,version:String(source.revision),copiedAt:new Date().toISOString()}];
  batch[indexPath]=wire(designTextFile(JSON.stringify(index),"application/json"),target.files[indexPath]);
  return batch;
}
