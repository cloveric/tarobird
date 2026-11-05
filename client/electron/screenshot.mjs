import { mkdtemp, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { helperEnvironment } from './helper-rpc.mjs';
const exec = promisify(execFile), MAX_BYTES = 32 * 1024 * 1024;
let capturing = false;
export function validatePNG(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error('screenshot_too_large');
  if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('screenshot_failed');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 32000000) throw new Error('screenshot_too_large');
  return bytes.toString('base64');
}
export async function captureScreenshot(window, addon, args, active, platform = process.platform) {
  if (!args || typeof args.english !== 'boolean' || Object.keys(args).length !== 1) throw new Error('invalid_screenshot_args');
  if (!window.isVisible() || !window.isFocused()) throw new Error('screenshot_window_unavailable');
  if (capturing) throw new Error('screenshot_busy');
  if (!addon) throw new Error('screenshot_unavailable');
  capturing = true;
  let root, hidden = false;
  try {
    if (!addon.screenCaptureAccess(true)) throw new Error('screenshot_permission_denied');
    if (!active()) throw new Error('native_document_retired');
    window.hide(); hidden = true;
    await new Promise(resolve => setTimeout(resolve,250));
    if (platform === 'win32') {
      const raw = await addon.captureWindows(args.english);
      return raw === null ? null : validatePNG(Buffer.from(raw, 'base64'));
    }
    if (platform !== 'darwin') throw new Error('screenshot_unavailable');
    root = await mkdtemp(path.join(tmpdir(), 'tarobot-capture-'));
    const file = path.join(root,'selection.png');
    try { await exec('/usr/sbin/screencapture',['-i','-x','-o','-t','png',file],{env:helperEnvironment(),timeout:120000,maxBuffer:1024}); }
    catch(error) { if (error.killed) return null; if (error.code !== 1) throw new Error('screenshot_failed'); }
    if (!active()) throw new Error('native_document_retired');
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch(error) { if (error.code === 'ENOENT') return null; throw new Error('screenshot_failed'); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('screenshot_too_large');
      const bytes = Buffer.alloc(stat.size); let offset=0;
      while(offset < bytes.length) { const result=await handle.read(bytes,offset,bytes.length-offset,offset); if(!result.bytesRead)throw new Error('screenshot_failed');offset+=result.bytesRead; }
      return validatePNG(bytes);
    } finally { await handle.close(); }
  } finally {
    if(root)await rm(root,{recursive:true,force:true}).catch(()=>{});
    capturing=false;
    if(hidden&&!window.isDestroyed()){window.show();window.focus();}
  }
}
