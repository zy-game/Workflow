// extract.js - deterministic knowledge extraction over worker session
// transcripts. Ported from the workflow skill's extract core: secret
// redaction, segmentation, regex classification, rebuildable/uncertain/routine
// filtering, and fingerprint deduplication against repository memories.
import crypto from 'node:crypto';

export const SECRET_PATTERNS = [
  [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]'],
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, '[REDACTED]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]'],
];

export function redactSecrets(value) {
  let text = String(value == null ? '' : value);
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function normalizeContent(value) {
  return redactSecrets(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function fingerprint(value) {
  return crypto.createHash('sha256').update(normalizeContent(value).toLowerCase()).digest('hex').slice(0, 24);
}

export function canonicalFingerprint(type, title, body) {
  return fingerprint(`${type}\n${title}\n${body}`);
}

const CLASSIFIERS = [
  ['decision', /\b(?:decided?|chose|choose|selected?|instead of|because)\b|决定|选择|采用|因为|取舍/i],
  ['constraint', /\b(?:must|must not|cannot|never|only|require[sd]?|constraint)\b|必须|不得|只能|约束|禁止/i],
  ['pitfall', /\b(?:root cause|pitfall|regression|failed because|caused by|fix(?:ed)? by)\b|根因|踩坑|问题在于|失败原因|导致|修复/i],
  ['pattern', /\b(?:pattern|reusable|whenever|always use|standard approach)\b|模式|复用|以后遇到|统一使用|通用做法/i],
  ['insight', /\b(?:learned|discovered|turns out|works by|insight)\b|发现|原来|机制|洞察|验证表明/i],
];

export function classify(text) {
  const match = CLASSIFIERS.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : null;
}

export function segments(text) {
  return normalizeContent(text).split(/\n+|(?<=[.!?。！？])\s+/).map((item) => item.trim()).filter(Boolean);
}

function isRebuildableFact(text) {
  const compact = normalizeContent(text);
  if (/\b(?:must|must not|never|because|root cause|failed|regression|constraint|decision)\b|必须|不得|禁止|因为|根因|失败|约束|决定/i.test(compact)) return false;
  return /\b(?:file|class|function|method|package|version)\s+[\w./\\-]+\s+(?:is|exists|lives|located|defined|declared)\b|(?:文件|类|函数|方法|版本).{0,80}(?:位于|存在|定义在|当前是)/i.test(compact);
}

function isUncertain(text) {
  return /\b(?:maybe|perhaps|possibly|might|could be|not sure|uncertain|guess|appears to)\b|也许|可能|不确定|猜测|似乎/i.test(text);
}

function isRoutine(text) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return !compact || compact.length < 24 || /^(?:done|completed|ok|success|no changes?|tests? passed|已完成|完成|成功|无变化|测试通过)[.!。\s]*$/i.test(compact);
}

function titleFor(type, text) {
  const first = text.split(/\n|(?<=[.!?。！？])\s+/)[0]
    .replace(/^(?:note|finding|result|evidence|decision|constraint)\s*[:：-]?\s*/i, '')
    .trim();
  const fallback = `${type[0].toUpperCase()}${type.slice(1)} from worker session`;
  return (first || fallback).slice(0, 100).replace(/[.!?。！？]+$/, '');
}

function extractKeywords(text) {
  const words = normalizeContent(text).toLowerCase().match(/[a-z][a-z0-9_.-]{2,}|[\u4e00-\u9fff]{2,8}/g) || [];
  const stop = new Set(['the', 'and', 'that', 'with', 'from', 'this', 'were', 'have', 'into', 'because', 'should', '使用', '需要', '这个', '进行', '已经']);
  return [...new Set(words.filter((word) => !stop.has(word)))].slice(0, 10);
}

// Renders worker session events into the (input, result, evidence) triple the
// extraction core expects: input = task brief + user injections, result =
// final assistant conclusions, evidence = tool calls/results and assistant
// working notes. Real DSH wraps message content in typed part arrays
// ({type:'text'|'reasoning', text}); only text parts carry extractable prose.
function textFromContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    return text || null;
  }
  return null;
}

