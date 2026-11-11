// runs before mod.js. if the server gave us a newer mod than the one bundled in this zip, run that instead,
// then poll the server for updates every 10s and offer a reload when one is downloaded.
(() => {
  const SERVER = window.SRMP_SERVER, HTTP = SERVER.replace(/^ws/, 'http');
  const LOADER = window.SRMP_LOADER, BUNDLED = window.SRMP_BUNDLED;
  const cachedVer = () => +localStorage.srmpCodeVer || 0;

  let running = BUNDLED;
  if (cachedVer() > BUNDLED && localStorage.srmpCode) {
    try {
      new Function(localStorage.srmpCode)();
      running = cachedVer();
    } catch {
      localStorage.removeItem('srmpCode'); localStorage.removeItem('srmpCodeVer');
      window.__srmpRan = 0;              // let the bundled mod.js run
      window.SRMP_SERVER = SERVER;
    }
  }

  let shown = '';
  const bar = (key, text, label, act) => {
    if (shown === key || !document.body) return;
    shown = key;
    document.getElementById('srmp-upd')?.remove();
    const el = document.createElement('div');
    el.id = 'srmp-upd';
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:rgba(10,12,16,.9);color:#eee;font:13px Sono,monospace;max-width:340px';
    const t = document.createElement('div'); t.textContent = text; t.style.whiteSpace = 'pre-line';
    const b = document.createElement('button'); b.textContent = label;
    b.style.cssText = 'font:inherit;padding:6px 10px;border:0;border-radius:6px;background:#eee;color:#111;cursor:pointer';
    b.onclick = act;
    const x = document.createElement('button'); x.textContent = '×';
    x.style.cssText = 'font:inherit;border:0;background:none;color:#aaa;cursor:pointer';
    x.onclick = () => el.remove();
    el.append(t, b, x);
    document.documentElement.append(el);
  };

  const check = async () => {
    try {
      const v = await fetch(HTTP + '/version', { cache: 'no-store' }).then(r => r.json());
      if (v.loader > LOADER) {
        if (window.SRMP_USERSCRIPT) // userscript managers install/replace it themselves
          return bar('loader' + v.loader, 'new userscript version', 'update', () => open(HTTP + '/slowroads-mp.user.js', '_blank'));
        return bar('loader' + v.loader, 'new extension version.\nunzip it → chrome://extensions → remove the old one → load unpacked', 'download', () => {
          const a = document.createElement('a');
          a.href = HTTP + '/extension.zip'; a.download = 'slowroads-mp-extension.zip'; a.click();
        });
      }
      if (v.mod > running && v.mod > cachedVer()) {
        const code = await fetch(HTTP + '/mod.js', { cache: 'no-store' }).then(r => r.text());
        if (!code.includes('const MOD_VERSION = ' + v.mod + ';')) return;
        localStorage.srmpCode = code;
        localStorage.srmpCodeVer = v.mod;
      }
      if (cachedVer() > running) bar('mod' + cachedVer(), `update v${cachedVer()} ready`, 'reload', () => {
        if (localStorage.srmp) sessionStorage.srmpAuto = 1; // rejoin straight away after the reload
        location.reload();
      });
    } catch {}
  };

  addEventListener('DOMContentLoaded', () => { check(); setInterval(check, 10000); });
})();
