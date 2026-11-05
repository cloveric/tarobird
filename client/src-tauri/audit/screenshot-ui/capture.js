const capture = document.querySelector('#capture'), status = document.querySelector('#status'), image = document.querySelector('#result');
let captures = 0, cancellations = 0;
capture.onclick = async () => {
  capture.disabled = true;
  try {
    const png = await window.__TAURI_INTERNALS__.invoke('capture_screenshot', { english: false });
    if (png === null) { cancellations++; status.textContent = `已取消 · 成功 ${captures} 次 · 取消 ${cancellations} 次`; }
    else { captures++; image.src = `data:image/png;base64,${png}`; image.hidden = false; await image.decode(); status.textContent = `成功 ${captures} 次 · ${image.naturalWidth} × ${image.naturalHeight} · 取消 ${cancellations} 次`; }
  } catch (error) { status.textContent = String(error); }
  finally { capture.disabled = false; }
};
