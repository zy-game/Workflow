// manager.js - the management AI. Situations go into a central-DSH management
// session; the model answers with structured actions; the core executes them
// with its own authority and records every decision for audit. Execution
// never happens inside DSH.
import crypto from 'node:crypto';
import { analyzeSession } from '../knowledge/extract.js';
import { parseDecisionJson } from './driver.js';

const ACTION_PROMPT = `你是 Workflow Core 的管理 AI，负责调度、纠偏和知识沉淀。当前情况见下文。
只回复一个 JSON 对象，不要多余文字，格式：{"actions":[{"action":"<名称>","args":{...}}]}
可用 action：
- task.create args:{type,brief,priority(0-9),worker_selector?}
- task.cancel args:{task_id,reason}
- knowledge.persist args:{type(pitfall|insight|decision|pattern|constraint),title,body,scope(global|project),tags?}
- knowledge.search args:{query}
- report args:{note}（仅记录观察，不执行变更）
没有需要执行的动作时回复 {"actions":[]}`;

export class ManagementAi {
  constructor({ driver, taskRepository, knowledgeRepository, coreDb, db = null, log = () => {}, enabled = true } = {}) {
    this.driver = driver;
    this.taskRepository = taskRepository;
    this.knowledge = knowledgeRepository;
    this.db = db || coreDb.db;
    this.log = log;
    this.enabled = enabled && Boolean(driver);
    this.optimizeTimer = null;
  }

  get available() {
    return this.enabled && Boolean(this.driver);
  }

