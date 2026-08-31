import React, { useCallback, useEffect, useState } from 'react';

export function Sync({ client, onError }) {
  const [sync, setSync] = useState(null);

  const reload = useCallback(async () => {
    try {
      const result = await client.syncStatus();
      setSync(result.sync ?? null);
    } catch (error) {
      onError(error.message);
    }
  }, [client, onError]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!sync) return <div className="page dim">加载中…</div>;
  return (
    <div className="page">
      <div className="toolbar">
        <button className="ghost" onClick={reload}>刷新</button>
        <span className="dim">每 15 秒自动刷新</span>
      </div>
      <div className="cards">
        <div className="card stat">
          <div className="statLabel">本节点</div>
          <div className="statValue">{sync.node_id}</div>
          <div className="dim">outbox head {sync.head_seq}</div>
        </div>
        <div className="card stat">
          <div className="statLabel">签名</div>
          <div className="statValue">{sync.signing ? '已启用' : '未启用'}</div>
          <div className="dim">{sync.signing ? '事件按 origin 密钥验签' : '兼容模式'}</div>
        </div>
        <div className="card stat">
          <div className="statLabel">中继</div>
          <div className="statValue">{sync.relay ? '已启用' : '关闭'}</div>
          <div className="dim">{sync.relay ? `承载 ${sync.relay_origins.length} 个 origin 流` : '直连模式'}</div>
        </div>
        <div className="card stat">
          <div className="statLabel">收件箱</div>
          <div className="statValue">{Object.values(sync.inbox).reduce((sum, count) => sum + count, 0)}</div>
          <div className="dim">{Object.entries(sync.inbox).map(([key, count]) => `${key} ${count}`).join(' · ') || '空'}</div>
        </div>
      </div>
      <table className="list">
        <thead>
          <tr><th>Peer</th><th>状态</th><th>协议</th><th>最后活跃</th></tr>
        </thead>
        <tbody>
          {sync.peers.map((peer) => (
            <tr key={peer.node_id}>
              <td>{peer.node_id}</td>
              <td>{peer.status === 'active' ? '活跃' : '已撤销'}</td>
              <td>v{peer.protocol_version}</td>
              <td className="dim">{(peer.last_seen_at ?? '').replace('T', ' ').slice(0, 19) || '-'}</td>
            </tr>
          ))}
          {!sync.peers.length && <tr><td colSpan={4} className="dim">没有已注册节点</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
