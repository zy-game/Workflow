// workflow-client.js - served by the workflow-web DSH host plugin at
// /workflow/client.js and injected into the DSH web index.html. Adds a
// floating "Workflow" button that opens the Workflow app (same-origin via
// the /workflow proxy) as a full-screen overlay. No dependencies; safe to
// load on every page.
(function () {
  'use strict';
  if (window.__WORKFLOW_CLIENT__) return;
  window.__WORKFLOW_CLIENT__ = true;

  var OPEN_KEY = 'workflow.overlay.open';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (key === 'style') node.setAttribute('style', attrs[key]);
        else if (key === 'text') node.textContent = attrs[key];
        else if (key === 'on') {
          for (var event in attrs[key]) node.addEventListener(event, attrs[key][event]);
        } else node.setAttribute(key, attrs[key]);
      }
    }
    (children ?? []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function setOpen(open) {
    try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* private mode */ }
    var overlay = document.getElementById('workflow-overlay');
    if (overlay) overlay.style.display = open ? 'flex' : 'none';
    var button = document.getElementById('workflow-launcher');
    if (button) button.style.display = open ? 'none' : 'flex';
  }

  function mount() {
    if (document.getElementById('workflow-launcher')) return;

    var overlay = el('div', {
      id: 'workflow-overlay',
      style: 'display:none;position:fixed;inset:0;z-index:2147483646;background:#17181c;'
    });
    var bar = el('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1f2127;border-bottom:1px solid #2c2f37;color:#e6e7ea;font:14px/1.4 system-ui,sans-serif;'
    }, [
      el('span', { style: 'font-weight:600;color:#f0a35a;', text: 'Workflow' }),
      el('span', { style: 'flex:1;' }),
      el('button', {
        text: '在新窗口打开',
        style: 'background:#2c2f37;color:#e6e7ea;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;',
        on: { click: function () { window.open('/workflow/', '_blank', 'noopener'); } }
      }),
      el('button', {
        text: '关闭',
        style: 'background:#2c2f37;color:#e6e7ea;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;',
        on: { click: function () { setOpen(false); } }
      }),
    ]);
    var frame = el('iframe', {
      src: '/workflow/',
      title: 'Workflow',
      style: 'flex:1;width:100%;border:none;background:#fff;'
    });
    overlay.appendChild(bar);
    overlay.appendChild(frame);

    var launcher = el('button', {
      id: 'workflow-launcher',
      style: 'display:flex;position:fixed;right:18px;bottom:18px;z-index:2147483646;'
        + 'align-items:center;gap:6px;background:#e38c3c;color:#17181c;border:none;border-radius:999px;'
        + 'padding:10px 16px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;'
        + 'box-shadow:0 6px 18px rgba(0,0,0,.35);',
      text: '⚙ Workflow',
      on: { click: function () { setOpen(true); } }
    });

    function ready() {
      document.body.appendChild(overlay);
      document.body.appendChild(launcher);
      var wasOpen = '0';
      try { wasOpen = sessionStorage.getItem(OPEN_KEY) ?? '0'; } catch { /* private mode */ }
      setOpen(wasOpen === '1');
    }
    if (document.body) ready();
    else document.addEventListener('DOMContentLoaded', ready);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
