/** DSH web ignores stdin EOF. A private preload keeps its writer lock from
 * outliving the bridge after SIGKILL. Only this child receives the marker;
 * remove it before DSH starts so spawned tools cannot inherit the watchdog. */
const preload = `
const parent = Number(process.env.TAROCUB_DSH_PARENT_PID);
delete process.env.TAROCUB_DSH_PARENT_PID;
if (Number.isSafeInteger(parent) && parent > 1) {
  const initialParent = process.ppid;
  const watch = setInterval(() => {
    let alive = true;
    try { process.kill(parent, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
    if (alive && (process.platform === 'win32' || process.ppid === initialParent)) return;
    clearInterval(watch);
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000);
    process.kill(process.pid, 'SIGTERM');
  }, 100);
  watch.unref();
}
`;
const preloadOption = `--import=data:text/javascript,${encodeURIComponent(preload)}`;

export function deepseekParentGuardEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, preloadOption].filter(Boolean).join(" "),
    TAROCUB_DSH_PARENT_PID: String(process.pid),
  };
}
