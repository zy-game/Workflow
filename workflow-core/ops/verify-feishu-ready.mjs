const base = (process.argv[2] || 'http://127.0.0.1:18710').replace(/\/$/, '');
const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
const health = await response.json();
const feishu = health?.checks?.feishu;
if (!health?.checks?.auth?.ok || !health?.checks?.core?.ok) {
  throw new Error('Core database health check failed');
}
if (!feishu?.enabled || feishu.state !== 'connected') {
  throw new Error(`Feishu is not ready (state=${feishu?.state ?? 'missing'})`);
}
process.stdout.write('workflow-core ready: databases=ok feishu=connected\n');
