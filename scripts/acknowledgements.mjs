#!/usr/bin/env node
/**
 * Generate and verify third-party acknowledgements from a single list
 * (`third-party/acknowledgements.json`) plus bundled npm runtime dependencies.
 *
 * Usage:
 *   node scripts/acknowledgements.mjs generate [--json-only] [--root <dir>]
 *   node scripts/acknowledgements.mjs check    [--root <dir>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_CATEGORIES = new Set(["asset", "vendored", "npm", "desktop", "android", "ios"]);
const REQUIRED_FIELDS = ["id", "name", "category", "repository", "version", "license", "licenseFile", "usage", "location"];
const TABLE_START = "<!-- acknowledgements:table:start -->";
const TABLE_END = "<!-- acknowledgements:table:end -->";
const LICENSE_FILE_PATTERN = /^(?:license|licence|copying)(?:[._-].*)?$/i;
const NOTICE_FILENAMES = ["NOTICE", "NOTICE.md", "NOTICE.txt", "notice.txt"];
const FULL_LICENSE_TEXT_PATTERN = /(?:permission is hereby granted|redistribution and use in source|licensed under the apache license|permission to use, copy, modify|without warranty of any kind|the software is provided)/i;
const MIN_EMBEDDED_LICENSE_CHARS = 250;

function normalizeLineEndings(text) {
  return String(text).replace(/\r\n/g, "\n").trim();
}

export function normalizeRepoUrl(repo) {
  if (!repo) return "";
  const raw = (typeof repo === "string" ? repo : typeof repo === "object" && typeof repo.url === "string" ? repo.url : "").trim();
  if (!raw) return "";

  let candidate = raw.replace(/^git\+/, "");
  if (/^git:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^git:\/\//i, "https://");
  } else if (/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/i.test(candidate)) {
    candidate = candidate.replace(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/i, "https://$1/$2");
  } else if (/^git@([^:]+):(.+)$/i.test(candidate)) {
    candidate = candidate.replace(/^git@([^:]+):(.+)$/i, "https://$1/$2");
  } else if (/^github:/i.test(candidate)) {
    candidate = `https://github.com/${candidate.slice("github:".length).replace(/^\/+/, "")}`;
  } else if (/^gitlab:/i.test(candidate)) {
    candidate = `https://gitlab.com/${candidate.slice("gitlab:".length).replace(/^\/+/, "")}`;
  } else if (/^bitbucket:/i.test(candidate)) {
    candidate = `https://bitbucket.org/${candidate.slice("bitbucket:".length).replace(/^\/+/, "")}`;
  } else if (/^gist:/i.test(candidate)) {
    candidate = `https://gist.github.com/${candidate.slice("gist:".length).replace(/^\/+/, "")}`;
  } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[#/].*)?$/.test(candidate)) {
    candidate = `https://github.com/${candidate}`;
  }

  candidate = candidate.replace(/\.git(?=[#?]|$)/i, "");
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return "";
    }
    return candidate;
  } catch {
    return "";
  }
}

function readSafeRepoFile(rootDir, relativePath, fieldLabel) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`Missing ${fieldLabel}`);
  }
  const resolved = path.resolve(rootDir, relativePath);
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (resolved !== rootDir && !resolved.startsWith(rootPrefix)) {
    throw new Error(`Path escapes repository root for ${fieldLabel}: ${relativePath}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Missing file for ${fieldLabel}: ${relativePath}`);
  }
  const text = normalizeLineEndings(readFileSync(resolved, "utf8"));
  if (!text) {
    throw new Error(`Empty license/notice text for ${fieldLabel}: ${relativePath}`);
  }
  return text;
}

function findPackageFile(pkgDir, candidates) {
  if (!existsSync(pkgDir)) return undefined;
  let files;
  try { files = readdirSync(pkgDir); } catch { return undefined; }
  const lowerMap = new Map(files.map((name) => [name.toLowerCase(), name]));
  for (const candidate of candidates) {
    const match = lowerMap.get(candidate.toLowerCase());
    if (match) {
      const full = path.join(pkgDir, match);
      try {
        if (!statSync(full).isFile()) continue;
        const text = normalizeLineEndings(readFileSync(full, "utf8"));
        if (text) return { file: match, text };
      } catch { /* ignore unreadable */ }
    }
  }
  return undefined;
}

