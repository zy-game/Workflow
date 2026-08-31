import React, { useEffect, useMemo, useState } from 'react';
import { CoreClient, loadSession, saveSession, clearSession, ApiError } from './lib/api.js';
import { Login } from './pages/Login.jsx';
import { Tasks } from './pages/Tasks.jsx';
import { Projects } from './pages/Projects.jsx';
import { Peers } from './pages/Peers.jsx';
import { Sync } from './pages/Sync.jsx';

const PAGES = [
  { id: 'tasks', label: '任务', component: Tasks },
  { id: 'projects', label: '项目', component: Projects },
  { id: 'peers', label: '节点', component: Peers },
  { id: 'sync', label: '同步', component: Sync },
];

export function App() {
  const [client, setClient] = useState(() => CoreClient.fromSession());
  const [page, setPage] = useState('tasks');
  const [banner, setBanner] = useState(null);

  useEffect(() => {
    if (!client) return;
    client.request('/api/v1/tasks?limit=1')
      .then(() => setBanner(null))
      .catch((error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 0)) {
          clearSession();
          setClient(null);
        }
      });
  }, [client]);

  const active = useMemo(() => PAGES.find((entry) => entry.id === page) ?? PAGES[0], [page]);

  if (!client) {
    return (
      <Login
        onLogin={(baseUrl, token) => {
          saveSession(baseUrl, token);
          setClient(new CoreClient(baseUrl, token));
        }}
      />
    );
  }

  const Page = active.component;
  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">Workflow</div>
        {PAGES.map((entry) => (
          <button
            key={entry.id}
            className={entry.id === page ? 'navItem active' : 'navItem'}
            onClick={() => setPage(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <div className="spacer" />
        <span className="host" title={client.baseUrl}>{client.baseUrl.replace(/^https?:\/\//, '')}</span>
        <button
          className="ghost"
          onClick={() => { clearSession(); setClient(null); }}
        >
          退出
        </button>
      </nav>
      {banner && <div className="banner">{banner}</div>}
      <main className="content">
        <Page client={client} onError={setBanner} />
      </main>
    </div>
  );
}
