import React, { useCallback, useEffect, useState } from 'react';

export function Projects({ client, onError }) {
  const [projects, setProjects] = useState([]);

  const reload = useCallback(async () => {
    try {
      const result = await client.projects();
      setProjects(result.projects ?? []);
    } catch (error) {
      onError(error.message);
    }
  }, [client, onError]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="page">
      <div className="toolbar">
        <button className="ghost" onClick={reload}>刷新</button>
      </div>
      <table className="list">
        <thead>
          <tr><th>项目</th><th>Owner 节点</th><th>状态</th><th>位置</th></tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>{project.name}</td>
              <td>{project.metadata?.owner_node_id ?? <span className="dim">未指定</span>}</td>
              <td>{project.status}</td>
              <td className="dim">
                {(project.locations ?? []).map((location) => location.path).join(' · ') || '本机未注册路径'}
              </td>
            </tr>
          ))}
          {!projects.length && <tr><td colSpan={4} className="dim">没有项目</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