function findPackageLicenseTexts(pkgDir) {
  if (!existsSync(pkgDir)) return "";
  let files;
  try { files = readdirSync(pkgDir); } catch { return ""; }
  const matched = files
    .filter((name) => {
      if (!LICENSE_FILE_PATTERN.test(name)) return false;
      // SPDX metadata headers (e.g. LICENSE.spdx) do not contain the legal license text.
      if (name.toLowerCase().endsWith(".spdx")) return false;
      try { return statSync(path.join(pkgDir, name)).isFile(); } catch { return false; }
    })
    .sort((a, b) => {
      const aBase = /^(?:license|licence|copying)(?:\.(?:md|txt))?$/i.test(a) ? 0 : 1;
      const bBase = /^(?:license|licence|copying)(?:\.(?:md|txt))?$/i.test(b) ? 0 : 1;
      return aBase - bBase || a.localeCompare(b);
    });

  const texts = [];
  for (const name of matched) {
    try {
      const text = normalizeLineEndings(readFileSync(path.join(pkgDir, name), "utf8"));
      if (text) texts.push(text);
    } catch { /* ignore unreadable */ }
  }
  return texts.join("\n\n---\n\n");
}

function resolveOverrideLicense(rootDir, depName, overrides) {
  if (!overrides || typeof overrides !== "object") return "";
  let relPath = overrides[depName];
  if (!relPath) {
    for (const [pattern, target] of Object.entries(overrides)) {
      if (pattern.endsWith("*") && depName.startsWith(pattern.slice(0, -1))) {
        relPath = target;
        break;
      }
    }
  }
  if (!relPath) return "";
  return readSafeRepoFile(rootDir, relPath, `npmLicenseOverrides["${depName}"]`);
}

function extractFullReadmeLicense(pkgDir) {
  const readme = findPackageFile(pkgDir, ["README.md", "readme.md", "README.txt", "README"]);
  if (!readme || !/licen[cs]e/i.test(readme.text)) return "";
  const match = readme.text.match(/##?\s*licen[cs]e[\s\S]*$/i);
  if (!match) return "";
  const section = match[0].trim();
  if (section.length < MIN_EMBEDDED_LICENSE_CHARS || !FULL_LICENSE_TEXT_PATTERN.test(section)) {
    return "";
  }
  return section;
}

function extractLicenseDecl(meta) {
  if (typeof meta.license === "string") return meta.license.trim();
  if (typeof meta.license?.type === "string") return meta.license.type.trim();
  if (Array.isArray(meta.licenses)) {
    return meta.licenses.map((item) => item?.type).filter(Boolean).join(" OR ");
  }
  return "";
}

function collectSourcePackages(source) {
  const results = [];
  const pkg = JSON.parse(readFileSync(source.pkgJson, "utf8"));
  const directDeps = new Set(Object.keys(pkg.dependencies ?? {}));

  if (existsSync(source.lockJson)) {
    const lock = JSON.parse(readFileSync(source.lockJson, "utf8"));
    const packages = lock.packages ?? {};
    for (const [pkgPath, lockInfo] of Object.entries(packages)) {
      if (!pkgPath || lockInfo?.dev) continue;
      const pkgDir = path.join(source.baseDir, pkgPath);
      const pkgMetaPath = path.join(pkgDir, "package.json");
      if (!existsSync(pkgMetaPath)) {
        if (lockInfo?.optional) continue;
        throw new Error(`Cannot inspect installed npm package at ${pkgMetaPath}`);
      }
      const meta = JSON.parse(readFileSync(pkgMetaPath, "utf8"));
      const depName = meta.name || lockInfo?.name || pkgPath.replace(/^.*node_modules\//, "");
      const version = String(meta.version ?? lockInfo?.version ?? "");
      const location = directDeps.has(depName) ? source.directLocation : source.lockLocation;
      results.push({ depName, version, pkgDir, meta, location, usage: source.usage });
    }
    return results;
  }

  for (const depName of [...directDeps].sort()) {
    const pkgDir = path.join(source.baseDir, "node_modules", ...depName.split("/"));
    const pkgMetaPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgMetaPath)) {
      throw new Error(`Cannot inspect installed npm package "${depName}" at ${pkgMetaPath}`);
    }
    const meta = JSON.parse(readFileSync(pkgMetaPath, "utf8"));
    const version = String(meta.version ?? pkg.dependencies[depName] ?? "");
    results.push({ depName, version, pkgDir, meta, location: source.directLocation, usage: source.usage });
  }
  return results;
}

