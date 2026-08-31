// seed-demo.mjs - one-shot demo seeder for the desktop preview: a demo
// account, tasks in every interesting state, a project, and a peer registry.
import fs from 'node:fs';
import { AuthRepository } from '../../workflow-core/packages/core/src/auth/repository.js';
import { CoreDatabase } from '../../workflow-core/packages/core/src/db/core-db.js';
import { WorkflowRepository } from '../../workflow-core/packages/core/src/knowledge/repository.js';
import { createPeerSyncService } from '../../workflow-core/packages/core/src/sync/service.js';
import { TaskRepository } from '../../workflow-core/packages/core/src/tasks/repository.js';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: node seed-demo.mjs <data-dir>');
fs.mkdirSync(dataDir, { recursive: true });

const auth = new AuthRepository({ dataDir });
if (!auth.getAccountByEmail('demo@workflow.local')) {
  try {
    await auth.createAccount({ email: 'demo@workflow.local', password: 'demo-workflow-12345', role: 'admin' });
    console.log('account created: demo@workflow.local');
  } catch (error) {
    if (!/duplicate|exists/i.test(error.message)) throw error;
  }
}
auth.close();

const core = new CoreDatabase({ dataDir });
const tasks = new TaskRepository({ coreDb: core, nodeId: 'node-dev' });
const knowledge = new WorkflowRepository({ filename: `${dataDir}/workflow.db`.replace(/\\/g, '/') });
const sync = createPeerSyncService({ coreDb: core, nodeId: 'node-dev', taskRepository: tasks });

// A project owned by node-beta, and one owned locally.
const shared = knowledge.resolveProject({
  path: 'E:/Workflow', machine: 'dev-box',
  metadata: { owner_node_id: 'node-beta', goal: 'peer 多端协同' },
  name: 'Workflow',
});
const local = knowledge.resolveProject({
  path: 'E:/notes', machine: 'dev-box',
  metadata: { owner_node_id: 'node-dev' },
  name: 'notes',
});
console.log('projects:', shared.id, local.id);

function make({ brief, project = 'default', executor = 'node-dev', priority = 5 }) {
  return tasks.create({
    type: 'code', brief: { prompt: brief }, created_by: 'demo',
    project_id: project, origin_node_id: 'node-dev', executor_node_id: executor,
    priority,
  }).task;
}

const BACKENDS = [{ kind: 'workflow-jsonl', capabilities: [] }];

// Claims use priority ASC ordering: transition targets are created with a
// small priority value so the claim provably lands on the intended task.
function claimExactly(task) {
  const claimed = tasks.claim({ worker_id: 'demo-worker', node_id: 'node-dev', backends: BACKENDS });
  if (claimed?.task_id !== task.task_id) {
    console.error('demo: claim landed on', claimed?.task_id, 'expected', task.task_id);
    return null;
  }
  return claimed;
}

// queued: untouched, visually in the backlog
make({ brief: '整理 knowledge 库的过期记忆', priority: 9 });
make({ brief: '升级 worker 部署脚本到 node 24', project: shared.id, executor: 'node-beta', priority: 9 });

// running with progress
const running = make({ brief: '重构 peer-sync 游标清理', priority: 1 });
const claimedRun = claimExactly(running);
if (claimedRun) {
  tasks.progress(running.task_id, claimedRun.claim_token, { note: '重构完成 60%，正在补测试', percent: 60 });
}

// done
const doneTask = make({ brief: '梳理 DSH 升级差异清单', priority: 1 });
const claimedDone = claimExactly(doneTask);
if (claimedDone) {
  tasks.done(doneTask.task_id, claimedDone.claim_token, { kind: 'done', result: { summary: '清单已写入 docs' } });
}

// cancelled
const cancelled = make({ brief: '尝试旧版 JSONL 迁移路径' });
tasks.cancel(cancelled.task_id, 'demo');

// failed
const failing = make({ brief: '解析损坏的会话数据库', priority: 1 });
const claimedFail = claimExactly(failing);
if (claimedFail) {
  tasks.done(failing.task_id, claimedFail.claim_token, { kind: 'failed', result: { error: 'invalid session db header' } });
}

// peers: one active, one revoked, with stream cursors
sync.registerPeer({ node_id: 'node-beta', endpoint: 'https://beta.example:8710', display_name: 'beta 笔记本' });
sync.recordAck('node-beta', 2);
sync.registerPeer({ node_id: 'node-old', display_name: '旧设备' });
sync.revokePeer('node-old');

console.log('tasks seeded:', tasks.list({ limit: 50 }).length);
console.log('peers:', sync.listPeers().map((peer) => `${peer.node_id}:${peer.status}`).join(', '));
sync.close();
tasks.close();
core.close();
knowledge.close();
console.log('demo data ready at', dataDir);
