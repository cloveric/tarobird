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
            const english = app.getLocale().startsWith('en');
            const result = dialog.showMessageBoxSync(window, { type: 'question', title: 'TaroBird',
              message: english ? 'Some work is still being saved. Quit anyway?' : '仍有内容尚未保存完成。确定退出吗？',
              buttons: english ? ['Keep open', 'Quit'] : ['继续使用', '退出'], defaultId: 0, cancelId: 0 });
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
    const english = app.getLocale().startsWith('en');
    const shared = sharing.length ? [
      ...sharing.map(item => ({ enabled: false, label: english ? `Sharing screen with ${item.deviceName}${item.controlling ? ' (controlling)' : ' (viewing)'}` : `正在共享屏幕：${item.deviceName}${item.controlling ? '（控制中）' : '（查看中）'}` })),
      { label: english ? 'Stop screen sharing' : '停止共享屏幕', accelerator: STOP_SHORTCUT, click: () => stopSharing() }, { type: 'separator' },
    ] : [];
    tray.setContextMenu(Menu.buildFromTemplate([...shared, { label: english ? 'Open TaroBird' : '打开 TaroBird', click: () => void show() }, { type: 'separator' }, { role: 'quit', label: english ? 'Quit' : '退出' }]));
    tray.setToolTip(sharing.length ? (english ? 'TaroBird · sharing screen' : 'TaroBird · 正在共享屏幕') : 'TaroBird');
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
      void dialog.showMessageBox(window, { type: 'info', title: 'TaroBird', message: app.getLocale().startsWith('en')
        ? 'An update is in progress. Wait for it to finish, or cancel it in App updates while downloading or waiting for tasks.'
        : '正在更新 TaroBird。请等待完成；下载或等待任务时，可以在“应用更新”中取消。' });
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
  app.on('will-quit', () => { if (restarting) app.relaunch(); globalShortcut.unregisterAll(); tray?.destroy(); });
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
    const english = app.getLocale().startsWith('en');
    const item = (role, en, zh) => ({ role, label: english ? en : zh });
    // Windows' generated role menus use English labels even when our File and
    // View menus are Chinese. Explicit labels retain the native role shortcuts.
    Menu.setApplicationMenu(Menu.buildFromTemplate(platform === 'win32' ? [
      { label: english ? 'File' : '文件', submenu: [item('close', 'Close window', '关闭窗口')] },
      { label: english ? 'Edit' : '编辑', submenu: [item('undo', 'Undo', '撤销'), item('redo', 'Redo', '重做'), { type: 'separator' },
        item('cut', 'Cut', '剪切'), item('copy', 'Copy', '复制'), item('paste', 'Paste', '粘贴'),
        item('pasteAndMatchStyle', 'Paste and match style', '粘贴并匹配样式'), item('delete', 'Delete', '删除'),
        { type: 'separator' }, item('selectAll', 'Select all', '全选')] },
      { label: english ? 'View' : '视图', submenu: [item('togglefullscreen', 'Toggle full screen', '切换全屏')] },
      { label: english ? 'Window' : '窗口', submenu: [item('minimize', 'Minimize', '最小化'), item('close', 'Close window', '关闭窗口')] },
    ] : [
      ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: english ? 'File' : '文件', submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      { label: english ? 'View' : '视图', submenu: [{ role: 'togglefullscreen' }] },
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