function collectNpmDependencies(rootDir, manifestEntries, npmLicenseOverrides) {
  const manualIds = new Set(manifestEntries.map((entry) => entry.id));
  const manualNames = new Set(manifestEntries.map((entry) => entry.name.toLowerCase()));
  const sources = [
    {
      baseDir: path.join(rootDir, "client"),
      pkgJson: path.join(rootDir, "client", "package.json"),
      lockJson: path.join(rootDir, "client", "package-lock.json"),
      directLocation: "client/package.json",
      lockLocation: "client/package-lock.json",
      usage: "Bundled client App runtime dependency",
    },
    {
      baseDir: rootDir,
      pkgJson: path.join(rootDir, "package.json"),
      lockJson: path.join(rootDir, "package-lock.json"),
      directLocation: "package.json",
      lockLocation: "package-lock.json",
      usage: "Bundled Host / CLI runtime dependency",
    },
  ];

  const byNameVersion = new Map();
  const versionsByName = new Map();

  for (const source of sources) {
    if (!existsSync(source.pkgJson)) continue;
    for (const item of collectSourcePackages(source)) {
      const { depName, version, pkgDir, meta, location, usage } = item;
      // Skip packages already represented explicitly in third-party/acknowledgements.json (e.g. xlsx).
      if (depName === "xlsx" && manualIds.has("sheetjs-xlsx")) continue;
      if (manualNames.has(depName.toLowerCase())) continue;

      const nvKey = `${depName}@${version}`;
      const existing = byNameVersion.get(nvKey);
      if (existing) {
        if (!existing.locations.includes(location)) existing.locations.push(location);
        continue;
      }

      const licenseDecl = extractLicenseDecl(meta);
      let licenseText = findPackageLicenseTexts(pkgDir);
      if (!licenseText && depName.startsWith("@napi-rs/canvas-")) {
        // Platform-specific native prebuild subpackages of @napi-rs/canvas share the parent package's LICENSE.
        licenseText = findPackageLicenseTexts(path.join(path.dirname(pkgDir), "canvas"));
      }
      if (!licenseText) {
        licenseText = resolveOverrideLicense(rootDir, depName, npmLicenseOverrides);
      }
      if (!licenseText) {
        licenseText = extractFullReadmeLicense(pkgDir);
      }
      if (!licenseText) {
        throw new Error(
          `Bundled npm package "${depName}@${version}" is missing full license text (no standalone LICENSE file or curated override in third-party/acknowledgements.json).`,
        );
      }

      const notice = findPackageFile(pkgDir, NOTICE_FILENAMES);
      const repoUrl = normalizeRepoUrl(meta.repository)
        || normalizeRepoUrl(meta.homepage)
        || `https://www.npmjs.com/package/${encodeURIComponent(depName).replace(/%2F/gi, "/")}`;

      if (!versionsByName.has(depName)) versionsByName.set(depName, new Set());
      versionsByName.get(depName).add(version);

      byNameVersion.set(nvKey, {
        depName,
        version,
        name: depName,
        category: "npm",
        repository: repoUrl,
        license: licenseDecl || "See license text",
        usage: (typeof meta.description === "string" && meta.description.trim()) ? meta.description.trim() : usage,
        locations: [location],
        licenseText,
        ...(notice ? { noticeText: notice.text } : {}),
      });
    }
  }

  return [...byNameVersion.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(({ depName, locations, ...item }) => {
      const multipleVersions = (versionsByName.get(depName)?.size ?? 0) > 1;
      return {
        id: multipleVersions ? `npm:${depName}@${item.version}` : `npm:${depName}`,
        ...item,
        location: locations.join(", "),
      };
    });
}

function validateSharedLicenseTemplates(manifestEntries, licenseTextByFile) {
  const entriesByFile = new Map();
  for (const entry of manifestEntries) {
    const file = entry.licenseFile.trim();
    if (!entriesByFile.has(file)) entriesByFile.set(file, []);
    entriesByFile.get(file).push(entry);
  }
  for (const [file, group] of entriesByFile) {
    if (group.length < 2) continue;
    const text = licenseTextByFile.get(file) ?? "";
    if (/apache license[\s\S]*version 2\.0/i.test(text) && /sheetjs/i.test(text)) {
      throw new Error(`Shared Apache-2.0 license template "${file}" must not contain an unrelated copyright holder (SheetJS).`);
    }
    if (path.basename(file).toLowerCase() === "apache-2.0.txt") {
      const appendixIdx = text.indexOf("APPENDIX:");
      if (appendixIdx >= 0) {
        const appendix = text.slice(appendixIdx);
        if (/^\s*Copyright\s+(?!\[yyyy\])/im.test(appendix)) {
          throw new Error(`Generic license template "${file}" contains a specific copyright holder in its appendix; use the standard placeholder and put component copyrights in noticeFile.`);
        }
      }
    }
  }
}

export function buildAcknowledgements(rootDir) {
  const manifestPath = path.join(rootDir, "third-party", "acknowledgements.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Invalid third-party/acknowledgements.json: expected { version: 1, entries: [...] }");
  }

  const seenIds = new Set();
  const licenseTextByFile = new Map();
  const curated = manifest.entries.map((entry, idx) => {
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Entry #${idx} (${entry.id ?? entry.name ?? "unknown"}) is missing required field "${field}".`);
      }
    }
    if (!VALID_CATEGORIES.has(entry.category)) {
      throw new Error(`Entry "${entry.id}" has invalid category "${entry.category}".`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry id "${entry.id}" in third-party/acknowledgements.json.`);
    }
    seenIds.add(entry.id);

    const repository = normalizeRepoUrl(entry.repository);
    if (!repository) {
      throw new Error(`Entry "${entry.id}" has invalid non-http(s) repository URL: "${entry.repository}".`);
    }

    const licenseText = readSafeRepoFile(rootDir, entry.licenseFile, `${entry.id}.licenseFile`);
    licenseTextByFile.set(entry.licenseFile.trim(), licenseText);
    const noticeText = entry.noticeFile ? readSafeRepoFile(rootDir, entry.noticeFile, `${entry.id}.noticeFile`) : undefined;

    return {
      id: entry.id.trim(),
      name: entry.name.trim(),
      category: entry.category,
      repository,
      version: entry.version.trim(),
      license: entry.license.trim(),
      usage: entry.usage.trim(),
      location: entry.location.trim(),
      licenseText,
      ...(noticeText ? { noticeText } : {}),
    };
  });

  validateSharedLicenseTemplates(manifest.entries, licenseTextByFile);

  const npmDeps = collectNpmDependencies(rootDir, manifest.entries, manifest.npmLicenseOverrides);
  const entries = [...curated, ...npmDeps];
  return { version: 1, entries, curatedCount: curated.length, npmCount: npmDeps.length };
}

export function serializeAcknowledgementsPayload(built) {
  const licenseTexts = [];
  const indexByText = new Map();
  const entries = built.entries.map(({ licenseText, ...rest }) => {
    let idx = indexByText.get(licenseText);
    if (idx === undefined) {
      idx = licenseTexts.length;
      indexByText.set(licenseText, idx);
      licenseTexts.push(licenseText);
    }
    return { ...rest, licenseTextIndex: idx };
  });
  return `${JSON.stringify({ version: built.version, licenseTexts, entries })}\n`;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderLicensingTable(curatedEntries, eol = "\n") {
  const rows = [
    "| Component | Version / commit | License | Location & usage |",
    "| --- | --- | --- | --- |",
    ...curatedEntries.map((entry) => {
      const link = entry.repository ? `[${escapeCell(entry.name)}](${entry.repository})` : escapeCell(entry.name);
      return `| ${link} | \`${escapeCell(entry.version)}\` | ${escapeCell(entry.license)} | \`${escapeCell(entry.location)}\` — ${escapeCell(entry.usage)} |`;
    }),
    "| Bundled npm runtime dependencies | Pinned in `package-lock.json` & `client/package-lock.json` | Various (MIT, Apache-2.0, ISC, BSD, etc.) | Generated into `client/src/generated/acknowledgements.json` and viewable in Settings → About → Acknowledgements |",
  ];
  return `${TABLE_START}${eol}${rows.join(eol)}${eol}${TABLE_END}`;
}

