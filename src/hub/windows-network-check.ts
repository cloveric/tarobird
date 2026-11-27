import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { WindowsFirewallStatus, WindowsNetworkCategory } from "../client-protocol/network-candidates.js";

const DEFAULT_ROUTE_TIMEOUT_MS = 3_000;
const FIREWALL_TIMEOUT_MS = 6_000;

export type PowerShellRunner = (script: string, timeoutMs: number) => Promise<string>;

export type WindowsNetworkEnvironment = {
  platform: NodeJS.Platform;
  executablePath?: string;
  systemRoot?: string;
  runPowerShell?: PowerShellRunner;
};

function defaultEnvironment(): WindowsNetworkEnvironment {
  return {
    platform: process.platform,
    executablePath: process.execPath,
    systemRoot: process.env.SystemRoot,
  };
}

function getWindowsPowerShellPath(systemRoot = "C:\\Windows"): string {
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function createPowerShellRunner(systemRoot?: string): PowerShellRunner {
  const powershellPath = getWindowsPowerShellPath(systemRoot);
  return (script, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        powershellPath,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
}

function getRunner(environment: WindowsNetworkEnvironment): PowerShellRunner {
  return environment.runPowerShell ?? createPowerShellRunner(environment.systemRoot);
}

export function buildWindowsDefaultRouteScript(): string {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$names = @(Get-NetRoute -ErrorAction Stop | Where-Object { $_.State -eq 'Alive' -and ($_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0') } | Select-Object -ExpandProperty InterfaceAlias -Unique)
ConvertTo-Json -InputObject $names -Compress`;
}

export async function getWindowsDefaultRouteInterfaceNames(
  environment: WindowsNetworkEnvironment = defaultEnvironment(),
): Promise<ReadonlySet<string> | null> {
  if (environment.platform !== "win32") return new Set();
  try {
    const stdout = await getRunner(environment)(buildWindowsDefaultRouteScript(), DEFAULT_ROUTE_TIMEOUT_MS);
    const trimmed = stdout.trim();
    if (!trimmed) return new Set();
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return new Set([parsed]);
    if (!Array.isArray(parsed) || !parsed.every(name => typeof name === "string")) return null;
    return new Set(parsed);
  } catch {
    return null;
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0);
}

function subnetMask(prefixLength: number): number {
  if (prefixLength <= 0) return 0;
  if (prefixLength >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefixLength)) >>> 0;
}

function remoteScopeCoversSubnet(scopeToken: string, localIp: number, localPrefix: number): boolean {
  const token = scopeToken.trim();
  if (!token) return false;
  if (/^(?:any|\*|localsubnet)$/i.test(token)) return true;
  if (token.includes("/")) {
    const [ipStr, prefixStr] = token.split("/");
    const ip = ipStr ? ipv4ToInt(ipStr) : null;
    const prefix = prefixStr && /^\d+$/.test(prefixStr) ? Number(prefixStr) : NaN;
    if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix > localPrefix) return false;
    const mask = subnetMask(prefix);
    return (ip & mask) === (localIp & mask);
  }
  if (token.includes("-")) {
    const [startStr, endStr] = token.split("-");
    const start = startStr ? ipv4ToInt(startStr) : null;
    const end = endStr ? ipv4ToInt(endStr) : null;
    if (start === null || end === null || start > end) return false;
    const mask = subnetMask(localPrefix);
    const netStart = (localIp & mask) >>> 0;
    const netEnd = (netStart | (~mask >>> 0)) >>> 0;
    return start <= netStart && end >= netEnd;
  }
  return false;
}

export function hasSufficientWindowsFirewallRemoteScope(
  matchingRuleScopes: unknown,
  localAddress: unknown,
  localPrefixLength: unknown,
): boolean {
  if (!Array.isArray(matchingRuleScopes) || matchingRuleScopes.length === 0) return false;
  const localIp = typeof localAddress === "string" ? ipv4ToInt(localAddress) : null;
  const prefix = typeof localPrefixLength === "number" && Number.isInteger(localPrefixLength) && localPrefixLength >= 0 && localPrefixLength <= 32
    ? localPrefixLength
    : 24;

  return matchingRuleScopes.some(scope => {
    if (!scope || typeof scope !== "object") return false;
    const remoteAddresses = (scope as { remoteAddresses?: unknown }).remoteAddresses;
    if (!Array.isArray(remoteAddresses) || remoteAddresses.length === 0) return false;
    return remoteAddresses.some(entry => {
      if (typeof entry !== "string") return false;
      const trimmed = entry.trim();
      if (/^(?:any|\*|localsubnet)$/i.test(trimmed)) return true;
      return localIp !== null && remoteScopeCoversSubnet(trimmed, localIp, prefix);
    });
  });
}

function parseNetworkCategory(value: unknown): WindowsNetworkCategory {
  if (value === "Private") return "private";
  if (value === "Public") return "public";
  if (value === "DomainAuthenticated") return "domain";
  return "unknown";
}

export function recommendedWindowsFirewallCommand(port: number): string {
  return `New-NetFirewallRule -DisplayName "TaroBird Hub" -Direction Inbound -Protocol TCP -LocalPort ${port} -Profile Private -Action Allow`;
}

export function buildWindowsFirewallInspectionScript(port: number, executablePath?: string, address?: string): string {
  const addressLookup = address
    ? `
try {
  $ip = Get-NetIPAddress -IPAddress ${quotePowerShellLiteral(address)} -ErrorAction Stop | Select-Object -First 1
  $localAddress = [string]$ip.IPAddress
  $localPrefixLength = [int]$ip.PrefixLength
  $profile = Get-NetConnectionProfile -InterfaceIndex $ip.InterfaceIndex -ErrorAction Stop | Select-Object -First 1
  if ($profile) { $networkCategory = [string]$profile.NetworkCategory }
} catch {}`
    : "";
  const programFilter = executablePath
    ? `$appRules = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program ${quotePowerShellLiteral(executablePath)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
$portRules = @(Get-NetFirewallPortFilter -PolicyStore ActiveStore -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { @($_.LocalPort | Where-Object { [string]$_ -eq '${port}' }).Count -gt 0 } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
$seen = @{}
$rules = @($appRules + $portRules | Where-Object { if ($seen.ContainsKey($_.Name)) { $false } else { $seen[$_.Name] = $true; $true } })`
    : `$rules = @(Get-NetFirewallPortFilter -PolicyStore ActiveStore -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { @($_.LocalPort | Where-Object { [string]$_ -eq '${port}' }).Count -gt 0 } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })`;

  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$matchingRuleScopes = @()
$blockingRuleDetected = $false
${programFilter}
foreach ($rule in $rules) {
  $portFilter = $rule | Get-NetFirewallPortFilter
  $protocol = [string]$portFilter.Protocol
  $profile = [string]$rule.Profile
  $portMatches = @($portFilter.LocalPort | Where-Object { [string]$_ -eq 'Any' -or [string]$_ -eq '${port}' }).Count -gt 0
  if (($protocol -eq 'Any' -or $protocol -eq 'TCP' -or $protocol -eq '6') -and ($profile -eq 'Any' -or $profile -match 'Private') -and $portMatches) {
    if ([string]$rule.Action -eq 'Block') {
      $blockingRuleDetected = $true
    } elseif ([string]$rule.Action -eq 'Allow') {
      $addressFilter = $rule | Get-NetFirewallAddressFilter
      $matchingRuleScopes += [pscustomobject]@{
        remoteAddresses = @($addressFilter.RemoteAddress | ForEach-Object { [string]$_ })
      }
    }
  }
}
$privateProfile = Get-NetFirewallProfile -PolicyStore ActiveStore -Name Private | Select-Object -First 1
$privateFirewallEnabled = ($null -ne $privateProfile) -and ([string]$privateProfile.Enabled -eq 'True')
$localAddress = $null
$localPrefixLength = $null
$networkCategory = 'Unknown'${addressLookup}
[pscustomobject]@{
  matchingRuleScopes = @($matchingRuleScopes)
  blockingRuleDetected = $blockingRuleDetected
  localAddress = $localAddress
  localPrefixLength = $localPrefixLength
  privateFirewallEnabled = $privateFirewallEnabled
  networkCategory = $networkCategory
} | ConvertTo-Json -Depth 4 -Compress`;
}

type FirewallInspectionResult = {
  matchingRuleScopes?: unknown;
  blockingRuleDetected?: unknown;
  localAddress?: unknown;
  localPrefixLength?: unknown;
  privateFirewallEnabled?: unknown;
  networkCategory?: unknown;
};

export async function inspectWindowsMobileFirewall(
  port: number | null,
  address: string | undefined,
  environment: WindowsNetworkEnvironment = defaultEnvironment(),
): Promise<WindowsFirewallStatus> {
  if (environment.platform !== "win32" || port === null || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { supported: false };
  }

  const recommendedCommand = recommendedWindowsFirewallCommand(port);
  try {
    const stdout = await getRunner(environment)(
      buildWindowsFirewallInspectionScript(port, environment.executablePath, address),
      FIREWALL_TIMEOUT_MS,
    );
    const result = JSON.parse(stdout.trim()) as FirewallInspectionResult;
    const blockingRuleDetected = result.blockingRuleDetected === true;
    const ruleAllowed =
      !blockingRuleDetected &&
      hasSufficientWindowsFirewallRemoteScope(
        result.matchingRuleScopes,
        result.localAddress,
        result.localPrefixLength,
      );
    return {
      supported: true,
      port,
      networkCategory: parseNetworkCategory(result.networkCategory),
      privateFirewallEnabled: result.privateFirewallEnabled !== false,
      ruleAllowed,
      blockingRuleDetected,
      inspectionAvailable: true,
      recommendedCommand,
    };
  } catch {
    return {
      supported: true,
      port,
      networkCategory: "unknown",
      privateFirewallEnabled: true,
      ruleAllowed: false,
      blockingRuleDetected: false,
      inspectionAvailable: false,
      recommendedCommand,
    };
  }
}
