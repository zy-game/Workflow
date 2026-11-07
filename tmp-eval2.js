(() => ({
  href: location.href,
  fetches: (window.__qmFetches || []).filter((item) => String(item.url).includes('latest.json') || String(item.url).includes('/updates/')),
  error: window.__qmError || null,
  rejection: window.__qmRejection || null,
  modal: document.querySelectorAll('.login-backdrop').length,
  bodyText: document.body.innerText.slice(0, 80)
}))()
