import React, { useState } from 'react';
import { ApiError, CoreClient } from '../lib/api.js';

export function Login({ onLogin }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const client = new CoreClient(baseUrl.trim());
    try {
      const token = await client.login(email.trim(), password);
      onLogin(client.baseUrl, token);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status !== 0
        ? `登录失败：${cause.message}`
        : cause.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Workflow</h1>
      <label>
        Core 地址（留空 = 本机同源代理）
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="例如 http://127.0.0.1:8710"
        />
      </label>
      <label>
        邮箱
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
      </label>
      <label>
        密码
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      </label>
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      <div className="dim" style={{ textAlign: 'center', fontSize: 12 }}>build 2026-08-31.3 · 同源代理模式</div>
    </form>
  );
}
