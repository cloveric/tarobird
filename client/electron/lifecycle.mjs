import { resolveElectronLocale, pickElectronCopy } from './locale.mjs';

/** Application lifetime is independent of its visible window and the Host.
 * Closing hides the main window; quitting retires the desktop bridge while the
 * canonical detached Host follows its existing service lifecycle. */
export function installDesktopLifecycle(electron, { createWindow, addon, icon, production = false, platform = process.platform, updating = () => false, prepareQuit, quitCancelled = () => {}, stopSharing = () => {} }) {
  const { app, Menu, Tray, nativeImage, globalShortcut, dialog } = electron;
  // Register before ready: cold-start notification activation must not be lost.
  addon?.initializeNotifications();
  let window, creating, tray, quitting = false, registered = false, restarting = false, prepared = false, preparing, sharing = [], emergency = false;
  const STOP_SHORTCUT = 'Control+Alt+Command+Escape';
  const links = [];
  const remember = raw => {
    if (typeof raw !== 'string' || raw.length > 2048) return;
    let url; try { url = new URL(raw); } catch { return; }
    if (url.protocol !== 'tarocub:' || !['conversation', 'notification'].includes(url.hostname)) return;
    if (url.hostname === 'notification') { addon?.notificationActivationArgs([process.execPath, raw]); return; }
    links.push(raw); if (links.length > 16) links.shift();
    if (window && !window.isDestroyed()) window.webContents.send('tarobot:desktop-event:v1', { name: 'deep-link', payload: [raw] });
  };
  const show = async () => {
    if (window?.isDestroyed()) window = undefined;
    if (!window) {
      if (!creating) creating = createWindow({ launchLinks: () => links.splice(0), badgeChanged: count => tray?.setToolTip(count ? `TaroBird · ${count} unread` : 'TaroBird'), reveal: () => show() })
        .then(value => {
          window = value;
          window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
          window.webContents.on('will-prevent-unload', event => {
            const loc = resolveElectronLocale({ app });
            const result = dialog.showMessageBoxSync(window, { type: 'question', title: 'TaroBird',
              message: pickElectronCopy(loc, {
                zh: '仍有内容尚未保存完成。确定退出吗？',
                en: 'Some work is still being saved. Quit anyway?',
                ja: 'まだ保存されていない作業があります。終了しますか？',
              }),
              buttons: pickElectronCopy(loc, {
                zh: ['继续使用', '退出'],
                en: ['Keep open', 'Quit'],
                ja: ['開いたままにする', '終了'],
              }), defaultId: 0, cancelId: 0 });
            if (result === 1) event.preventDefault(); else { quitting = false; restarting = false; prepared = false; quitCancelled(); }
          });
          return value;
        }).finally(() => { creating = undefined; });
      await creating;
    }
    if (window.isMinimized()) window.restore(); window.show(); window.focus();
  };
  /** Tray: who is viewing/controlling this Mac and a one-click stop. */
  const trayMenu = () => {
    if (!tray) return;
    const loc = resolveElectronLocale({ app });
    const shared = sharing.length ? [
      ...sharing.map(item => ({ enabled: false, label: pickElectronCopy(loc, {
        zh: `正在共享屏幕：${item.deviceName}${item.controlling ? '（控制中）' : '（查看中）'}`,
        en: `Sharing screen with ${item.deviceName}${item.controlling ? ' (controlling)' : ' (viewing)'}`,
        ja: `画面を共有中：${item.deviceName}${item.controlling ? '（操作中）' : '（表示中）'}`,
      }) })),
      { label: pickElectronCopy(loc, { zh: '停止共享屏幕', en: 'Stop screen sharing', ja: '画面共有を停止' }), accelerator: STOP_SHORTCUT, click: () => stopSharing() }, { type: 'separator' },
    ] : [];
    tray.setContextMenu(Menu.buildFromTemplate([
      ...shared,
      { label: pickElectronCopy(loc, { zh: '打开 TaroBird', en: 'Open TaroBird', ja: 'TaroBird を開く' }), click: () => void show() },
      { type: 'separator' },
      { role: 'quit', label: pickElectronCopy(loc, { zh: '退出', en: 'Quit', ja: '終了' }) },
    ]));
    tray.setToolTip(sharing.length ? pickElectronCopy(loc, {
      zh: 'TaroBird · 正在共享屏幕',
      en: 'TaroBird · sharing screen',
      ja: 'TaroBird · 画面を共有中',
    }) : 'TaroBird');
  };
  /** The emergency stop shortcut exists only while this Mac is being shared. */
  const setSharing = items => {
    sharing = Array.isArray(items) ? items.slice(0, 4) : [];
    if (sharing.length && !emergency) emergency = globalShortcut.register(STOP_SHORTCUT, () => stopSharing());
    else if (!sharing.length && emergency) { globalShortcut.unregister(STOP_SHORTCUT); emergency = false; }
    trayMenu();
  };
  const handleArgs = args => { for (const arg of args.slice(1)) remember(arg); };
  app.on('open-url', (event, url) => { event.preventDefault(); remember(url); if (app.isReady()) void show(); });
  app.on('second-instance', (_event, argv) => { handleArgs(argv); void show(); });
  app.on('activate', () => { if (app.isReady()) void show(); });
  app.on('before-quit', event => {
    if (updating()) {
      event.preventDefault(); quitting = false; restarting = false; void show();
      void dialog.showMessageBox(window, { type: 'info', title: 'TaroBird', message: pickElectronCopy(resolveElectronLocale({ app }), {
        zh: '正在更新 TaroBird。请等待完成；下载或等待任务时，可以在“应用更新”中取消。',
        en: 'An update is in progress. Wait for it to finish, or cancel it in App updates while downloading or waiting for tasks.',
        ja: 'TaroBird をアップデート中です。完了するまでお待ちください。ダウンロード中またはタスク待機中は「アプリのアップデート」からキャンセルできます。',
      }) });
      return;
    }
    // Workbench pages answer beforeunload before any window closes. A page the
    // person keeps open cancels this quit; nothing else is torn down yet.
    if (prepareQuit && !prepared) {
      event.preventDefault();
      preparing ??= Promise.resolve().then(prepareQuit).catch(() => false).then(ready => {
        preparing = undefined;
        if (ready === true) { prepared = true; app.quit(); } else { restarting = false; quitCancelled(); }
      });
      return;
    }
    quitting = true;
  });
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => {
    if (restarting) app.relaunch();
    // A rejected second instance can quit before ready, when shortcut APIs throw.
    if (app.isReady()) globalShortcut.unregisterAll();
    tray?.destroy();
  });
  handleArgs(process.argv);
  const start = async () => {
    if (icon) {
      const size = platform === 'darwin' ? 22 : 18;
      const image = nativeImage.createFromPath(icon).resize({ width: size, height: size });
      if (!image.isEmpty()) {
        if (platform === 'darwin') image.setTemplateImage(true);
        tray = new Tray(image); tray.setToolTip('TaroBird');
        trayMenu();
        tray.on('click', () => void show());
      }
    }
    const loc = resolveElectronLocale({ app });
    const item = (role, labels) => ({ role, label: pickElectronCopy(loc, labels) });
    // Windows' generated role menus use English labels even when our File and
    // View menus are Chinese or Japanese. Explicit labels retain the native role shortcuts.
    Menu.setApplicationMenu(Menu.buildFromTemplate(platform === 'win32' ? [
      { label: pickElectronCopy(loc, { zh: '文件', en: 'File', ja: 'ファイル' }), submenu: [item('close', { zh: '关闭窗口', en: 'Close window', ja: 'ウィンドウを閉じる' })] },
      { label: pickElectronCopy(loc, { zh: '编辑', en: 'Edit', ja: '編集' }), submenu: [
        item('undo', { zh: '撤销', en: 'Undo', ja: '元に戻す' }),
        item('redo', { zh: '重做', en: 'Redo', ja: 'やり直す' }),
        { type: 'separator' },
        item('cut', { zh: '剪切', en: 'Cut', ja: '切り取り' }),
        item('copy', { zh: '复制', en: 'Copy', ja: 'コピー' }),
        item('paste', { zh: '粘贴', en: 'Paste', ja: '貼り付け' }),
        item('pasteAndMatchStyle', { zh: '粘贴并匹配样式', en: 'Paste and match style', ja: 'スタイルを合わせて貼り付け' }),
        item('delete', { zh: '删除', en: 'Delete', ja: '削除' }),
        { type: 'separator' },
        item('selectAll', { zh: '全选', en: 'Select all', ja: 'すべて選択' }),
      ] },
      { label: pickElectronCopy(loc, { zh: '视图', en: 'View', ja: '表示' }), submenu: [item('togglefullscreen', { zh: '切换全屏', en: 'Toggle full screen', ja: 'フルスクリーンの切り替え' })] },
      { label: pickElectronCopy(loc, { zh: '窗口', en: 'Window', ja: 'ウィンドウ' }), submenu: [
        item('minimize', { zh: '最小化', en: 'Minimize', ja: '最小化' }),
        item('close', { zh: '关闭窗口', en: 'Close window', ja: 'ウィンドウを閉じる' }),
      ] },
    ] : [
      ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: pickElectronCopy(loc, { zh: '文件', en: 'File', ja: 'ファイル' }), submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      { label: pickElectronCopy(loc, { zh: '视图', en: 'View', ja: '表示' }), submenu: [{ role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    if (production) {
      app.setAsDefaultProtocolClient('tarocub');
      registered = globalShortcut.register('CommandOrControl+Shift+T', () => void show());
    }
    await show();
    return { window, shortcutRegistered: registered };
  };
  return { start, show, handleArgs, setSharing, restart: () => { restarting = true; app.quit(); }, get quitting() { return quitting; }, get window() { return window; } };
}
