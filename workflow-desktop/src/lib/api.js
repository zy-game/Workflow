// api.js - the single seam between the desktop UI and Workflow Core.
// Plain fetch over CORS (Core allow-lists the shell origin); the bearer
// token from client-login is held in memory and localStorage per host.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'workflow.core.token';
const BASE_KEY = 'workflow.core.base';
const DSH_KEY = 'workflow.dsh.base';

// Same-origin mode: an empty base URL keeps requests on the page's own
// origin (vite dev proxy); desktop builds point at the full Core URL.
const REQUEST_TIMEOUT_MS = 15_000;

export function loadSession() {
  return {
    baseUrl: localStorage.getItem(BASE_KEY) || '',
    token: localStorage.getItem(TOKEN_KEY) || '',
  };
}

export function saveSession(baseUrl, token) {
  localStorage.setItem(BASE_KEY, baseUrl.replace(/\/+$/, ''));
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
}

export function loadDshUrl() {
  return localStorage.getItem(DSH_KEY) || '';
}

export function saveDshUrl(url) {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '');
  if (trimmed) localStorage.setItem(DSH_KEY, trimmed);
  else localStorage.removeItem(DSH_KEY);
  return trimmed;
}

export class CoreClient {
  constructor(baseUrl, token = null, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.baseUrl = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  static fromSession() {
    const { baseUrl, token } = loadSession();
    if (!token) return null;
    return new CoreClient(baseUrl, token);
  }

  async request(path, { method = 'GET', body = undefined } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ApiError(0, 'timeout', `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：${this.baseUrl || '同源'}${path}`);
      }
      throw new ApiError(0, 'network_error', `无法访问 ${this.baseUrl || '同源服务'}: ${error.message}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && this.token) clearSession();
      throw new ApiError(response.status, payload.code ?? 'request_failed', payload.error ?? payload.code);
    }
    return payload;
  }

  async login(email, password) {
    const result = await this.request('/api/v1/auth/client-login', {
      method: 'POST',
      body: { email, password },
    });
    this.token = result.access_token;
    return result.access_token;
  }

  tasks({ status = null, project_id = null, limit = 100 } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (project_id) params.set('project_id', project_id);
    if (limit) params.set('limit', String(limit));
    const suffix = params.toString() ? `?${params}` : '';
    return this.request(`/api/v1/tasks${suffix}`);
  }

  task(taskId) {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  taskEvents(taskId, afterSeq = -1) {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/events?after_seq=${afterSeq}`);
  }

  createTask({ type, brief, project_id = null, priority = 5 }) {
    return this.request('/api/v1/tasks', {
      method: 'POST',
      body: { type, brief, project_id, priority },
    });
  }

  projects() {
    return this.request('/api/v1/workflow/projects');
  }

  adminPeers() {
    return this.request('/api/v1/admin/peers');
  }

  revokePeer(nodeId) {
    return this.request(`/api/v1/admin/peers/${encodeURIComponent(nodeId)}/revoke`, { method: 'POST' });
  }

  activatePeer(nodeId) {
    return this.request(`/api/v1/admin/peers/${encodeURIComponent(nodeId)}/activate`, { method: 'POST' });
  }

  syncStatus() {
    return this.request('/api/v1/admin/peer-sync');
  }
}
