import React, { useCallback, useEffect, useState } from 'react';

export function Peers({ client, onError }) {
  const [peers, setPeers] = useState([]);
  const [cursors, setCursors] = useState([]);

  const reload = useCallback(async () => {
    try {
      const result = await client.adminPeers();
      setPeers(result.peers ?? []);
      setCursors(result.cursors ?? []);
    } catch (error) {
      onError(error.message);
    }
  }, [client, onError]);

  useEffect(() => { reload(); }, [reload]);

  async function act(action, nodeId) {
    try {
      await action(nodeId);
      await reload();
    } catch (error) {
      onError(error.message);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <button className="ghost" onClick={reload}>刷新</button>
      </div>
      <table className="list">
        <thead>
          <tr><th>节点</th><th>状态</th><th>端点</th><th>最后活跃</th><th>操作</th></tr>
        </thead>
        <tbody>
          {peers.map((peer) => (
            <tr key={peer.node_id}>
              <td>{peer.node_id}</td>
              <td>
                <span className={`pill ${peer.status === 'active' ? 'pill-done' : 'pill-failed'}`}>
                  {peer.status === 'active' ? '活跃' : '已撤销'}
                </span>
              </td>
              <td className="dim">{peer.endpoint_url ?? '-'}</td>
              <td className="dim">{(peer.last_seen_at ?? '').replace('T', ' ').slice(0, 19) || '-'}</td>
              <td>
                {peer.status === 'active'
                  ? <button className="danger" onClick={() => act(client.revokePeer.bind(client), peer.node_id)}>撤销</button>
                  : <button className="primary" onClick={() => act(client.activatePeer.bind(client), peer.node_id)}>恢复</button>}
              </td>
            </tr>
          ))}
          {!peers.length && <tr><td colSpan={5} className="dim">没有已注册节点</td></tr>}
        </tbody>
      </table>

      {cursors.length > 0 && (
        <section className="card">
          <h3>流游标</h3>
          <table className="list">
            <thead>
              <tr><th>Peer</th><th>Origin 流</th><th>已应用</th><th>已被消费</th></tr>
            </thead>
            <tbody>
              {cursors.map((cursor) => (
                <tr key={`${cursor.peer_node_id}/${cursor.origin_node_id}`}>
                  <td>{cursor.peer_node_id}</td>
                  <td>{cursor.origin_node_id || <span className="dim">本流</span>}</td>
                  <td>{cursor.inbound_cursor}</td>
                  <td>{cursor.outbound_acked_seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
