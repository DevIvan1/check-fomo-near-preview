// Runs first, as a classic script: applies the saved theme before the first paint and makes sure
// the app actually starts. If the modules fail to load (for example a stale cached file right
// after an update), the page reloads once from a fresh URL; if that does not help, it says how
// to force a refresh instead of leaving a blank page.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('nwm.settings.v1') || '{}');
    if (s.theme === 'light' || s.theme === 'dark') document.documentElement.setAttribute('data-theme', s.theme);
  } catch (e) {
    /* storage blocked: follow the system theme */
  }

  var KEY = 'nwm.bootRetry';

  function showError() {
    var d = document.createElement('div');
    d.className = 'boot-error';
    d.setAttribute('role', 'alert');
    d.textContent = 'The app failed to load. Press Ctrl+F5 (Cmd+Shift+R on Mac) to reload. · '
      + 'Приложение не загрузилось. Нажмите Ctrl+F5 (Cmd+Shift+R на Mac).';
    document.body.appendChild(d);
  }

  function recover() {
    if (window.__nwmReady || window.__nwmRecovering) return;
    window.__nwmRecovering = true;
    var retried = true;
    try {
      retried = sessionStorage.getItem(KEY) === '1';
      sessionStorage.setItem(KEY, '1');
    } catch (e) {
      /* no storage: do not risk a reload loop */
    }
    if (!retried) {
      var u = new URL(location.href);
      u.searchParams.set('_r', Date.now().toString(36));
      location.replace(u.href);
      return;
    }
    if (document.body) showError();
    else document.addEventListener('DOMContentLoaded', showError);
  }

  window.addEventListener('error', function (e) {
    var msg = (e && e.message) || '';
    if (!window.__nwmReady && /module|import|export|SyntaxError/i.test(msg)) recover();
  });
  setTimeout(function () {
    if (!window.__nwmReady) recover();
  }, 8000);
})();
