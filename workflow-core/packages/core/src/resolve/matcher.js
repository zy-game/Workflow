// resolve/matcher.js - the deterministic half of reference resolution.
//
// A project carries human-facing names in its metadata: aliases, keywords and
// a description. Matching is deliberately literal (normalized substring), so
// the model is only consulted when the words themselves are ambiguous.
export const MAX_MATCHES = 5;

// Lowercase, drop punctuation and collapse whitespace: "登录那块" and "登录 那块"
// must normalize the same way.
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

export function projectTerms(project) {
  const metadata = project?.metadata ?? {};
  const aliases = Array.isArray(metadata.aliases) ? metadata.aliases : [];
  const keywords = Array.isArray(metadata.keywords) ? metadata.keywords : [];
  const terms = [
    ...aliases.map((value) => ({ value, kind: 'alias' })),
    ...keywords.map((value) => ({ value, kind: 'keyword' })),
    { value: project?.name, kind: 'name' },
  ];
  return terms
    .map((term) => ({ ...term, normalized: normalizeText(term.value) }))
    .filter((term) => term.normalized.length >= 2);
}

// Returns the projects whose terms appear in the text, longest match first.
// The score is the matched term length, which is a decent proxy for how
// specific the reference was.
export function matchProjects({ text, projects = [] } = {}) {
  const haystack = normalizeText(text);
  if (!haystack) return [];
  const matches = [];
  for (const project of projects) {
    let best = null;
    for (const term of projectTerms(project)) {
      if (!haystack.includes(term.normalized)) continue;
      if (!best || term.normalized.length > best.matchedOn.length) {
        best = { matchedOn: term.normalized, kind: term.kind };
      }
    }
    if (best) {
      matches.push({
        projectId: project.id,
        projectName: project.name ?? null,
        matchedOn: best.matchedOn,
        matchedKind: best.kind,
        score: best.matchedOn.length,
      });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || String(a.projectId).localeCompare(String(b.projectId)))
    .slice(0, MAX_MATCHES);
}
