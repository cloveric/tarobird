// Acceptance-only observer. Does not reject network requests or subprocesses.
const fs = require('node:fs');
const Module = require('node:module');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = Module;
const report = process.env.TAROBOT_STANDALONE_OBSERVER;
const record = (kind, name) => { if (report) fs.appendFileSync(report, JSON.stringify({ kind, name, pid: process.pid })+'\n', { mode: 0o600 }); };
const originalLoad = Module._load;
Module._load = function(name, ...args) { if (String(name).includes('@larksuiteoapi/')) record('feishu_module', '@larksuiteoapi'); return originalLoad.call(this, name, ...args); };
for (const method of ['spawn', 'execFile', 'spawnSync', 'execFileSync', 'fork']) {
 const original = cp[method];
 cp[method] = function(file, ...args) { const name = String(file).split(/[\\/]/).pop(); record(/^(?:lark-cli|lark)(?:\.cmd)?$/.test(name) ? 'feishu_process' : 'process', name); return original.call(this, file, ...args); };
}
function observeUrl(value) { try { const host = typeof value === 'string' || value instanceof URL ? new URL(value).hostname : value.hostname || value.host; if (/(^|\.)(feishu\.cn|larksuite\.com)$/.test(String(host))) record('feishu_network', String(host)); } catch {} }
for (const transport of [require('node:http'), require('node:https')]) for (const method of ['request','get']) { const original = transport[method]; transport[method] = function(input,...args) { observeUrl(input); return original.call(this,input,...args); }; }
if (globalThis.fetch) { const original=globalThis.fetch;globalThis.fetch=(input,...args)=>{observeUrl(typeof input==='object'&&input.url?input.url:input);return original(input,...args);}; }
syncBuiltinESMExports();
