import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Code2,
  Download,
  FolderOpen,
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
  type PluginIcon,
  type PluginManifest,
  type PluginPlatform,
} from "../../src/client-protocol/plugins.js";
import {
  pluginRegistry,
  type InstalledPluginRecord,
  type PluginCatalogEntry,
} from "./plugin-registry.js";
import { t, useLocale } from "./i18n.js";
import "./plugins.css";

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

function capabilityLabel(cap: PluginCapability): string {
  switch (cap) {
    case "theme.read": return t("读取界面主题");
    case "storage.device": return t("本机插件隔离存储");
    case "clipboard.write": return t("写入剪贴板");
    case "workbench.canvas": return t("工作台画布扩展");
    case "chat.draft": return t("向输入框插入草稿");
    case "canvas.agent": return t("画布 Agent 与当前对话 Bot 桥接");
  }
}

function contributionLabel(kind: "workbench-item" | "side-panel"): string {
  return kind === "workbench-item" ? t("工作台项目") : t("侧边面板");
}

function displayTitle(manifest: PluginManifest, locale: string): string {
  return locale === "zh" ? manifest.nameZh ?? manifest.name : manifest.name;
}

function displayDescription(manifest: PluginManifest, locale: string): string {
  return locale === "zh" ? manifest.descriptionZh ?? manifest.description : manifest.description;
}

