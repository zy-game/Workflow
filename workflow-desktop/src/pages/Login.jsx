import React, { useState } from 'react';
import { ApiError } from '../lib/api.js';

export function Login({ onLogin }) {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8710');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const client = new CoreClient(baseUrl);
    try {
      const token = await client.login(email.trim(), password);
      onLogin(client.baseUrl, token);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status !== 0
        ? `登录失败：${cause.message}`
        : `无法连接到 ${client.baseUrl}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Workflow</h1>
      <label>
        Core 地址
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
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
    </form>
  );
}
