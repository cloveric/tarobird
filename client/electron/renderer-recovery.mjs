import { resolveElectronLocale, pickElectronCopy } from './locale.mjs';

/** Recover only the owned App document. NativeOwner registers first and
 * retires the crashed document's credentials and sockets before this runs. */
export function installRendererRecovery(window, { app, dialog, entry, quitting = () => false,
  updating = () => false, recoveryRequired = () => false, restartRequired = () => false, restart, now = Date.now,
  defer = fn => setTimeout(fn, 250), cancel = clearTimeout } = {}) {
  const contents = window.webContents;
  const attempts = [];
  let pending = false, working = false, disposed = false, timer, hung = false, asking = false, recoveryShown = false;
  const alive = () => !disposed && !quitting() && !window.isDestroyed() && !contents.isDestroyed();
  const showRecovery = async () => {
    if (recoveryShown || !alive()) return;
    recoveryShown = true;
    const loc = resolveElectronLocale({ app });
    await dialog.showMessageBox(window, { type: 'error', title: 'TaroBird',
      message: pickElectronCopy(loc, { zh: '更新恢复尚未完成。', en: 'The update could not be recovered.', ja: 'アップデートの復旧を完了できませんでした。' }),
      detail: pickElectronCopy(loc, {
        zh: '应用文件状态尚未确认，请联系支持恢复应用后再打开。请保留应用数据和恢复备份。',
        en: 'The application files could not be verified. Contact support to restore the App before reopening it. Keep the App data and recovery backup.',
        ja: 'アプリファイルの状態を確認できませんでした。サポートに連絡して復旧してから再度開いてください。アプリデータと復旧用バックアップは保持してください。',
      }),
      buttons: [pickElectronCopy(loc, { zh: '知道了', en: 'OK', ja: 'OK' })] });
  };
  const recover = async () => {
    if (working || !pending || !alive()) return;
    if (recoveryRequired()) { pending = false; await showRecovery().catch(() => {}); return; }
    if (updating()) { if (!timer) timer = defer(() => { timer = undefined; void recover(); }); return; }
    if (restartRequired()) { pending = false; restart?.(); return; }
    working = true; pending = false;
    try {
      while (attempts.length && now() - attempts[0] >= 60000) attempts.shift();
      if (attempts.length >= 3) {
        const loc = resolveElectronLocale({ app });
        const { response } = await dialog.showMessageBox(window, { type: 'error', title: 'TaroBird',
          message: pickElectronCopy(loc, { zh: '窗口连续发生异常。', en: 'The window stopped responding repeatedly.', ja: 'ウィンドウの応答停止が繰り返し発生しました。' }),
          detail: pickElectronCopy(loc, {
            zh: '可以重新加载窗口，或退出后再打开。已保存的草稿和消息会保留。',
            en: 'Reload the window, or quit and open TaroBird again. Saved drafts and messages are kept.',
            ja: 'ウィンドウを再読み込みするか、TaroBird を終了して開き直してください。保存済みの下書きやメッセージは保持されます。',
          }),
          buttons: pickElectronCopy(loc, {
            zh: ['重新加载窗口', '退出'],
            en: ['Reload window', 'Quit'],
            ja: ['ウィンドウを再読み込み', '終了'],
          }), defaultId: 0, cancelId: 1 });
        if (!alive()) return;
        if (response !== 0) { app.quit(); return; }
        attempts.length = 0;
      }
      if (!alive()) return;
      // A completed update replaces paths that this old main process uses.
      // It must relaunch, never load a renderer from the new bundle.
      if (recoveryRequired()) { await showRecovery().catch(() => {}); return; }
      if (restartRequired()) { restart?.(); return; }
      attempts.push(now());
      await window.loadURL(entry);
    } catch { if (alive()) pending = true; }
    finally {
      working = false;
      if (pending && alive() && !timer) timer = defer(() => { timer = undefined; void recover(); });
    }
  };
  const gone = () => { pending = true; void recover(); };
  const responsive = () => { hung = false; };
  const unresponsive = () => {
    hung = true;
    if (asking || working || !alive() || updating()) return;
    asking = true;
    const loc = resolveElectronLocale({ app });
    void dialog.showMessageBox(window, { type: 'warning', title: 'TaroBird',
      message: pickElectronCopy(loc, { zh: '窗口暂时没有响应。', en: 'The window is not responding.', ja: 'ウィンドウが応答していません。' }),
      detail: pickElectronCopy(loc, {
        zh: '可以继续等待或重新加载。重新加载可能丢失尚未保存的输入。',
        en: 'You can keep waiting or reload. Input that has not been saved may be lost on reload.',
        ja: 'このまま待機するか、再読み込みできます。再読み込みすると未保存の入力が失われる場合があります。',
      }),
      buttons: pickElectronCopy(loc, {
        zh: ['继续等待', '重新加载窗口'],
        en: ['Keep waiting', 'Reload window'],
        ja: ['待機を続ける', 'ウィンドウを再読み込み'],
      }), defaultId: 0, cancelId: 0,
    }).then(({ response }) => {
      if (!alive() || !hung || response !== 1 || updating()) return;
      if (recoveryRequired()) void showRecovery().catch(() => {});
      else if (restartRequired()) restart?.(); else contents.forcefullyCrashRenderer();
    }).catch(() => {}).finally(() => { asking = false; });
  };
  contents.on('render-process-gone', gone);
  window.on('unresponsive', unresponsive); window.on('responsive', responsive);
  const dispose = () => { disposed = true; if (timer) cancel(timer); contents.removeListener('render-process-gone', gone);
    window.removeListener('unresponsive', unresponsive); window.removeListener('responsive', responsive); };
  contents.once('destroyed', dispose);
  return dispose;
}
