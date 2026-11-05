import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export interface ProcessEpoch { bootId?: string; processBirth?: string; machineId?: string }
const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let boot: Promise<string | undefined> | undefined;
let ownBirth: Promise<string | undefined> | undefined;
let machine: Promise<string | undefined> | undefined;

async function windowsMachineIdentity(): Promise<string | undefined> {
  try {
    // Registry64 is stable across a computer rename and independent of the
    // calling process architecture. Read only; missing access stays unknown.
    const script = "$ErrorActionPreference='Stop';$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64);try{$key=$base.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography');try{[Console]::Write($key.GetValue('MachineGuid'))}finally{if($key){$key.Dispose()}}}finally{$base.Dispose()}";
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const id = stdout.trim().toLowerCase();
    return uuid.test(id) ? `win32:${id}` : undefined;
  } catch { return undefined; }
}

async function bootIdentity(): Promise<string | undefined> {
  try {
    const value = process.platform === "linux"
      ? await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      : process.platform === "darwin"
        ? (await exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 3000, maxBuffer: 4096 })).stdout
        : "";
    const id = value.trim().toLowerCase();
    return uuid.test(id) ? `${process.platform}:${id}` : undefined;
  } catch { return undefined; }
}

async function windowsProcessBirth(pid: number): Promise<string | undefined> {
  try {
    // StartTime reads the kernel's immutable process creation FILETIME. It does
    // not infer a boot time from the current wall clock or uptime, so changing
    // the clock cannot turn a currently live owner into a stale lock.
    const script = `$ErrorActionPreference='Stop';[Console]::Write([System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture))`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const value = stdout.trim();
    return /^\d{1,20}$/.test(value) ? `win32:${value}` : undefined;
  } catch { return undefined; }
}

/** Native process start identity, paired with boot UUID when persisted. */
async function posixProcessBirth(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "linux") {
      // /proc comm may contain spaces and parentheses. Fields after its last
      // closing parenthesis start at field 3; starttime is field 22.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      return /^\d{1,20}$/.test(start ?? "") ? `linux:${start}` : undefined;
    }
    if (process.platform === "darwin") {
      const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        timeout: 3000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      const value = stdout.trim();
      if (!/^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value)) return undefined;
      const startedAt = Date.parse(`${value} UTC`);
      return Number.isFinite(startedAt) && startedAt > 0 ? `darwin:${startedAt}` : undefined;
    }
  } catch { /* Process exit and unavailable native metadata stay unknown. */ }
  return undefined;
}

/** Metadata is advisory when unavailable, but a proven epoch mismatch means
 * the PID belongs to another boot/process. Legacy locks stay conservative. */
export async function readProcessEpoch(pid: number): Promise<ProcessEpoch> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {};
  if (process.platform === "win32") {
    const [machineId, processBirth] = await Promise.all([machine ??= windowsMachineIdentity(), pid === process.pid ? ownBirth ??= windowsProcessBirth(pid) : windowsProcessBirth(pid)]);
    return { ...(machineId ? { machineId } : {}), ...(processBirth ? { processBirth } : {}) };
  }
  const [bootId, processBirth] = await Promise.all([boot ??= bootIdentity(), pid === process.pid ? ownBirth ??= posixProcessBirth(pid) : posixProcessBirth(pid)]);
  return { ...(bootId ? { bootId } : {}), ...(processBirth ? { processBirth } : {}) };
}