export function PluginsView({
  platform,
  initialInstallId,
  onOpenContribution,
}: {
  platform: PluginPlatform;
  initialInstallId?: string;
  onOpenContribution?: (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => void;
}) {
  const locale = useLocale();
  const state = useSyncExternalStore(pluginRegistry.subscribe, pluginRegistry.getSnapshot);
  const [query, setQuery] = useState("");
  const [reviewEntry, setReviewEntry] = useState<PluginCatalogEntry>();
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPluginRecord>();
  const [confirmThirdParty, setConfirmThirdParty] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  const catalog = useMemo(() => pluginRegistry.catalogForPlatform(platform), [platform]);
  const localDevInstalled = useMemo(
    () => Object.values(state.installed).filter((item) => item.sourceKind === "local-dev" && item.manifest.platforms.includes(platform)),
    [state.installed, platform],
  );

  useEffect(() => {
    if (!initialInstallId) return;
    const match = catalog.find((item) => item.manifest.id === initialInstallId);
    if (match && !state.installed[match.manifest.id]) {
      setReviewEntry(match);
    }
  }, [initialInstallId, catalog, state.installed]);

  const needle = query.trim().toLowerCase();
  const matches = (manifest: PluginManifest) => {
    if (!needle) return true;
    return [manifest.id, manifest.name, manifest.nameZh ?? "", manifest.description, manifest.descriptionZh ?? "", manifest.source.repository]
      .some((value) => value.toLowerCase().includes(needle));
  };

  const officialEntries = useMemo(() => catalog.filter((e) => e.manifest.official && matches(e.manifest)), [catalog, needle]);
  const thirdPartyEntries = useMemo(() => catalog.filter((e) => !e.manifest.official && matches(e.manifest)), [catalog, needle]);
  const filteredLocalDev = useMemo(() => localDevInstalled.filter((item) => matches(item.manifest)), [localDevInstalled, needle]);

  const performInstall = async (entry: PluginCatalogEntry) => {
    setBusyId(entry.manifest.id);
    setFeedback(undefined);
    try {
      await pluginRegistry.install(entry);
      setReviewEntry(undefined);
      setFeedback({ text: t("已安装插件「{0}」", displayTitle(entry.manifest, locale)) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "install_failed";
      const message = code === "plugin_hash_mismatch"
        ? t("校验失败：插件构建产物的 SHA-256 哈希不匹配，已阻止安装。")
        : code === "plugin_signature_invalid"
          ? t("校验失败：官方插件签名无效，已阻止安装。")
          : code === "plugin_download_failed"
            ? t("下载插件失败，请检查网络连接或构建产物后重试。")
            : code === "plugin_third_party_disabled"
              ? t("请先开启「允许第三方插件」后再安装。")
              : t("插件安装失败：{0}", code);
      setFeedback({ text: message, error: true });
    } finally {
      setBusyId(undefined);
    }
  };

  const performUninstall = async (record: InstalledPluginRecord, keepData: boolean) => {
    const title = displayTitle(record.manifest, locale);
    await pluginRegistry.uninstall(record.manifest.id, { keepData });
    setUninstallTarget(undefined);
    setFeedback({
      text: keepData
        ? t("已卸载插件「{0}」，本地扩展数据已保留。", title)
        : t("已卸载插件「{0}」，并清除其本地扩展数据。", title),
    });
  };

  const handleLocalFolderFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setFeedback(undefined);
    const list = [...files];
    const manifestFile = list.find((file) => file.name === "manifest.json" || file.webkitRelativePath.endsWith("/manifest.json"));
    if (!manifestFile) {
      setFeedback({ text: t("未在所选目录中找到 manifest.json。"), error: true });
      return;
    }
    try {
      const manifestText = await manifestFile.text();
      const parsed = JSON.parse(manifestText) as { entry?: string };
      const entryPath = typeof parsed.entry === "string" ? parsed.entry.replace(/^\.\//, "") : "index.html";
      const entryFile = list.find((file) =>
        file.webkitRelativePath.endsWith(`/${entryPath}`) || file.name === entryPath || file.name === entryPath.split("/").pop(),
      );
      if (!entryFile) {
        setFeedback({ text: t("未在所选目录中找到入口文件：{0}", entryPath), error: true });
        return;
      }
      const html = await entryFile.text();
      const installed = await pluginRegistry.installLocalDev(manifestText, html);
      setFeedback({ text: t("已从本地目录加载开发插件「{0}」", displayTitle(installed.manifest, locale)) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_local_plugin";
      setFeedback({ text: code === "plugin_hash_mismatch" ? t("校验失败：本地插件哈希与 manifest 不一致。") : t("无法加载本地插件：{0}", code), error: true });
    }
  };

  const renderCard = (entry: PluginCatalogEntry | null, installed?: InstalledPluginRecord) => {
    const manifest = installed?.manifest ?? entry!.manifest;
    const title = displayTitle(manifest, locale);
    const description = displayDescription(manifest, locale);
    const updateEntry = installed ? pluginRegistry.hasUpdate(manifest.id) : undefined;
    const isBusy = busyId === manifest.id;
    const thirdPartyBlocked = !manifest.official && installed?.sourceKind !== "local-dev" && !state.allowThirdParty;
    const primaryContribution = manifest.contributions[0];

    return (
      <article key={manifest.id} className="plugin-card" data-plugin-id={manifest.id} data-installed={installed ? "true" : undefined}>
        <div className="plugin-card-head">
          <div className="plugin-card-icon"><PluginGlyph icon={manifest.icon} size={20}/></div>
          <div className="plugin-card-title">
            <div className="plugin-card-title-row">
              <strong>{title}</strong>
              <span className="plugin-version">v{manifest.version}</span>
              {manifest.official ? <span className="plugin-badge is-official"><ShieldCheck size={12}/>{t("官方")}</span>
                : installed?.sourceKind === "local-dev" ? <span className="plugin-badge is-dev"><Code2 size={12}/>{t("本地开发")}</span>
                  : <span className="plugin-badge is-third">{t("第三方")}</span>}
              {installed && <span className={`plugin-badge ${installed.enabled ? "is-enabled" : "is-disabled"}`}>{installed.enabled ? t("已启用") : t("已停用")}</span>}
              {manifest.artifact.url && !installed && <span className="plugin-badge">{t("按需下载")}</span>}
            </div>
            <p className="plugin-card-desc">{description}</p>
            {manifest.attribution && (
              <p className="plugin-card-attribution">
                {t("原作者：{0} · {1}", manifest.attribution.author, manifest.attribution.license)}
              </p>
            )}
          </div>
        </div>

        <dl className="plugin-meta-grid">
          <div><dt>{t("来源")}</dt><dd><code>{manifest.source.repository}@{manifest.source.commit.slice(0, 7)}</code></dd></div>
          <div><dt>{t("体积")}</dt><dd>{formatPluginSize(manifest.artifact.sizeBytes)}</dd></div>
          <div><dt>{t("扩展位置")}</dt><dd>{manifest.contributions.map((c) => contributionLabel(c.kind)).join(" · ")}</dd></div>
          <div><dt>{t("网络域名")}</dt><dd>{manifest.domains.length ? manifest.domains.join(", ") : t("无外部网络访问")}</dd></div>
        </dl>

        <div className="plugin-caps">
          <span className="plugin-caps-label">{t("所需能力")}</span>
          {manifest.capabilities.length ? manifest.capabilities.map((cap) => (
            <span key={cap} className="plugin-cap-pill">{capabilityLabel(cap)}</span>
          )) : <span className="plugin-cap-pill">{t("仅基础隔离运行")}</span>}
          {manifest.requiresHost && <span className="plugin-cap-pill is-host">{t("需要主机支持")}</span>}
        </div>

        <div className="plugin-card-actions">
          {!installed && entry && (
            <button
              type="button"
              className="primary"
              disabled={isBusy || thirdPartyBlocked}
              onClick={() => setReviewEntry(entry)}
            >
              <Download size={14}/>{entry.manifest.artifact.url ? t("下载并安装") : t("安装")}
            </button>
          )}
          {installed && (
            <>
              <button
                type="button"
                className={installed.enabled ? "secondary" : "primary"}
                onClick={() => pluginRegistry.setEnabled(manifest.id, !installed.enabled)}
              >
                {installed.enabled ? t("停用") : t("启用")}
              </button>
              {installed.enabled && primaryContribution && onOpenContribution && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onOpenContribution(
                    manifest.id,
                    primaryContribution.id,
                    primaryContribution.kind,
                    locale === "zh" ? primaryContribution.titleZh ?? primaryContribution.title : primaryContribution.title,
                  )}
                >
                  {t("打开")}
                </button>
              )}
              {updateEntry && (
                <button
                  type="button"
                  className="secondary"
                  disabled={isBusy}
                  onClick={() => setReviewEntry(updateEntry)}
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
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="plugins-view" data-platform={platform}>
      <div className="plugins-toolbar">
        <label className="plugins-search" htmlFor={searchId}>
          <Search size={15} aria-hidden="true"/>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("搜索插件名称、说明或仓库…")}
            aria-label={t("搜索插件")}
          />
        </label>
        <span className="plugins-storage-note">{t("插件保存在当前设备用户数据中，运行在独立隔离沙箱内。")}</span>
      </div>

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

      {reviewEntry && (
        <section className="plugin-consent-box" aria-label={t("安装前权限确认")}>
          <header>
            <strong>{t("确认安装「{0}」v{1}", displayTitle(reviewEntry.manifest, locale), reviewEntry.manifest.version)}</strong>
            <button type="button" className="icon-button" aria-label={t("取消")} onClick={() => setReviewEntry(undefined)}><X size={16}/></button>
          </header>
          <p className="muted">
            {t("安装前会校验构建产物的 SHA-256（{0}…）{1}。插件运行在独立沙箱中，无法读取 App 令牌或调用主机 API。",
              reviewEntry.manifest.artifact.sha256.slice(0, 12),
              reviewEntry.manifest.official ? t("与官方签名") : "",
            )}
          </p>
          <ul>
            <li><strong>{t("所需能力")}：</strong>{reviewEntry.manifest.capabilities.length ? reviewEntry.manifest.capabilities.map(capabilityLabel).join("、") : t("无额外能力")}</li>
            <li><strong>{t("网络域名")}：</strong>{reviewEntry.manifest.domains.length ? reviewEntry.manifest.domains.join(", ") : t("无外部网络访问")}</li>
            <li><strong>{t("源码位置")}：</strong><code>{reviewEntry.manifest.source.repository}@{reviewEntry.manifest.source.commit}</code></li>
            {reviewEntry.manifest.attribution && (
              <li><strong>{t("原作者与协议")}：</strong>{reviewEntry.manifest.attribution.author} ({reviewEntry.manifest.attribution.license})</li>
            )}
          </ul>
          <div className="plugin-consent-actions">
            <button type="button" className="secondary" onClick={() => setReviewEntry(undefined)}>{t("取消")}</button>
            <button type="button" className="primary" disabled={busyId === reviewEntry.manifest.id} onClick={() => void performInstall(reviewEntry)}>
              <Download size={14}/>{busyId === reviewEntry.manifest.id ? t("正在下载并校验…") : t("确认并安装")}
            </button>
          </div>
        </section>
      )}

      {uninstallTarget && (
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
      )}

      <section className="plugins-section" aria-label={t("官方插件")}>
        <header className="plugins-section-head">
          <h4>{t("官方插件")}</h4>
          <span className="muted">{t("由 TaroBird 维护并做哈希与签名校验")}</span>
        </header>
        {officialEntries.length ? (
          <div className="plugins-grid">
            {officialEntries.map((entry) => renderCard(entry, state.installed[entry.manifest.id]))}
          </div>
        ) : <p className="muted">{t("没有匹配的官方插件。")}</p>}
      </section>

      <section className="plugins-section" aria-label={t("第三方插件")}>
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
                else { setConfirmThirdParty(false); pluginRegistry.setAllowThirdParty(false); }
              }}
            />
            <span>{t("允许第三方插件")}</span>
          </label>
        </header>

        {confirmThirdParty && !state.allowThirdParty && (
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
              <button type="button" className="primary" onClick={() => { pluginRegistry.setAllowThirdParty(true); setConfirmThirdParty(false); }}>{t("已知晓，开启第三方插件")}</button>
            </div>
          </div>
        )}

        {!state.allowThirdParty && !confirmThirdParty && (
          <p className="plugins-muted-box">{t("第三方插件开关默认关闭。开启后可安装社区提供的插件。")}</p>
        )}

        {thirdPartyEntries.length ? (
          <div className="plugins-grid">
            {thirdPartyEntries.map((entry) => renderCard(entry, state.installed[entry.manifest.id]))}
          </div>
        ) : <p className="muted">{t("没有匹配的第三方插件。")}</p>}
      </section>

      {platform === "desktop" && (
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
          {state.developerMode && (
            <div className="plugins-dev-box">
              <input
                ref={folderInputRef}
                type="file"
                hidden
                multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => { void handleLocalFolderFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
              />
              <button type="button" className="secondary" onClick={() => folderInputRef.current?.click()}>
                <FolderOpen size={15}/>{t("从本地文件夹加载插件")}
              </button>
              <small className="muted">{t("目录中需包含符合规范的 manifest.json 与入口 HTML 文件。")}</small>
            </div>
          )}
          {filteredLocalDev.length > 0 && (
            <div className="plugins-grid">
              {filteredLocalDev.map((record) => renderCard(null, record))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function PluginsModal({
  platform,
  initialInstallId,
  close,
  onOpenContribution,
}: {
  platform: PluginPlatform;
  initialInstallId?: string;
  close: () => void;
  onOpenContribution?: (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => void;
}) {
  useLocale();
  return (
    <div className="plugins-modal-backdrop" role="dialog" aria-modal="true" aria-label={t("插件管理")}>
      <div className="plugins-modal">
        <header className="plugins-modal-header">
          <div className="plugins-modal-title">
            <Puzzle size={19}/>
            <h2>{t("插件管理")}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={t("关闭插件页")} onClick={close}><X size={18}/></button>
        </header>
        <div className="plugins-modal-body">
          <PluginsView platform={platform} initialInstallId={initialInstallId} onOpenContribution={(pluginId, contributionId, kind, title) => {
            close();
            onOpenContribution?.(pluginId, contributionId, kind, title);
          }}/>
        </div>
      </div>
    </div>
  );
}
