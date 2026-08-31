import React, { useCallback, useEffect, useState } from 'react';

const STATUS_LABELS = {
  queued: '排队', dispatched: '已派发', running: '运行中', done: '完成',
  failed: '失败', blocked: '阻塞', awaiting_input: '等待输入', cancelled: '已取消',
};

export function Tasks({ client, onError }) {
  const [tasks, setTasks] = useState([]);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [events, setEvents] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ type: 'code', prompt: '', project_id: '' });

  const reload = useCallback(async () => {
    try {
      const result = await client.tasks({ status: status || null });
      setTasks(result.tasks ?? []);
    } catch (error) {
      onError(error.message);
    }
  }, [client, status, onError]);

  useEffect(() => { reload(); }, [reload]);

  async function open(taskId) {
    setSelected(taskId);
    setEvents([]);
    try {
      const result = await client.taskEvents(taskId);
      setEvents(result.events ?? []);
    } catch (error) {
      onError(error.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.prompt.trim()) return;
    try {
      await client.createTask({
        type: form.type,
        brief: { prompt: form.prompt.trim() },
        project_id: form.project_id.trim() || null,
      });
      setForm((value) => ({ ...value, prompt: '' }));
      setCreating(false);
      await reload();
    } catch (error) {
      onError(error.message);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <button className="primary" onClick={() => setCreating((value) => !value)}>
          {creating ? '收起' : '新建任务'}
        </button>
        <button className="ghost" onClick={reload}>刷新</button>
      </div>

      {creating && (
        <form className="card form" onSubmit={submit}>
          <label>
            类型
            <input value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} />
          </label>
          <label>
            项目（留空 = default，仅由本节点执行）
            <input value={form.project_id} onChange={(event) => setForm({ ...form, project_id: event.target.value })} placeholder="default" />
          </label>
          <label>
            任务说明
            <textarea
              rows={3}
              value={form.prompt}
              onChange={(event) => setForm({ ...form, prompt: event.target.value })}
              placeholder="要做什么"
            />
          </label>
          <button className="primary" type="submit">创建</button>
        </form>
      )}

      <table className="list">
        <thead>
          <tr><th>任务</th><th>状态</th><th>项目</th><th>执行节点</th><th>创建时间</th></tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.task_id}
              className={selected === task.task_id ? 'selected' : ''}
              onClick={() => open(task.task_id)}
            >
              <td>{task.title || task.brief?.prompt?.slice(0, 48) || task.task_id}</td>
              <td><span className={`pill pill-${task.status}`}>{STATUS_LABELS[task.status] ?? task.status}</span></td>
              <td>{task.project_id ?? '-'}</td>
              <td>{task.executor_node_id ?? '-'}</td>
              <td className="dim">{(task.created_at ?? '').replace('T', ' ').slice(0, 19)}</td>
            </tr>
          ))}
          {!tasks.length && <tr><td colSpan={5} className="dim">没有任务</td></tr>}
        </tbody>
      </table>

      {selected && (
        <section className="card">
          <h3>事件 · {selected}</h3>
          <ul className="events">
            {events.map((event) => (
              <li key={event.event_id}>
                <span className="dim">#{event.seq}</span> <b>{event.type}</b>
                <span className="dim"> {event.ts}</span>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </li>
            ))}
            {!events.length && <li className="dim">没有事件</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