export function sessionToTriple(task, sessionEvents) {
  const brief = task?.brief ?? {};
  const userInput = [`任务目标：${brief.goal ?? task?.type ?? ''}`];
  if (Array.isArray(brief.acceptance) && brief.acceptance.length) {
    userInput.push(`验收标准：${brief.acceptance.join('；')}`);
  }
  const resultParts = [];
  const evidenceParts = [];
  for (const entry of sessionEvents) {
    const event = entry?.event ?? entry?.payload?.event ?? entry;
    const type = String(event?.type ?? '');
    const data = event?.data ?? {};
    const text = typeof data.text === 'string' ? data.text : null;
    if (type === 'user/message' && data.source?.kind !== 'plugin') {
      const userText = text ?? textFromContent(data.content);
      if (userText && !userText.startsWith('任务目标')) userInput.push(`用户纠正：${userText}`);
    } else if (type === 'assistant/message') {
      const messageText = text ?? textFromContent(data.message?.content) ?? textFromContent(data.content);
      if (messageText) resultParts.push(messageText);
    } else if (type === 'tool/call') {
      evidenceParts.push(`tool ${data.tool ?? event?.tool ?? 'unknown'}: ${JSON.stringify(data.args ?? event?.args ?? {}).slice(0, 300)}`);
    } else if (type === 'tool/result') {
      evidenceParts.push(`tool result: ${String(text ?? JSON.stringify(data)).slice(0, 300)}`);
    }
  }
  if (task?.result?.summary) resultParts.push(String(task.result.summary));
  return {
    input: userInput.join('\n'),
    result: resultParts.join('\n'),
    evidence: evidenceParts.join('\n'),
  };
}

// Deterministic candidate analysis; duplicates are matched by canonical
// fingerprint against existing repository memories.
export function analyzeSession({ task, sessionEvents, repository, projectId = null }) {
  const { input, result, evidence } = sessionToTriple(task, sessionEvents);
  const combined = [input, result, evidence].filter(Boolean).join('\n');
  if (isRoutine(combined) || isUncertain(combined)) return { ok: true, action: 'analyze', candidates: [], filtered: 'ordinary-or-uncertain' };
  if (!evidence && !/\b(?:verified|confirmed|test(?:ed)?|proved|root cause)\b|已验证|确认|证据|根因/i.test(result)) {
    return { ok: true, action: 'analyze', candidates: [], filtered: 'insufficient-evidence' };
  }
  const resultSegments = segments(result);
  const evidenceSegments = segments(evidence);
  const candidateSegments = resultSegments.filter((segment) => classify(segment) || isRebuildableFact(segment));
  const canonical = projectId
    ? [...repository.listMemories({ scope: 'global', all: true }), ...repository.listMemories({ scope: 'project', projectId, all: true })]
    : repository.listMemories({ scope: 'global', all: true });
  const known = new Set(canonical.map((memory) => canonicalFingerprint(memory.type || '', memory.title || '', memory.body || '')));
  const candidates = [];
  let rebuildable = 0;
  let deduplicated = 0;
  for (const segment of candidateSegments) {
    if (isRebuildableFact(segment)) { rebuildable += 1; continue; }
    if (isUncertain(segment)) continue;
    const type = classify(segment);
    const matchingEvidence = evidenceSegments.filter((item) => classify(item) === type || extractKeywords(item).some((word) => segment.toLowerCase().includes(word))).slice(0, 2);
    const body = normalizeContent([segment, matchingEvidence.length ? `Evidence: ${matchingEvidence.join(' ')}` : evidence && `Evidence: ${evidence}`].filter(Boolean).join('\n\n'));
    const candidate = {
      type,
      title: titleFor(type, segment),
      body,
      tags: extractKeywords(input).slice(0, 5),
      keywords: extractKeywords(`${segment} ${matchingEvidence.join(' ')}`),
      scope: projectId ? 'project' : 'global',
      projectId: projectId ?? null,
      confidence: 'high',
      verified: /\b(?:verified|confirmed|test(?:ed)?|proved|preserved|passed)\b|已验证|确认|测试通过/i.test(`${segment} ${matchingEvidence.join(' ')} ${evidence}`),
      source: `worker-task:${task?.task_id ?? 'unknown'}`,
    };
    candidate.fingerprint = canonicalFingerprint(candidate.type, candidate.title, candidate.body);
    if (known.has(candidate.fingerprint)) { deduplicated += 1; continue; }
    if (candidates.some((item) => item.fingerprint === candidate.fingerprint)) { deduplicated += 1; continue; }
    candidates.push(candidate);
  }
  if (!candidateSegments.length) return { ok: true, action: 'analyze', candidates: [], filtered: 'no-durable-signal' };
  return { ok: true, action: 'analyze', candidates, stats: { rebuildable, deduplicated, segments: candidateSegments.length } };
}

export const EXTRACT_TYPES = new Set(['pitfall', 'insight', 'decision', 'pattern', 'constraint']);
