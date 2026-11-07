(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const setup = app && app._instance && app._instance.setupState ? app._instance.setupState : {};
  const out = { keys: Object.keys(setup), modalCount: document.querySelectorAll('.login-backdrop').length };
  try {
    const base = String(window.__QM_SERVER_URL || '').replace(/\/+$/, '');
    const res = await fetch(base + '/updates/android/latest.json', { cache: 'no-store' });
    const latest = await res.json();
    const info = await window.Capacitor.Plugins.QmUpdater.getInfo();
    out.check = { ok: res.ok, latestCode: Number(latest.versionCode), currentCode: Number(info.versionCode), wouldPrompt: Number(latest.versionCode) > Number(info.versionCode) };
    out.updateState = setup.update;
  } catch (error) { out.error = String((error && error.message) || error); }
  return out;
})()