  #recordDecision({ topic, decisionJson, applied, error = null }) {
    this.db.prepare(`
      INSERT INTO management_decisions (id, ts, topic, decision_json, applied_json, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `md-${crypto.randomUUID()}`, new Date().toISOString(), topic,
      JSON.stringify(decisionJson ?? { actions: [] }),
      JSON.stringify(applied ?? []), error,
    );
  }

  #execute(action, decisions) {
    const { action: name, args = {} } = action;
    switch (name) {
      case 'task.create': {
        const { task } = this.taskRepository.create({
          type: String(args.type || 'ai.task'),
          brief: args.brief && typeof args.brief === 'object' ? args.brief : { goal: String(args.goal || args.brief || '') },
          priority: Number.isInteger(args.priority) ? args.priority : 5,
          worker_selector: args.worker_selector ?? {},
          created_by: 'ai:manager',
        });
        decisions.push({ action: name, ok: true, task_id: task.task_id });
        break;
      }
      case 'task.cancel': {
        try {
          this.taskRepository.cancel(String(args.task_id), 'ai:manager');
          decisions.push({ action: name, ok: true, task_id: args.task_id });
        } catch (error) {
          decisions.push({ action: name, ok: false, error: error.message });
        }
        break;
      }
      case 'knowledge.persist': {
        const memory = this.knowledge.createMemory({
          type: args.type, title: args.title, body: args.body,
          scope: args.scope === 'global' ? 'global' : 'project',
          projectId: args.scope === 'global' ? null : (args.projectId ?? null),
          tags: args.tags ?? [], keywords: args.keywords ?? [],
          source: 'ai:manager',
        });
        decisions.push({ action: name, ok: true, memory_id: memory.id });
        break;
      }
      case 'knowledge.search': {
        const results = this.knowledge.searchMemories({ query: String(args.query || ''), limit: 5 });
        decisions.push({ action: name, ok: true, count: results.length });
        break;
      }
      case 'report': {
        decisions.push({ action: name, ok: true, note: String(args.note ?? '') });
        break;
      }
      default:
        decisions.push({ action: name, ok: false, error: 'unknown action' });
    }
  }

  // Submit a situation to the management AI and apply its structured decision.
  async decide(topic, situation) {
    if (!this.available) {
      this.#recordDecision({ topic, decisionJson: { actions: [], reason: 'ai-disabled' }, applied: [] });
      return { actions: [], applied: [] };
    }
    let decision = null;
    let error = null;
    try {
      const reply = await this.driver.ask(topic, `${ACTION_PROMPT}\n\n=== 当前情况 ===\n${situation}`);
      decision = parseDecisionJson(reply);
      if (!decision || !Array.isArray(decision.actions)) {
        error = 'reply was not a valid decision object';
      }
    } catch (askError) {
      error = askError.message;
    }
    const applied = [];
    if (decision && !error) {
      for (const action of decision.actions.slice(0, 10)) this.#execute(action, applied);
    }
    this.#recordDecision({ topic, decisionJson: decision, applied, error });
    if (error) this.log(`[ai] decision failed for "${topic}": ${error}`);
    return { actions: decision?.actions ?? [], applied, error };
  }

  // Post-completion review: deterministic extraction over the worker session
  // transcript, persisted when verified. The management AI optionally vets the
  // candidates; on any AI failure the deterministic result stands.
  async reviewCompletedTask(task) {
    const sessionEvents = this.taskRepository.events(task.task_id, { type: 'session_event' })
      .map((event) => event.payload);
    const analysis = analyzeSession({
      task, sessionEvents, repository: this.knowledge, projectId: task.project_id ?? null,
    });
    const report = { task_id: task.task_id, candidates: analysis.candidates?.length ?? 0, persisted: [] };
    if (!analysis.candidates?.length) return report;

    let keep = analysis.candidates.map((_, index) => index);
    if (this.available) {
      try {
        const vetting = await this.driver.ask('knowledge-review', [
          '以下是从一个已完成任务的会话中提取的知识候选。判断每条是否值得长期保留：',
          '必须已验证、非临时性、非可重建事实。只回复 JSON：{"keep":[候选序号]}',
          ...analysis.candidates.map((candidate, index) => `${index}. [${candidate.type}] ${candidate.title}: ${candidate.body.slice(0, 300)}`),
        ].join('\n'));
        const parsed = parseDecisionJson(vetting);
        if (parsed && Array.isArray(parsed.keep)) keep = parsed.keep.filter((index) => Number.isInteger(index) && index >= 0 && index < analysis.candidates.length);
      } catch (error) {
        this.log(`[ai] knowledge vetting unavailable, keeping deterministic set: ${error.message}`);
      }
    }
    for (const index of keep) {
      const candidate = analysis.candidates[index];
      if (candidate.scope === 'project' && !candidate.projectId) continue;
      try {
        const memory = this.knowledge.createMemory({
          type: candidate.type, title: candidate.title, body: candidate.body,
          scope: candidate.scope, projectId: candidate.projectId,
          tags: candidate.tags, keywords: candidate.keywords, source: candidate.source,
        });
        report.persisted.push(memory.id);
      } catch (error) {
        this.log(`[ai] knowledge persist failed: ${error.message}`);
      }
    }
    return report;
  }

  // Scheduled self-optimization: feed task statistics to the management AI
  // and apply its (whitelisted) decisions.
  async runOptimization() {
    const counts = this.taskRepository.countsByStatus();
    const recent = this.taskRepository.list({ limit: 20 });
    const situation = [
      `任务统计：${JSON.stringify(counts)}`,
      `最近任务：${recent.map((task) => `${task.task_id.slice(0, 8)}(${task.status},p${task.priority})`).join(', ')}`,
      '请复盘调度质量：失败/死信是否过多？优先级是否需要调整？可创建低优先级改进任务或沉淀知识。',
    ].join('\n');
    return this.decide('self-optimization', situation);
  }

  startOptimizationLoop(intervalMs = 60 * 60 * 1000) {
    if (this.optimizeTimer || !this.available) return;
    this.optimizeTimer = setInterval(() => {
      this.runOptimization().catch((error) => this.log(`[ai] optimization run failed: ${error.message}`));
    }, intervalMs);
    this.optimizeTimer.unref();
  }

  stop() {
    if (this.optimizeTimer) clearInterval(this.optimizeTimer);
    this.optimizeTimer = null;
  }
}
