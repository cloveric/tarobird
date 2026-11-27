import type { PluginManifest } from "../../src/client-protocol/plugins.js";
import type { InstalledPluginRecord } from "./plugin-registry.js";
import { t } from "./i18n.js";

export type MarketplaceTab = "discover" | "installed" | "developer";
export type MarketplaceCategory = "all" | "workbench" | "productivity" | "community";

export function pluginMarketplaceCategory(manifest: PluginManifest): Exclude<MarketplaceCategory, "all"> {
  if (!manifest.official) return "community";
  if (manifest.contributions.some((item) => item.kind === "workbench-item")) return "workbench";
  return "productivity";
}

export function pluginPublisherLabel(
  manifest: PluginManifest,
  sourceKind?: InstalledPluginRecord["sourceKind"],
): string {
  if (sourceKind === "local-dev") return t("本地开发");
  if (manifest.official) return "TaroBird";
  return manifest.source.repository.split("/")[0] || manifest.source.repository;
}

export function matchesPluginMarketplaceQuery(manifest: PluginManifest, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    manifest.id,
    manifest.name,
    manifest.nameZh ?? "",
    manifest.description,
    manifest.descriptionZh ?? "",
    manifest.source.repository,
    manifest.official ? "tarobird official" : "community",
  ].some((value) => value.toLowerCase().includes(needle));
}

export type LocalFolderFileLike = {
  name: string;
  webkitRelativePath?: string;
};

function normalizeRelativePath(file: LocalFolderFileLike): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Resolves top-level `manifest.json` from a folder selection, avoiding nested
 * `node_modules/.../manifest.json` files. */
export function selectLocalManifestFile<T extends LocalFolderFileLike>(files: readonly T[]): T | undefined {
  const withRel = files.some((file) => Boolean(file.webkitRelativePath));
  if (withRel) {
    // Standard webkitdirectory upload has `<folder>/manifest.json` (depth 2) or `manifest.json` (depth 1).
    return files.find((file) => {
      const segments = normalizeRelativePath(file).split("/").filter(Boolean);
      return (segments.length === 2 && segments[1] === "manifest.json")
        || (segments.length === 1 && segments[0] === "manifest.json");
    });
  }
  return files.find((file) => file.name === "manifest.json");
}

/** Resolves the declared `entry` HTML file strictly relative to `manifestFile`'s
 * directory so a root `index.html` never shadows `dist/index.html`. */
export function selectLocalEntryFile<T extends LocalFolderFileLike>(
  files: readonly T[],
  manifestFile: T,
  rawEntry: unknown,
): { entryPath: string; file?: T } {
  const entryPath = (typeof rawEntry === "string" && rawEntry.trim() ? rawEntry.trim() : "index.html")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!entryPath || entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
    return { entryPath, file: undefined };
  }
  const withRel = files.some((file) => Boolean(file.webkitRelativePath));
  if (withRel) {
    const manifestRel = normalizeRelativePath(manifestFile);
    const slash = manifestRel.lastIndexOf("/");
    const manifestDir = slash >= 0 ? manifestRel.slice(0, slash + 1) : "";
    const expectedRel = `${manifestDir}${entryPath}`;
    return {
      entryPath,
      file: files.find((file) => normalizeRelativePath(file) === expectedRel),
    };
  }
  return {
    entryPath,
    file: entryPath.includes("/") ? undefined : files.find((file) => file.name === entryPath),
  };
}
