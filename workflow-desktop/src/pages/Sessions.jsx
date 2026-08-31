// Sessions.jsx - embeds the DSH web UI (its own pages: conversations,
// sessions, settings) inside the desktop shell. Nothing about DSH is
// re-implemented here; the page just points at a running DSH web server.
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { loadDshUrl, saveDshUrl } from '../lib/api.js';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function openStandaloneWindow(url, title) {
  if (isTauri) {
    try {
      await invoke('open_web_window', { url, title });
      return;
    } catch (error) {
      console.error('open_web_window failed:', error);
    }
  }
  window.open(url, '_blank', 'noopener');
}

export function Sessions() {
  const [draft, setDraft] = useState(() => loadDshUrl());
  const [url, setUrl] = useState(() => loadDshUrl());

  useEffect(() => {
    if (url && loadDshUrl() !== url) saveDshUrl(url);
  }, [url]);

  function apply(event) {
    event.preventDefault();
    setUrl(saveDshUrl(draft));
  }

  return (
    <div className="page sessions">
      <form className="toolbar" onSubmit={apply}>
        <input
          style={{ flex: 1, maxWidth: 560 }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="DSH Web 地址，例如 http://127.0.0.1:8080"
        />
        <button className="primary" type="submit">连接</button>
        {url && (
          <button
            type="button"
            onClick={() => openStandaloneWindow(url, 'DSH 会话')}
          >
            独立窗口打开
          </button>
        )}
        <span className="dim">会话界面由 DSH 自带页面提供</span>
      </form>
      {url ? (
        <iframe className="embed" src={url} title="DSH Web" />
      ) : (
        <div className="card dim">
          填入运行中的 DSH Web 服务地址并连接，即可在此内嵌使用 DSH 自带的
          会话/轨迹/设置等页面；也可以用「独立窗口打开」。
        </div>
      )}
    </div>
  );
}
