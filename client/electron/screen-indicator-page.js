// Sharing badge shown on each shared display. Text only from the URL hash
// (textContent, never HTML). Same-document navigation updates the participants
// and control status without creating another clock timer.
const label = document.getElementById('label'), clock = document.getElementById('clock');
let since;
const tick = () => { const s = Math.max(0, Math.floor((Date.now() - since) / 1000)); clock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const render = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const english = params.get('lang') === 'en'; since = Number(params.get('since')) || Date.now();
  const names = (params.get('names') || '').split('\n').filter(Boolean).slice(0, 2).map(name => name.slice(0, 64));
  const control = params.get('control') === '1';
  label.textContent = `${english ? 'Sharing screen' : '正在共享屏幕'} · ${names.join(', ')}${control ? (english ? ' · controlling' : ' · 控制中') : ''}`;
  tick();
};
render(); addEventListener('hashchange', render); setInterval(tick, 1000);
