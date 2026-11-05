const invoke = window.__TAURI__.core.invoke;
const token = crypto.randomUUID();
const draft = document.querySelector('#draft');
const action = document.querySelector('#action');
const count = document.querySelector('#count');
draft.value = 'unsent draft stays here';
action.addEventListener('click', () => { count.value = String(Number(count.value) + 1); });
window.checkWindowDocument = stage => {
  action.click();
  void invoke('audit_document', { receipt: { stage, token, draft: draft.value, clicks: Number(count.value) } });
};
void invoke('audit_ready');
