// signals/channel-context.js - the recent past of a channel, as a file.
//
// Resolution needs to know what a group was just talking about ("那个 xxxx"
// only means something with the previous line in view), but keeping every
// message forever is both useless and a privacy liability. So the context is
// bounded twice: by age and by line count.
export const CHANNEL_CONTEXT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const CHANNEL_CONTEXT_MAX_LINES = 200;
const MAX_EXCERPT = 160;
const LINE_PATTERN = /^- (\S+) \[([a-z]+)\] /;

export function channelRefToPath(chatRef) {
  const safe = String(chatRef ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
  return `channels/${safe}/recent.md`;
}

export function createChannelContext({
  memoryStore, maxAgeMs = CHANNEL_CONTEXT_MAX_AGE_MS, maxLines = CHANNEL_CONTEXT_MAX_LINES,
} = {}) {
  if (!memoryStore) throw new TypeError('memoryStore is required');

  function readLines(chatRef) {
    const content = memoryStore.read(channelRefToPath(chatRef)) ?? '';
    return content.split('\n').filter((line) => line.startsWith('- '));
  }

  function pruneLines(lines, nowMs) {
    return lines.filter((line) => {
      const match = LINE_PATTERN.exec(line);
      if (!match) return false;
      const at = Date.parse(match[1]);
      // A line we cannot date is kept: losing context is worse than a stale one.
      return Number.isNaN(at) || nowMs - at <= maxAgeMs;
    });
  }

  // Append one observation, pruning expired lines in the same pass so the file
  // cannot grow without bound.
  function append(chatRef, { at = new Date().toISOString(), kind = 'ambient', text = '' } = {}) {
    const excerpt = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT);
    if (!excerpt) return null;
    const nowMs = Date.parse(at) || Date.now();
    const lines = pruneLines([...readLines(chatRef), `- ${at} [${kind}] ${excerpt}`], nowMs).slice(-maxLines);
    memoryStore.write(channelRefToPath(chatRef), `# 渠道上下文\n\n${lines.join('\n')}\n`);
    return lines.length;
  }

  function read(chatRef, { limit = 20 } = {}) {
    const bounded = Math.min(maxLines, Math.max(1, Number(limit) || 20));
    return pruneLines(readLines(chatRef), Date.now())
      .slice(-bounded)
      .map((line) => line.replace(/^- /, ''));
  }

  // The keeper calls this for channels that have gone quiet.
  function prune(chatRef) {
    const lines = readLines(chatRef);
    const kept = pruneLines(lines, Date.now());
    if (kept.length === lines.length) return 0;
    memoryStore.write(channelRefToPath(chatRef), `# 渠道上下文\n\n${kept.join('\n')}${kept.length ? '\n' : ''}`);
    return lines.length - kept.length;
  }

  return { append, read, prune, path: channelRefToPath };
}