export function updateLicensingMarkdown(currentText, curatedEntries) {
  const start = currentText.indexOf(TABLE_START);
  const end = currentText.indexOf(TABLE_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`LICENSING.md must contain ${TABLE_START} and ${TABLE_END} markers.`);
  }
  const eol = currentText.includes("\r\n") ? "\r\n" : "\n";
  const table = renderLicensingTable(curatedEntries, eol);
  return `${currentText.slice(0, start)}${table}${currentText.slice(end + TABLE_END.length)}`;
}

export function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command !== "generate" && command !== "check") {
    console.error("Usage: node scripts/acknowledgements.mjs <generate|check> [--json-only] [--root <dir>]");
    return 2;
  }
  const rootIdx = argv.indexOf("--root");
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rootDir = rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : defaultRoot;

  const built = buildAcknowledgements(rootDir);
  const curatedEntries = built.entries.slice(0, built.curatedCount);
  const outJsonPath = path.join(rootDir, "client", "src", "generated", "acknowledgements.json");
  const licensingPath = path.join(rootDir, "LICENSING.md");

  const payload = serializeAcknowledgementsPayload(built);
  const currentLicensing = readFileSync(licensingPath, "utf8");
  const nextLicensing = updateLicensingMarkdown(currentLicensing, curatedEntries);

  if (command === "generate") {
    const jsonOnly = argv.includes("--json-only");
    mkdirSync(path.dirname(outJsonPath), { recursive: true });
    writeFileSync(outJsonPath, payload, "utf8");
    if (!jsonOnly) {
      writeFileSync(licensingPath, nextLicensing, "utf8");
    }
    console.log(`Generated acknowledgements (${built.curatedCount} curated + ${built.npmCount} npm = ${built.entries.length} entries).`);
    return 0;
  }

  // check mode: verify all manifest license texts, npm package license texts, and LICENSING.md sync.
  if (currentLicensing !== nextLicensing) {
    throw new Error(`LICENSING.md acknowledgements table is out of date. Run "npm run acknowledgements:generate".`);
  }
  console.log(`Acknowledgements verified (${built.entries.length} entries, all license texts present).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
