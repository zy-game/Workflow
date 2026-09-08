// ai/json-array.js - models wrap JSON in prose or fences often enough that both
// the memory keeper and the judgment loop need the same tolerant extraction.
// Tolerance stops at the parse: anything that is not an array of objects is
// discarded rather than guessed at.
export function extractJsonArray(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}
