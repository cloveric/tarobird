import { isPluginSandboxSupported } from "./plugin-sandbox-runtime.js";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Code2,
  Cpu,
  Download,
  FolderOpen,
  Globe,
  HardDrive,
  LayoutGrid,
  NotebookPen,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  formatPluginSize,
  type PluginCapability,
  type PluginContribution,
  type PluginIcon,
  type PluginManifest,
  type PluginPlatform,
} from "../../src/client-protocol/plugins.js";
import {
  pluginRegistry as defaultPluginRegistry,
  type InstalledPluginRecord,
  type PluginCatalogEntry,
  type PluginRegistry,
  type PluginStoreState,
  type PreparedLocalDevPlugin,
} from "./plugin-registry.js";
import { sanitizePluginDomain } from "./plugin-sandbox-runtime.js";
import type { HubConnection } from "./connection.js";
import {
  matchesPluginMarketplaceQuery,
  pluginMarketplaceCategory,
  pluginPublisherLabel,
  selectLocalEntryFile,
  selectLocalManifestFile,
  type MarketplaceCategory,
  type MarketplaceTab,
} from "./plugin-marketplace.js";
import { useBackAction } from "./back-navigation.js";
import { formatList, t, useLocale } from "./i18n.js";
import "./plugins.css";

export {
  matchesPluginMarketplaceQuery,
  pluginMarketplaceCategory,
  pluginPublisherLabel,
  type MarketplaceCategory,
  type MarketplaceTab,
} from "./plugin-marketplace.js";

/** The plugin's own monochrome glyph; shared with the conversation header's plugin entry. */
export function PluginGlyph({ icon, size = 18 }: { icon: PluginIcon; size?: number }) {
  switch (icon) {
    case "canvas": return <LayoutGrid size={size} aria-hidden="true"/>;
    case "notes": return <NotebookPen size={size} aria-hidden="true"/>;
    case "clock": return <Clock size={size} aria-hidden="true"/>;
    case "sparkles": return <Sparkles size={size} aria-hidden="true"/>;
    case "code": return <Code2 size={size} aria-hidden="true"/>;
    default: return <Puzzle size={size} aria-hidden="true"/>;
  }
}

function PluginArtBadge({ icon, size = "md" }: { icon: PluginIcon; size?: "sm" | "md" | "lg" }) {
  const glyphSize = size === "lg" ? 26 : size === "sm" ? 18 : 20;
  return (
    <span className={`plugin-art-badge is-${size}`} data-icon-tone={icon} aria-hidden="true">
      <PluginGlyph icon={icon} size={glyphSize}/>
    </span>
  );
}

function FeaturedArtBanner({ icon }: { icon: PluginIcon }) {
  return (
    <div className="plugin-featured-art" data-icon-tone={icon} aria-hidden="true">
      {icon === "canvas" ? (
        <div className="plugin-art-canvas-scene">
          <div className="plugin-art-canvas-card is-primary">
            <span className="plugin-art-line is-accent"/>
            <span className="plugin-art-line is-wide"/>
            <span className="plugin-art-line is-short"/>
          </div>
          <div className="plugin-art-canvas-card is-secondary">
            <span className="plugin-art-line is-mid"/>
            <span className="plugin-art-line is-short"/>
          </div>
        </div>
      ) : icon === "notes" ? (
        <div className="plugin-art-notes-scene">
          <div className="plugin-art-note-sheet">
            <span className="plugin-art-line is-accent"/>
            <span className="plugin-art-line is-wide"/>
            <span className="plugin-art-line is-mid"/>
          </div>
        </div>
      ) : (
        <div className="plugin-art-glyph-scene">
          <PluginArtBadge icon={icon} size="lg"/>
        </div>
      )}
    </div>
  );
}

function capabilityLabel(cap: PluginCapability): string {
  switch (cap) {
    case "theme.read": return t("读取界面主题");
    case "credentials.device": return t("在系统钥匙串中读写画布 API Key");
    case "files.export": return t("导出文件到设备");
    case "network.domains": return t("访问清单中已确认的域名");
    case "storage.device": return t("本机插件隔离存储");
    case "clipboard.write": return t("写入剪贴板");
    case "workbench.canvas": return t("工作台画布扩展");
    case "chat.draft": return t("向输入框插入草稿");
    case "canvas.agent": return t("画布 Agent 与当前对话 Bot 桥接");
  }
}

function categoryLabel(category: MarketplaceCategory): string {
  switch (category) {
    case "all": return t("全部");
    case "workbench": return t("工作台与画布");
    case "productivity": return t("效率工具");
    case "community": return t("第三方社区");
  }
}

function contributionLabel(kind: PluginContribution["kind"]): string {
  return kind === "workbench-item" ? t("工作台项目") : t("侧边面板");
}

function displayTitle(manifest: PluginManifest, locale: string): string {
  return locale === "zh" ? manifest.nameZh ?? manifest.name : manifest.name;
}

function displayDescription(manifest: PluginManifest, locale: string): string {
  if (locale === "ja" && manifest.official && manifest.descriptionZh) {
    const translated = t(manifest.descriptionZh);
    if (translated !== manifest.descriptionZh) return translated;
  }
  return locale === "zh" ? manifest.descriptionZh ?? manifest.description : manifest.description;
}

function contributionTitle(contribution: PluginContribution, locale: string): string {
  return locale === "zh" ? contribution.titleZh ?? contribution.title : contribution.title;
}

function platformsSummary(platforms: readonly PluginPlatform[]): string {
  if (platforms.includes("desktop") && platforms.includes("phone")) return t("桌面端与手机端");
  if (platforms.includes("desktop")) return t("仅桌面端");
  return t("仅手机端");
}

type MarketplaceEntry = {
  manifest: PluginManifest;
  catalogEntry?: PluginCatalogEntry;
  installed?: InstalledPluginRecord;
};

