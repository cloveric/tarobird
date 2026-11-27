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
  pluginRegistry,
  type InstalledPluginRecord,
  type PluginCatalogEntry,
} from "./plugin-registry.js";
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

function PluginGlyph({ icon, size = 18 }: { icon: PluginIcon; size?: number }) {
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
    case "storage.device": return t("本机插件隔离存储");
    case "clipboard.write": return t("写入剪贴板");
    case "workbench.canvas": return t("工作台画布扩展");
    case "chat.draft": return t("向输入框插入草稿");
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

export function PluginsView({
  platform,
  onOpenContribution,
  backActionRef,
}: {
  platform: PluginPlatform;
  onOpenContribution?: (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => void;
  backActionRef?: RefObject<(() => boolean) | null>;
}) {
  const locale = useLocale();
  const state = useSyncExternalStore(pluginRegistry.subscribe, pluginRegistry.getSnapshot);
  const [tab, setTab] = useState<MarketplaceTab>("discover");
  const [category, setCategory] = useState<MarketplaceCategory>("all");
  const [query, setQuery] = useState("");
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [reviewEntry, setReviewEntry] = useState<PluginCatalogEntry>();
  const [consentError, setConsentError] = useState<string>();
  const [confirmThirdParty, setConfirmThirdParty] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  useEffect(() => {
    if (!backActionRef) return;
    backActionRef.current = () => {
      if (reviewEntry) {
        setReviewEntry(undefined);
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
  }, [backActionRef, reviewEntry, selectedPluginId]);

  const catalog = useMemo(() => pluginRegistry.catalogForPlatform(platform), [platform]);
  const installedList = useMemo(() => pluginRegistry.installedForPlatform(platform), [state.installed, platform]);
  const localDevInstalled = useMemo(
    () => installedList.filter((item) => item.sourceKind === "local-dev"),
    [installedList],
  );

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
    for (const candidate of ["workbench", "productivity", "community"] as const) {
      if (cats.has(candidate)) ordered.push(candidate);
    }
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
    setConsentError(undefined);
    setReviewEntry(entry);
  };

  const closeReview = () => {
    setConsentError(undefined);
    setReviewEntry(undefined);
  };

  const performInstall = async (entry: PluginCatalogEntry) => {
    setBusyId(entry.manifest.id);
    setConsentError(undefined);
    setFeedback(undefined);
    try {
      await pluginRegistry.install(entry);
      setReviewEntry(undefined);
      setConsentError(undefined);
      setFeedback({ text: t("已安装插件「{0}」", displayTitle(entry.manifest, locale)) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "install_failed";
      const message = code === "plugin_size_mismatch"
        ? t("校验失败：插件构建产物的体积与声明不符，已阻止安装。")
        : code === "plugin_hash_mismatch"
          ? t("校验失败：插件构建产物的 SHA-256 哈希不匹配，已阻止安装。")
          : code === "plugin_signature_invalid"
            ? t("校验失败：官方插件签名无效，已阻止安装。")
            : code === "plugin_third_party_disabled"
              ? t("请先开启「允许第三方插件」后再安装。")
              : t("插件安装失败：{0}", code);
      setConsentError(message);
      setFeedback({ text: message, error: true });
    } finally {
      setBusyId(undefined);
    }
  };

  const handleLocalFolderFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setFeedback(undefined);
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
      const installed = await pluginRegistry.installLocalDev(manifestText, html);
      setFeedback({ text: t("已从本地目录加载开发插件「{0}」", displayTitle(installed.manifest, locale)) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_local_plugin";
      const message = code === "plugin_hash_mismatch"
        ? t("校验失败：本地插件哈希与 manifest 不一致。")
        : code === "plugin_official_id_reserved"
          ? t("本地开发插件不能使用官方保留的插件 ID。")
          : t("无法加载本地插件：{0}", code);
      setFeedback({ text: message, error: true });
    }
  };

  const openContribution = (manifest: PluginManifest, contribution: PluginContribution) => {
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
    const updateEntry = installed ? pluginRegistry.hasUpdate(manifest.id) : undefined;

    if (!installed && catalogEntry) {
      return (
        <button
          type="button"
          className="primary"
          disabled={isBusy || thirdPartyBlocked}
          onClick={() => openReview(catalogEntry)}
        >
          <Download size={14}/>
          {t("安装")}
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
          onClick={() => pluginRegistry.setEnabled(manifest.id, !installed.enabled)}
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
          onClick={() => pluginRegistry.setEnabled(manifest.id, !installed.enabled)}
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
          onClick={() => {
            pluginRegistry.uninstall(manifest.id);
            setFeedback({ text: t("已卸载插件「{0}」", displayTitle(manifest, locale)) });
          }}
        >
          <Trash2 size={14}/>{t("卸载")}
        </button>
      </>
    );
  };

  const renderCard = (entry: MarketplaceEntry, variant: "featured" | "grid" = "grid") => {
    const { manifest, installed } = entry;
    const isOfficial = installed ? installed.sourceKind === "official" : manifest.official;
    const title = displayTitle(manifest, locale);
    const description = displayDescription(manifest, locale);
    const publisher = pluginPublisherLabel(manifest, installed?.sourceKind);
    const cat = pluginMarketplaceCategory(manifest);
    const updateEntry = installed ? pluginRegistry.hasUpdate(manifest.id) : undefined;

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

        <div className="plugin-card-footer">
          <div className="plugin-card-tags">
            <span className="plugin-category-tag">{categoryLabel(cat)}</span>
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
          <p>{t("第三方插件不由 TaroBird 签名审核。虽然它们运行在独立沙箱中、无法读取 App 令牌或调用主机 API，但仍可能访问其声明的外部域名。请只安装你信任来源的插件。")}</p>
        </div>
      </div>
      <div className="plugin-consent-actions">
        <button type="button" className="secondary" onClick={() => setConfirmThirdParty(false)}>{t("保持关闭")}</button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            pluginRegistry.setAllowThirdParty(true);
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
          <p>{t("社区扩展不由 TaroBird 签名审核。开启后可安装来自第三方社区仓库的插件。")}</p>
        </div>
      </div>
      <button type="button" className="secondary" onClick={() => setConfirmThirdParty(true)}>
        {t("开启第三方插件…")}
      </button>
    </div>
  );

  const consentOverlay = reviewEntry && (
    <div className="plugin-consent-backdrop" role="presentation">
      <section className="plugin-consent-box" aria-label={t("安装前权限确认")}>
        <header>
          <strong>{t("确认安装「{0}」v{1}", displayTitle(reviewEntry.manifest, locale), reviewEntry.manifest.version)}</strong>
          <button type="button" className="icon-button" aria-label={t("取消")} onClick={closeReview}><X size={16}/></button>
        </header>
        <p className="muted">
          {t("安装前会校验构建产物的 SHA-256（{0}…）{1}。插件运行在独立沙箱中，无法读取 App 令牌或调用主机 API。",
            reviewEntry.manifest.artifact.sha256.slice(0, 12),
            reviewEntry.manifest.official ? t("与官方签名") : "",
          )}
        </p>
        <ul>
          <li><strong>{t("所需能力：")}</strong>{reviewEntry.manifest.capabilities.length ? formatList(reviewEntry.manifest.capabilities.map(capabilityLabel)) : t("无额外能力")}</li>
          <li><strong>{t("网络域名：")}</strong>{reviewEntry.manifest.domains.length ? reviewEntry.manifest.domains.join(", ") : t("无外部网络访问")}</li>
          <li><strong>{t("源码位置：")}</strong><code>{reviewEntry.manifest.source.repository}@{reviewEntry.manifest.source.commit}</code></li>
        </ul>
        {consentError && (
          <div className="plugins-feedback is-error" role="alert">
            <AlertTriangle size={15}/>
            <span>{consentError}</span>
          </div>
        )}
        <div className="plugin-consent-actions">
          <button type="button" className="secondary" onClick={closeReview}>{t("取消")}</button>
          <button type="button" className="primary" disabled={busyId === reviewEntry.manifest.id} onClick={() => void performInstall(reviewEntry)}>
            <Download size={14}/>{t("确认并安装")}
          </button>
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
                      <strong>{manifest.domains.length ? manifest.domains.join(", ") : t("无外部网络访问")}</strong>
                      <small>{manifest.domains.length ? t("沙箱 CSP 仅放行以上声明域名") : t("已通过 CSP connect-src 'none' 禁止外部网络请求")}</small>
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
                    <dd>{isOfficial ? t("SHA-256 + Ed25519 官方签名") : t("SHA-256 完整性校验")}</dd>
                  </div>
                  <div>
                    <dt>{t("来源")}</dt>
                    <dd><code>{manifest.source.repository}@{manifest.source.commit}</code></dd>
                  </div>
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
                  {manifest.artifact.signature && (
                    <div className="is-stacked">
                      <dt>Ed25519</dt>
                      <dd><code className="plugin-digest-code">{manifest.artifact.signature}</code></dd>
                    </div>
                  )}
                </dl>
              </section>
            </aside>
          </div>
        </article>

        {consentOverlay}
      </div>
    );
  }

  return (
    <div className="plugins-view" data-platform={platform}>
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
                  <span className="muted">{t("官方签名校验 · 隔离沙箱运行")}</span>
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
                        pluginRegistry.setAllowThirdParty(false);
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
                        pluginRegistry.setAllowThirdParty(false);
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
                <p>{t("没有找到匹配的插件。")}</p>
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
              <span className="muted">{t("从本机文件夹加载未发布的插件进行调试")}</span>
            </div>
            <label className="plugins-switch-label">
              <input
                type="checkbox"
                checked={state.developerMode}
                onChange={(e) => pluginRegistry.setDeveloperMode(e.target.checked)}
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
                multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => {
                  void handleLocalFolderFiles(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
              <button type="button" className="secondary" onClick={() => folderInputRef.current?.click()}>
                <FolderOpen size={15}/>{t("从本地文件夹加载插件")}
              </button>
              <small className="muted">{t("目录中需包含符合规范的 manifest.json 与入口 HTML 文件。")}</small>
            </div>
          ) : (
            <div className="plugins-off-banner">
              <div className="plugins-off-banner-copy">
                <Code2 size={17} aria-hidden="true"/>
                <div>
                  <strong>{t("开启开发者模式后可加载本地插件")}</strong>
                  <p>{t("本地加载的插件同样运行在独立 opaque-origin iframe 沙箱中，并受 manifest 声明的能力约束。")}</p>
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
    </div>
  );
}

export function PluginsModal({
  platform,
  close,
  onOpenContribution,
}: {
  platform: PluginPlatform;
  close: () => void;
  onOpenContribution?: (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => void;
}) {
  const locale = useLocale();
  const modalTitle = locale === "en" ? "Plugin Marketplace" : "插件市场";
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
