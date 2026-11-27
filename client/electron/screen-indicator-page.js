// Sharing badge shown on each shared display. Text only from the URL hash
// (textContent, never HTML). Same-document navigation updates the participants
// and control status without creating another clock timer.
const label = document.getElementById('label'), clock = document.getElementById('clock');
let since;
const tick = () => { const s = Math.max(0, Math.floor((Date.now() - since) / 1000)); clock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const render = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const lang = params.get('lang') || 'zh'; since = Number(params.get('since')) || Date.now();
  const names = (params.get('names') || '').split('\n').filter(Boolean).slice(0, 2).map(name => name.slice(0, 64));
  const control = params.get('control') === '1';
  const sharingText = lang === 'ja' ? '画面を共有中' : lang === 'en' ? 'Sharing screen' : '正在共享屏幕';
  const controlText = lang === 'ja' ? ' · 操作中' : lang === 'en' ? ' · controlling' : ' · 控制中';
  label.textContent = `${sharingText} · ${names.join(', ')}${control ? controlText : ''}`;
  tick();
};
render(); addEventListener('hashchange', render); setInterval(tick, 1000);