type PendingInstallReview =
  | {
      kind: "catalog";
      entry: PluginCatalogEntry;
      sanitizedDomains: string[];
      blockedDomains: string[];
    }
  | {
      kind: "local-dev";
      prepared: PreparedLocalDevPlugin;
    };

const EMPTY_PLUGIN_STORE: PluginStoreState = { allowThirdParty: false, developerMode: false, installed: {} };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_PLUGIN_STORE;

function splitDeclaredDomains(domains: readonly string[]): {
  sanitizedDomains: string[];
  blockedDomains: string[];
} {
  const sanitized = new Set<string>();
  const blocked = new Set<string>();
  for (const raw of domains) {
    const clean = sanitizePluginDomain(raw);
    if (clean) sanitized.add(clean);
    else if (raw.trim()) blocked.add(raw.trim());
  }
  return { sanitizedDomains: [...sanitized], blockedDomains: [...blocked] };
}

export function PluginsView({
  platform,
  registry,
  connection,
  initialInstallId,
  onOpenContribution,
  backActionRef,
}: {
  platform: PluginPlatform;
  registry?: PluginRegistry | null;
  connection?: HubConnection;
  initialInstallId?: string;
  onOpenContribution?: (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => void;
  backActionRef?: RefObject<(() => boolean) | null>;
}) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const activeRegistry = registry === undefined ? defaultPluginRegistry : registry;
  const locale = useLocale();
  const sandboxSupported = isPluginSandboxSupported();
  const state = useSyncExternalStore(
    activeRegistry ? activeRegistry.subscribe : noopSubscribe,
    activeRegistry ? activeRegistry.getSnapshot : emptySnapshot,
  );
  const [tab, setTab] = useState<MarketplaceTab>("discover");
  const [category, setCategory] = useState<MarketplaceCategory>("all");
  const [query, setQuery] = useState("");
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [reviewTarget, setReviewTarget] = useState<PendingInstallReview>();
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPluginRecord>();
  const [consentError, setConsentError] = useState<string>();
  const [confirmThirdParty, setConfirmThirdParty] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const searchId = useId();

  useEffect(() => {
    if (!backActionRef) return;
    backActionRef.current = () => {
      if (uninstallTarget) {
        setUninstallTarget(undefined);
        return true;
      }
      if (reviewTarget) {
        setReviewTarget(undefined);
        setConsentError(undefined);
        return true;
      }
      if (selectedPluginId) {
        setSelectedPluginId(undefined);
        return true;
      }
      return false;
    };
    return () => {
      if (backActionRef.current) backActionRef.current = null;
    };
  }, [backActionRef, uninstallTarget, reviewTarget, selectedPluginId]);

  const catalog = useMemo(() => (activeRegistry ?? defaultPluginRegistry).catalogForPlatform(platform), [activeRegistry, platform]);
  const installedList = useMemo(() => (activeRegistry ? activeRegistry.installedForPlatform(platform) : []), [activeRegistry, state.installed, platform]);
  const localDevInstalled = useMemo(
    () => installedList.filter((item) => item.sourceKind === "local-dev"),
    [installedList],
  );

  useEffect(() => {
    if (!initialInstallId || !sandboxSupported) return;
    const match = catalog.find((item) => item.manifest.id === initialInstallId);
    if (match && !state.installed[match.manifest.id]) {
      setReviewTarget({ kind: "catalog", entry: match, ...splitDeclaredDomains(match.manifest.domains) });
    }
  }, [initialInstallId, catalog, state.installed, sandboxSupported]);

  const allEntries = useMemo<MarketplaceEntry[]>(() => {
    const map = new Map<string, MarketplaceEntry>();
    for (const entry of catalog) {
      const installed = state.installed[entry.manifest.id];
      map.set(entry.manifest.id, {
        manifest: installed ? installed.manifest : entry.manifest,
        catalogEntry: entry,
        installed,
      });
    }
    for (const record of installedList) {
      if (!map.has(record.manifest.id)) {
        map.set(record.manifest.id, {
          manifest: record.manifest,
          installed: record,
        });
      }
    }
    return [...map.values()];
  }, [catalog, installedList, state.installed]);

  const availableCategories = useMemo<MarketplaceCategory[]>(() => {
    const cats = new Set(allEntries.map((item) => pluginMarketplaceCategory(item.manifest)));
    const ordered: MarketplaceCategory[] = ["all"];
    for (const candidate of ["workbench", "productivity"] as const) {
      if (cats.has(candidate)) ordered.push(candidate);
    }
    ordered.push("community");
    return ordered;
  }, [allEntries]);

  const activeCategory = availableCategories.includes(category) ? category : "all";
  const needle = query.trim();

  const matchesFilters = (entry: MarketplaceEntry) => {
    if (activeCategory !== "all" && pluginMarketplaceCategory(entry.manifest) !== activeCategory) return false;
    return matchesPluginMarketplaceQuery(entry.manifest, needle);
  };

  const discoverEntries = useMemo(() => allEntries.filter(matchesFilters), [allEntries, activeCategory, needle]);
  const featuredEntries = useMemo(
    () => (tab === "discover" && !needle && activeCategory === "all"
      ? discoverEntries.filter((entry) => entry.manifest.official)
      : []),
    [tab, needle, activeCategory, discoverEntries],
  );
  const installedEntries = useMemo(
    () => installedList
      .map((record) => ({
        manifest: record.manifest,
        catalogEntry: catalog.find((item) => item.manifest.id === record.manifest.id),
        installed: record,
      }))
      .filter(matchesFilters),
    [installedList, catalog, activeCategory, needle],
  );
  const filteredLocalDev = useMemo(
    () => localDevInstalled.filter((item) => matchesPluginMarketplaceQuery(item.manifest, needle)),
    [localDevInstalled, needle],
  );

  const selectedEntry = selectedPluginId
    ? allEntries.find((entry) => entry.manifest.id === selectedPluginId)
    : undefined;

  const openReview = (entry: PluginCatalogEntry) => {
    if (!sandboxSupported || !entry.manifest.official) return;
    setConsentError(undefined);
    const { sanitizedDomains, blockedDomains } = splitDeclaredDomains(entry.manifest.domains);
    setReviewTarget({ kind: "catalog", entry, sanitizedDomains, blockedDomains });
  };

  const closeReview = () => {
    setConsentError(undefined);
    setReviewTarget(undefined);
  };

  const performInstall = async (target: PendingInstallReview) => {
    if (!activeRegistry) {
      const msg = t("正在同步当前账号信息，请稍后再安装插件。");
      setConsentError(msg);
      setFeedback({ text: msg, error: true });
      return;
    }
    const manifest = target.kind === "catalog" ? target.entry.manifest : target.prepared.manifest;
    setBusyId(manifest.id);
    setConsentError(undefined);
    setFeedback(undefined);
    try {
      if (target.kind === "catalog") {
        await activeRegistry.install(target.entry, {
          grantedCapabilities: manifest.capabilities,
          grantedDomains: target.sanitizedDomains,
          loadCanvasBundle: connection ? () => connection.fetchInfiniteCanvasArtifact() : undefined,
        });
        setReviewTarget(undefined);
        setConsentError(undefined);
        setFeedback({ text: t("已安装插件「{0}」", displayTitle(manifest, locale)) });
      } else {
        const installed = await activeRegistry.installPreparedLocalDev(target.prepared, {
          grantedCapabilities: target.prepared.manifest.capabilities,
          grantedDomains: target.prepared.sanitizedDomains,
        });
        setReviewTarget(undefined);
        setConsentError(undefined);
        setFeedback({ text: t("已从本地目录加载开发插件「{0}」", displayTitle(installed.manifest, locale)) });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "install_failed";
      const message = code === "canvas_agent_unavailable"
        ? t("请更新主机以安装无限画布扩展。")
        : code === "plugin_size_mismatch"
        ? t("校验失败：插件构建产物的体积与声明不符，已阻止安装。")
        : code === "plugin_hash_mismatch"
          ? t("校验失败：插件构建产物的 SHA-256 哈希不匹配，已阻止安装。")
          : code === "plugin_catalog_mismatch"
            ? t("插件与内置目录不一致，已阻止安装。")
            : code === "plugin_third_party_disabled"
              ? t("请先开启「允许第三方插件」后再安装。")
              : code === "plugin_developer_mode_disabled"
                ? t("请先开启开发者模式后再加载本地插件。")
                : code === "plugin_official_id_reserved"
                  ? t("本地开发插件不能使用官方保留的插件 ID。")
                  : t("插件安装失败：{0}", code);
      setConsentError(message);
      setFeedback({ text: message, error: true });
    } finally {
      setBusyId(undefined);
    }
  };

  const performUninstall = async (record: InstalledPluginRecord, keepData: boolean) => {
    if (!activeRegistry) return;
    const title = displayTitle(record.manifest, locale);
    await activeRegistry.uninstall(record.manifest.id, { keepData });
    setUninstallTarget(undefined);
    setFeedback({
      text: keepData
        ? t("已卸载插件「{0}」，本地扩展数据已保留。", title)
        : t("已卸载插件「{0}」，并清除其本地扩展数据。", title),
    });
  };

  const handleLocalFolderFiles = async (files: FileList | null) => {
    if (!files || !files.length || !activeRegistry) return;
    setFeedback(undefined);
    setConsentError(undefined);
    const list = [...files];
    const manifestFile = selectLocalManifestFile(list);
    if (!manifestFile) {
      setFeedback({ text: t("未在所选目录中找到 manifest.json。"), error: true });
      return;
    }
    try {
      const manifestText = await manifestFile.text();
      const parsed = JSON.parse(manifestText) as { entry?: string };
      const { entryPath, file: entryFile } = selectLocalEntryFile(list, manifestFile, parsed.entry);
      if (!entryFile) {
        setFeedback({ text: t("未在所选目录中找到入口文件：{0}", entryPath), error: true });
        return;
      }
      const html = await entryFile.text();
      const prepared = await activeRegistry.prepareLocalDev(manifestText, html);
      setReviewTarget({ kind: "local-dev", prepared });
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_local_plugin";
      const message = code === "plugin_hash_mismatch"
        ? t("校验失败：本地插件哈希与 manifest 不一致。")
        : code === "plugin_official_id_reserved"
          ? t("本地开发插件不能使用官方保留的插件 ID。")
          : code === "plugin_developer_mode_disabled"
            ? t("请先开启开发者模式后再加载本地插件。")
            : t("无法加载本地插件：{0}", code);
      setFeedback({ text: message, error: true });
    }
  };

  const openContribution = (manifest: PluginManifest, contribution: PluginContribution) => {
    if (!sandboxSupported || !manifest.official) {
      setFeedback({ text: !sandboxSupported ? t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。") : t("此版本暂不运行未经审核的 HTML 插件。"), error: true });
      return;
    }
    onOpenContribution?.(
      manifest.id,
      contribution.id,
      contribution.kind,
      contributionTitle(contribution, locale),
    );
  };

  const renderPrimaryAction = (entry: MarketplaceEntry, compact = true) => {
    const { manifest, catalogEntry, installed } = entry;
    const isBusy = busyId === manifest.id;
    const thirdPartyBlocked = !manifest.official && installed?.sourceKind !== "local-dev" && !state.allowThirdParty;
    const primaryContribution = manifest.contributions[0];
    const updateEntry = installed && activeRegistry ? activeRegistry.hasUpdate(manifest.id) : undefined;

    if (!installed && catalogEntry) {
      return (
        <button
          type="button"
          className="primary"
          disabled={isBusy || thirdPartyBlocked || !sandboxSupported || !manifest.official}
          onClick={() => openReview(catalogEntry)}
        >
          <Download size={14}/>
          {!catalogEntry.bundleHtml ? t("下载并安装") : t("安装")}
        </button>
      );
    }

    if (!installed) return null;

    if (compact) {
      if (installed.enabled && primaryContribution && onOpenContribution) {
        return (
          <button
            type="button"
            className="primary"
            onClick={() => openContribution(manifest, primaryContribution)}
          >
            {t("打开")}
          </button>
        );
      }
      return (
        <button
          type="button"
          className={installed.enabled ? "secondary" : "primary"}
          onClick={() => activeRegistry?.setEnabled(manifest.id, !installed.enabled)}
        >
          {installed.enabled ? t("停用") : t("启用")}
        </button>
      );
    }

    return (
      <>
        {installed.enabled && primaryContribution && onOpenContribution && (
          <button
            type="button"
            className="primary"
            onClick={() => openContribution(manifest, primaryContribution)}
          >
            {t("打开")}
          </button>
        )}
        <button
          type="button"
          className={installed.enabled ? "secondary" : "primary"}
          onClick={() => activeRegistry?.setEnabled(manifest.id, !installed.enabled)}
        >
          {installed.enabled ? t("停用") : t("启用")}
        </button>
        {updateEntry && (
          <button
            type="button"
            className="secondary"
            disabled={isBusy}
            onClick={() => openReview(updateEntry)}
          >
            <RefreshCw size={14}/>{t("更新到 v{0}", updateEntry.manifest.version)}
          </button>
        )}
        <button
          type="button"
          className="text-danger"
          onClick={() => setUninstallTarget(installed)}
        >
          <Trash2 size={14}/>{t("卸载")}
        </button>
      </>
    );
  };

  const renderCard = (entry: MarketplaceEntry, variant: "featured" | "grid" = "grid") => {
    const { manifest, installed, catalogEntry } = entry;
    const isOfficial = installed ? installed.sourceKind === "official" : manifest.official;
    const title = displayTitle(manifest, locale);
    const description = displayDescription(manifest, locale);
    const publisher = pluginPublisherLabel(manifest, installed?.sourceKind);
    const cat = pluginMarketplaceCategory(manifest);
    const updateEntry = installed && activeRegistry ? activeRegistry.hasUpdate(manifest.id) : undefined;

    if (variant === "featured") {
      return (
        <article
          key={`featured:${manifest.id}`}
          className="plugin-featured-card"
          data-plugin-id={manifest.id}
          data-installed={installed ? "true" : undefined}
        >
          <div className="plugin-featured-art-wrap">
            <FeaturedArtBanner icon={manifest.icon}/>
            {installed && (
              <span className="plugin-featured-installed-pill">
                <CheckCircle2 size={12}/>
                {installed.enabled ? t("已安装") : t("已停用")}
              </span>
            )}
          </div>
          <div className="plugin-featured-body">
            <div className="plugin-featured-head">
              <PluginArtBadge icon={manifest.icon} size="md"/>
              <div className="plugin-card-title">
                <div className="plugin-card-title-row">
                  <h4>
                    <button
                      type="button"
                      className="plugin-card-open-link"
                      aria-label={t("查看插件详情：{0}", title)}
                      onClick={() => setSelectedPluginId(manifest.id)}
                    >
                      {title}
                    </button>
                  </h4>
                  {isOfficial && (
                    <BadgeCheck className="plugin-verified-mark" size={15} aria-label={t("官方插件")}/>
                  )}
                </div>
                <p className="plugin-card-byline">{publisher} · v{manifest.version}</p>
              </div>
              <div className="plugin-card-action-slot">
                {renderPrimaryAction(entry, true)}
              </div>
            </div>
            <p className="plugin-card-desc">{description}</p>
            {manifest.attribution && (
              <p className="plugin-card-attribution">
                {t("原作者：{0} · {1}", manifest.attribution.author, manifest.attribution.license)}
              </p>
            )}
          </div>
        </article>
      );
    }

    return (
      <article
        key={manifest.id}
        className="plugin-card"
        data-plugin-id={manifest.id}
        data-installed={installed ? "true" : undefined}
      >
        <div className="plugin-card-head">
          <PluginArtBadge icon={manifest.icon} size="sm"/>
          <div className="plugin-card-title">
            <div className="plugin-card-title-row">
              <h4>
                <button
                  type="button"
                  className="plugin-card-open-link"
                  aria-label={t("查看插件详情：{0}", title)}
                  onClick={() => setSelectedPluginId(manifest.id)}
                >
                  {title}
                </button>
              </h4>
              {isOfficial ? (
                <BadgeCheck className="plugin-verified-mark" size={14} aria-label={t("官方插件")}/>
              ) : installed?.sourceKind === "local-dev" ? (
                <span className="plugin-badge is-dev">{t("本地开发")}</span>
              ) : (
                <span className="plugin-badge is-third">{t("第三方")}</span>
              )}
            </div>
            <p className="plugin-card-byline">{publisher} · v{manifest.version}</p>
          </div>
        </div>

        <p className="plugin-card-desc">{description}</p>
        {manifest.attribution && (
          <p className="plugin-card-attribution">
            {t("原作者：{0} · {1}", manifest.attribution.author, manifest.attribution.license)}
          </p>
        )}

        <div className="plugin-card-footer">
          <div className="plugin-card-tags">
            <span className="plugin-category-tag">{categoryLabel(cat)}</span>
            {catalogEntry && !catalogEntry.bundleHtml && !installed && (
              <span className="plugin-badge">{t("按需下载")}</span>
            )}
            {installed && (
              <span className={`plugin-badge ${installed.enabled ? "is-enabled" : "is-disabled"}`}>
                {installed.enabled ? t("已启用") : t("已停用")}
              </span>
            )}
            {updateEntry && (
              <span className="plugin-badge is-official">
                {t("可更新 v{0}", updateEntry.manifest.version)}
              </span>
            )}
          </div>
          <div className="plugin-card-action-slot">
            {renderPrimaryAction(entry, true)}
          </div>
        </div>
      </article>
    );
  };

  const renderThirdPartyConfirmCard = () => (
    <div className="plugins-warning-card" role="alert">
      <div className="plugins-warning-body">
        <AlertTriangle size={18}/>
        <div>
          <strong>{t("开启第三方插件前的安全提示")}</strong>
          <p>{t("第三方插件不由 TaroBird 签名审核。它们运行在独立 opaque-origin iframe 沙箱中，无法读取 App 令牌或调用主机 API，但仍可能访问已批准的外部域名，且浏览器框架隔离不等同于系统级防火墙。请只安装你信任来源的插件。")}</p>
        </div>
      </div>
      <div className="plugin-consent-actions">
        <button type="button" className="secondary" onClick={() => setConfirmThirdParty(false)}>{t("保持关闭")}</button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            activeRegistry?.setAllowThirdParty(true);
            setConfirmThirdParty(false);
          }}
        >
          {t("已知晓，开启第三方插件")}
        </button>
      </div>
    </div>
  );

  const renderThirdPartyOffBanner = () => (
    <div className="plugins-off-banner">
      <div className="plugins-off-banner-copy">
        <Puzzle size={17} aria-hidden="true"/>
        <div>
          <strong>{t("第三方插件默认关闭")}</strong>
          <p>{t("社区扩展不由 TaroBird 签名审核。开启后可安装受信任的第三方目录插件。")}</p>
        </div>
      </div>
      <button type="button" className="secondary" onClick={() => setConfirmThirdParty(true)}>
        {t("开启第三方插件…")}
      </button>
    </div>
  );

  const reviewManifest = reviewTarget
    ? (reviewTarget.kind === "catalog" ? reviewTarget.entry.manifest : reviewTarget.prepared.manifest)
    : undefined;
  const reviewSanitizedDomains = reviewTarget
    ? (reviewTarget.kind === "catalog" ? reviewTarget.sanitizedDomains : reviewTarget.prepared.sanitizedDomains)
    : [];
  const reviewBlockedDomains = reviewTarget
    ? (reviewTarget.kind === "catalog" ? reviewTarget.blockedDomains : reviewTarget.prepared.blockedDomains)
    : [];

  const consentOverlay = reviewTarget && reviewManifest && (
    <div className="plugin-consent-backdrop" role="presentation">
      <section className="plugin-consent-box" role="alertdialog" aria-label={t("安装前权限确认")}>
        <header>
          <strong>
            {t("确认安装「{0}」v{1}", displayTitle(reviewManifest, locale), reviewManifest.version)}
            {reviewTarget.kind === "local-dev" && (
              <>{" "}<span className="plugin-badge is-dev">{t("本地开发")}</span></>
            )}
          </strong>
          <button type="button" className="icon-button" aria-label={t("取消")} onClick={closeReview}><X size={16}/></button>
        </header>
        <p className="muted">
          {reviewTarget.kind === "local-dev"
            ? t("安装前会校验本地入口文件的 SHA-256（{0}…）。本地开发插件不由 TaroBird 签名，运行在独立 opaque-origin iframe 沙箱中，无法读取 App 令牌或调用主机 API；启动脚本会禁用 WebRTC 构造器并用 CSP 限制常规网络请求（非系统级防火墙）。请仅加载你信任的本地目录。", reviewManifest.artifact.sha256.slice(0, 12))
            : t("安装前会校验构建产物的 大小和 SHA-256（{0}…）。插件运行在独立 opaque-origin iframe 沙箱中，无法读取 App 令牌或调用主机 API；启动脚本会禁用 WebRTC 构造器并用 CSP 限制常规网络请求（非系统级防火墙）。",
                reviewManifest.artifact.sha256.slice(0, 12),
              )}
        </p>
        <ul>
          <li><strong>{t("所需能力：")}</strong>{reviewManifest.capabilities.length ? formatList(reviewManifest.capabilities.map(capabilityLabel)) : t("无额外能力")}</li>
          <li><strong>{t("网络域名：")}</strong>{reviewSanitizedDomains.length ? reviewSanitizedDomains.join(", ") : t("无外部网络访问")}</li>
          {reviewBlockedDomains.length > 0 && (
            <li>
              <strong>{t("已拦截域名：")}</strong>
              <code>{reviewBlockedDomains.join(", ")}</code>
              {" "}({t("本地、内网或非法域名不会被授予")})
            </li>
          )}
          <li><strong>{t("源码位置：")}</strong><code>{reviewManifest.source.repository}@{reviewManifest.source.commit}</code></li>
        </ul>
        {consentError && (
          <div className="plugins-feedback is-error" role="alert">
            <AlertTriangle size={15}/>
            <span>{consentError}</span>
          </div>
        )}
        <div className="plugin-consent-actions">
          <button type="button" className="secondary" onClick={closeReview}>{t("取消")}</button>
          <button type="button" className="primary" disabled={busyId === reviewManifest.id} onClick={() => void performInstall(reviewTarget)}>
            <Download size={14}/>{t("确认并安装")}
          </button>
        </div>
      </section>
    </div>
  );

  const uninstallOverlay = uninstallTarget && (
    <div className="plugin-consent-backdrop" role="presentation">
      <section className="plugin-consent-box" role="alertdialog" aria-label={t("卸载确认")}>
        <header>
          <strong>{t("卸载「{0}」？", displayTitle(uninstallTarget.manifest, locale))}</strong>
          <button type="button" className="icon-button" aria-label={t("取消")} onClick={() => setUninstallTarget(undefined)}><X size={16}/></button>
        </header>
        <p className="muted">
          {t("请选择是否同时删除该扩展在当前设备保存的本地数据（画布内容、素材与本地隔离 API Key）。")}
        </p>
        <div className="plugin-consent-actions">
          <button type="button" className="secondary" onClick={() => setUninstallTarget(undefined)}>{t("取消")}</button>
          <button type="button" className="secondary" onClick={() => void performUninstall(uninstallTarget, true)}>{t("仅卸载，保留数据")}</button>
          <button type="button" className="text-danger" onClick={() => void performUninstall(uninstallTarget, false)}>{t("卸载并删除数据")}</button>
        </div>
      </section>
    </div>
  );

  if (selectedEntry) {
    const { manifest, installed } = selectedEntry;
    const isOfficial = installed ? installed.sourceKind === "official" : manifest.official;
    const title = displayTitle(manifest, locale);
    const description = displayDescription(manifest, locale);
    const publisher = pluginPublisherLabel(manifest, installed?.sourceKind);

    return (
      <div className="plugins-view" data-platform={platform}>
      {!sandboxSupported && <p className="plugins-off-banner" role="status">{t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。")}</p>}
        {feedback && (
          <div className={`plugins-feedback${feedback.error ? " is-error" : ""}`} role={feedback.error ? "alert" : "status"}>
            {feedback.error ? <AlertTriangle size={15}/> : <CheckCircle2 size={15}/>}
            <span>{feedback.text}</span>
          </div>
        )}

        <article className="plugin-detail-page" data-plugin-id={manifest.id} data-installed={installed ? "true" : undefined}>
          <div className="plugin-detail-topbar">
            <button type="button" className="plugin-detail-back" onClick={() => setSelectedPluginId(undefined)}>
              <ChevronLeft size={16} aria-hidden="true"/>
              {t("返回插件市场")}
            </button>
          </div>

          <header className="plugin-detail-hero">
            <PluginArtBadge icon={manifest.icon} size="lg"/>
            <div className="plugin-detail-hero-copy">
              <div className="plugin-detail-title-row">
                <h3>{title}</h3>
                {isOfficial ? (
                  <span className="plugin-badge is-official"><BadgeCheck size={13}/>{t("官方")}</span>
                ) : installed?.sourceKind === "local-dev" ? (
                  <span className="plugin-badge is-dev"><Code2 size={13}/>{t("本地开发")}</span>
                ) : (
                  <span className="plugin-badge is-third">{t("第三方")}</span>
                )}
                {installed && (
                  <span className={`plugin-badge ${installed.enabled ? "is-enabled" : "is-disabled"}`}>
                    {installed.enabled ? t("已启用") : t("已停用")}
                  </span>
                )}
              </div>
              <p className="plugin-detail-meta">
                {publisher} · v{manifest.version} · {formatPluginSize(manifest.artifact.sizeBytes)} · {platformsSummary(manifest.platforms)}
              </p>
              <p className="plugin-detail-desc">{description}</p>
            </div>
            <div className="plugin-detail-actions">
              {renderPrimaryAction(selectedEntry, false)}
            </div>
          </header>

          {!manifest.official && installed?.sourceKind !== "local-dev" && !state.allowThirdParty && (
            confirmThirdParty ? renderThirdPartyConfirmCard() : renderThirdPartyOffBanner()
          )}

          <div className="plugin-detail-layout">
            <div className="plugin-detail-main">
              <section className="plugin-detail-card" aria-label={t("插件概览")}>
                <h4>{t("插件概览")}</h4>
                <p className="plugin-detail-overview-text">{description}</p>
                <div className="plugin-detail-pill-row">
                  <span className="plugin-category-tag">{categoryLabel(pluginMarketplaceCategory(manifest))}</span>
                  <span className="plugin-category-tag">{platformsSummary(manifest.platforms)}</span>
                  <span className="plugin-category-tag">{t("独立 iframe 沙箱")}</span>
                </div>
              </section>

              <section className="plugin-detail-card" aria-label={t("扩展位置")}>
                <h4>{t("扩展位置")}</h4>
                <ul className="plugin-detail-rows">
                  {manifest.contributions.map((contribution) => {
                    const label = contributionTitle(contribution, locale);
                    return (
                      <li key={contribution.id} className="plugin-detail-row">
                        <span className="plugin-detail-row-icon"><PluginGlyph icon={contribution.icon ?? manifest.icon} size={16}/></span>
                        <div className="plugin-detail-row-text">
                          <strong>{label}</strong>
                          <small>{contributionLabel(contribution.kind)} · <code>{contribution.id}</code></small>
                        </div>
                        {installed?.enabled && onOpenContribution && (
                          <button type="button" className="secondary" onClick={() => openContribution(manifest, contribution)}>
                            {t("打开")}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="plugin-detail-card" aria-label={t("权限与网络访问")}>
                <h4>{t("权限与网络访问")}</h4>
                <ul className="plugin-detail-rows">
                  {manifest.capabilities.length > 0 ? manifest.capabilities.map((cap) => (
                    <li key={cap} className="plugin-detail-row">
                      <span className="plugin-detail-row-icon"><CheckCircle2 size={16}/></span>
                      <div className="plugin-detail-row-text">
                        <strong>{capabilityLabel(cap)}</strong>
                        <small><code>{cap}</code></small>
                      </div>
                    </li>
                  )) : (
                    <li className="plugin-detail-row">
                      <span className="plugin-detail-row-icon"><ShieldCheck size={16}/></span>
                      <div className="plugin-detail-row-text">
                        <strong>{t("仅基础隔离运行")}</strong>
                        <small>{t("不申请剪贴板、存储或工作台扩展能力。")}</small>
                      </div>
                    </li>
                  )}
                  <li className="plugin-detail-row">
                    <span className="plugin-detail-row-icon"><Globe size={16}/></span>
                    <div className="plugin-detail-row-text">
                      <strong>{(installed ? installed.grantedDomains : splitDeclaredDomains(manifest.domains).sanitizedDomains).length ? (installed ? installed.grantedDomains : splitDeclaredDomains(manifest.domains).sanitizedDomains).join(", ") : t("无外部网络访问")}</strong>
                      <small>{(installed ? installed.grantedDomains : splitDeclaredDomains(manifest.domains).sanitizedDomains).length ? t("通过 CSP 仅放行以上公网域名，并在启动脚本中禁用 WebRTC 构造器（非系统级防火墙）") : t("通过 CSP connect-src 'none' 限制常规网络请求，并在启动脚本中禁用 WebRTC 构造器（非系统级防火墙）")}</small>
                    </div>
                  </li>
                  {manifest.requiresHost && (
                    <li className="plugin-detail-row">
                      <span className="plugin-detail-row-icon"><Cpu size={16}/></span>
                      <div className="plugin-detail-row-text">
                        <strong>{t("需要主机支持")}</strong>
                      </div>
                    </li>
                  )}
                </ul>
              </section>
            </div>

            <aside className="plugin-detail-aside">
              <section className="plugin-detail-card" aria-label={t("校验与详情")}>
                <h4>{t("校验与详情")}</h4>
                <dl className="plugin-detail-facts">
                  <div>
                    <dt>{t("校验方式")}</dt>
                    <dd>{t("SHA-256 完整性校验")}</dd>
                  </div>
                  <div>
                    <dt>{t("来源")}</dt>
                    <dd><code>{manifest.source.repository}@{manifest.source.commit}</code></dd>
                  </div>
                  {manifest.attribution && (
                    <div>
                      <dt>{t("原作者与协议")}</dt>
                      <dd>{manifest.attribution.author} ({manifest.attribution.license})</dd>
                    </div>
                  )}
                  <div>
                    <dt>{t("体积")}</dt>
                    <dd>{formatPluginSize(manifest.artifact.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>{t("入口文件")}</dt>
                    <dd><code>{manifest.entry}</code></dd>
                  </div>
                  <div>
                    <dt>{t("插件 ID")}</dt>
                    <dd><code>{manifest.id}</code></dd>
                  </div>
                  <div className="is-stacked">
                    <dt>SHA-256</dt>
                    <dd><code className="plugin-digest-code">{manifest.artifact.sha256}</code></dd>
                  </div>
                </dl>
              </section>
            </aside>
          </div>
        </article>

        {consentOverlay}
        {uninstallOverlay}
      </div>
    );
  }

  return (
    <div className="plugins-view" data-platform={platform}>
      {!sandboxSupported && <p className="plugins-off-banner" role="status">{t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。")}</p>}
      <div className="plugins-marketplace-toolbar">
        <div className="plugins-tabs" role="tablist" aria-label={t("插件市场导航")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "discover"}
            className={tab === "discover" ? "is-active" : undefined}
            onClick={() => setTab("discover")}
          >
            {t("探索")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "installed"}
            className={tab === "installed" ? "is-active" : undefined}
            onClick={() => setTab("installed")}
          >
            {t("已安装")}
            <span className="plugins-tab-count">{installedList.length}</span>
          </button>
          {platform === "desktop" && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "developer"}
              className={tab === "developer" ? "is-active" : undefined}
              onClick={() => setTab("developer")}
            >
              {t("开发者")}
            </button>
          )}
        </div>

        <label className="plugins-search" htmlFor={searchId}>
          <Search size={15} aria-hidden="true"/>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("搜索插件名称、说明或出版方…")}
            aria-label={t("搜索插件")}
          />
          {query && (
            <button
              type="button"
              className="plugins-search-clear"
              aria-label={t("清除搜索")}
              onClick={() => setQuery("")}
            >
              <X size={13}/>
            </button>
          )}
        </label>
      </div>

      {tab !== "developer" && (
        <div className="plugins-filter-bar">
          <div className="plugins-category-pills" role="group" aria-label={t("插件分类")}>
            {availableCategories.map((item) => (
              <button
                key={item}
                type="button"
                className={`plugins-category-pill${activeCategory === item ? " is-active" : ""}`}
                aria-pressed={activeCategory === item}
                onClick={() => setCategory(item)}
              >
                {categoryLabel(item)}
              </button>
            ))}
          </div>
          <span className="plugins-storage-note">
            <HardDrive size={13} aria-hidden="true"/>
            {t("运行在独立隔离沙箱内")}
          </span>
        </div>
      )}

      {platform === "phone" && (
        <p className="plugins-phone-note" role="status">
          {t("手机端仅显示支持移动端的插件；仅限桌面端的插件（如无限画布）已自动隐藏。")}
        </p>
      )}

      {feedback && (
        <div className={`plugins-feedback${feedback.error ? " is-error" : ""}`} role={feedback.error ? "alert" : "status"}>
          {feedback.error ? <AlertTriangle size={15}/> : <CheckCircle2 size={15}/>}
          <span>{feedback.text}</span>
        </div>
      )}

      {tab === "discover" && (
        <>
          {featuredEntries.length > 0 && (
            <section className="plugins-section" aria-label={t("精选推荐")}>
              <header className="plugins-section-head">
                <div>
                  <h4>{t("精选推荐")}</h4>
                  <span className="muted">{t("内置目录校验 · 隔离沙箱运行")}</span>
                </div>
              </header>
              <div className="plugins-featured-grid">
                {featuredEntries.map((entry) => renderCard(entry, "featured"))}
              </div>
            </section>
          )}

          {(activeCategory === "community") && (
            <section className="plugins-section" aria-label={t("第三方安全策略")}>
              <header className="plugins-section-head">
                <div>
                  <h4>{t("第三方插件")}</h4>
                  <span className="muted">{t("社区维护的扩展，默认关闭")}</span>
                </div>
                <label className="plugins-switch-label">
                  <input
                    type="checkbox"
                    checked={state.allowThirdParty}
                    onChange={(e) => {
                      if (e.target.checked) setConfirmThirdParty(true);
                      else {
                        setConfirmThirdParty(false);
                        activeRegistry?.setAllowThirdParty(false);
                      }
                    }}
                  />
                  <span>{t("允许第三方插件")}</span>
                </label>
              </header>
              {confirmThirdParty && !state.allowThirdParty && renderThirdPartyConfirmCard()}
              {!state.allowThirdParty && !confirmThirdParty && renderThirdPartyOffBanner()}
            </section>
          )}

          <section className="plugins-section" aria-label={t("全部插件")}>
            <header className="plugins-section-head">
              <div>
                <h4>{activeCategory === "all" ? t("全部扩展") : categoryLabel(activeCategory)}</h4>
                <span className="muted">{t("点击插件卡片查看权限、扩展位置与校验摘要")}</span>
              </div>
              {activeCategory === "all" && (
                <label className="plugins-switch-label">
                  <input
                    type="checkbox"
                    checked={state.allowThirdParty}
                    onChange={(e) => {
                      if (e.target.checked) setConfirmThirdParty(true);
                      else {
                        setConfirmThirdParty(false);
                        activeRegistry?.setAllowThirdParty(false);
                      }
                    }}
                  />
                  <span>{t("允许第三方插件")}</span>
                </label>
              )}
            </header>
            {discoverEntries.length > 0 ? (
              <div className="plugins-grid">
                {discoverEntries.map((entry) => renderCard(entry, "grid"))}
              </div>
            ) : (
              <div className="plugins-empty-card">
                <p>
                  {activeCategory === "community" && !needle
                    ? t("当前目录暂无已上架的第三方插件。开启开关后可安装受信任的第三方目录插件，或在桌面端「开发者」标签中加载本地插件并审查权限。")
                    : t("没有找到匹配的插件。")}
                </p>
                {(needle || activeCategory !== "all") && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setQuery("");
                      setCategory("all");
                    }}
                  >
                    {t("清除筛选")}
                  </button>
                )}
              </div>
            )}
          </section>

          {activeCategory === "all" && (
            <section className="plugins-section" aria-label={t("第三方安全策略")}>
              {confirmThirdParty && !state.allowThirdParty && renderThirdPartyConfirmCard()}
              {!state.allowThirdParty && !confirmThirdParty && renderThirdPartyOffBanner()}
            </section>
          )}
        </>
      )}

      {tab === "installed" && (
        <section className="plugins-section" aria-label={t("已安装插件")}>
          {installedEntries.length > 0 ? (
            <div className="plugins-grid">
              {installedEntries.map((entry) => renderCard(entry, "grid"))}
            </div>
          ) : (
            <div className="plugins-empty-card">
              <p>{needle || activeCategory !== "all" ? t("没有匹配的已安装插件。") : t("还没有安装任何插件。")}</p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                  setTab("discover");
                }}
              >
                {t("浏览插件市场")}
              </button>
            </div>
          )}
        </section>
      )}

      {tab === "developer" && platform === "desktop" && (
        <section className="plugins-section" aria-label={t("开发者模式")}>
          <header className="plugins-section-head">
            <div>
              <h4>{t("开发者模式")}</h4>
              <span className="muted">{t("此版本暂不运行未经审核的 HTML 插件。")}</span>
            </div>
            <label className="plugins-switch-label">
              <input
                type="checkbox"
                checked={state.developerMode}
                onChange={(e) => activeRegistry?.setDeveloperMode(e.target.checked)}
              />
              <span>{t("启用开发者模式")}</span>
            </label>
          </header>
          {state.developerMode ? (
            <div className="plugins-dev-box">
              <input
                ref={folderInputRef}
                type="file"
                hidden
                disabled
                multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => {
                  void handleLocalFolderFiles(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
              <button type="button" className="secondary" disabled onClick={() => folderInputRef.current?.click()}>
                <FolderOpen size={15}/>{t("从本地文件夹加载插件")}
              </button>
              <small className="muted">{t("此版本暂不运行未经审核的 HTML 插件。")}</small>
            </div>
          ) : (
            <div className="plugins-off-banner">
              <div className="plugins-off-banner-copy">
                <Code2 size={17} aria-hidden="true"/>
                <div>
                  <strong>{t("本地 HTML 插件不可用")}</strong>
                  <p>{t("此版本暂不运行未经审核的 HTML 插件。")}</p>
                </div>
              </div>
            </div>
          )}

          {filteredLocalDev.length > 0 && (
            <div className="plugins-grid">
              {filteredLocalDev.map((record) => renderCard({ manifest: record.manifest, installed: record }, "grid"))}
            </div>
          )}
        </section>
      )}

      {consentOverlay}
      {uninstallOverlay}
    </div>
  );
}

export function PluginsModal({
  platform,
  registry,
  connection,
  initialInstallId,
  close,
  onOpenContribution,
}: {
  platform: PluginPlatform;
  registry?: PluginRegistry | null;
  connection?: HubConnection;
  initialInstallId?: string;
  close: () => void;
  onOpenContribution?: (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => void;
}) {
  useLocale();
  const modalTitle = t("插件市场");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closingRef = useRef(false);
  const viewBackRef = useRef<(() => boolean) | null>(null);

  const handleStepBack = () => {
    if (viewBackRef.current?.()) return;
    close();
  };

  useBackAction(dialogRef, handleStepBack, 120);

  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    closingRef.current = false;
    node?.showModal();
    return () => {
      closingRef.current = true;
      node?.close();
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="plugins-modal-dialog"
      aria-label={modalTitle}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        handleStepBack();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget || closingRef.current || event.currentTarget.open) return;
        event.currentTarget.showModal();
        handleStepBack();
      }}
    >
      <header className="plugins-modal-header">
        <div className="plugins-modal-title">
          <Puzzle size={19}/>
          <h2>{modalTitle}</h2>
        </div>
        <button type="button" className="icon-button" aria-label={t("关闭插件页")} onClick={close}><X size={18}/></button>
      </header>
      <div className="plugins-modal-body">
        <PluginsView
          platform={platform}
          registry={registry}
          connection={connection}
          initialInstallId={initialInstallId}
          backActionRef={viewBackRef}
          onOpenContribution={onOpenContribution ? (pluginId, contributionId, kind, title) => {
            close();
            onOpenContribution(pluginId, contributionId, kind, title);
          } : undefined}
        />
      </div>
    </dialog>
  );
}
