// api.test.js - unit coverage for the desktop API client seam: session
// storage, bearer attachment, error mapping, and endpoint shapes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CoreClient, clearSession, loadDshUrl, loadSession, saveDshUrl, saveSession } from './api.js';

function jsonResponse(ok, status, body) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe('session storage', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('saves and reloads a session, trimming trailing slashes', () => {
    saveSession('https://core.example:8710///', 'wfc-token');
    expect(loadSession()).toEqual({ baseUrl: 'https://core.example:8710', token: 'wfc-token' });
    clearSession();
    expect(loadSession().token).toBe('');
  });

  it('stores the DSH web url trimmed and clears it on empty input', () => {
    expect(saveDshUrl('  http://127.0.0.1:8080//')).toBe('http://127.0.0.1:8080');
    expect(loadDshUrl()).toBe('http://127.0.0.1:8080');
    expect(saveDshUrl('')).toBe('');
    expect(loadDshUrl()).toBe('');
  });
});

describe('CoreClient', () => {
  beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('login posts credentials and adopts the returned bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, 200, { access_token: 'wfc-new' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://127.0.0.1:8710/');
    const token = await client.login('a@example.com', 'secret');
    expect(token).toBe('wfc-new');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8710/api/v1/auth/client-login');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ email: 'a@example.com', password: 'secret' });
  });

  it('attaches the bearer token and builds filtered task queries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, 200, { tasks: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://core', 'wfc-t');
    await client.tasks({ status: 'queued', project_id: 'proj-1', limit: 50 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://core/api/v1/tasks?status=queued&project_id=proj-1&limit=50');
    expect(options.headers.authorization).toBe('Bearer wfc-t');
    expect(options.headers['content-type']).toBe('application/json');
  });

  it('maps structured API failures to ApiError and clears session on 401', async () => {
    saveSession('http://core', 'wfc-stale');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(false, 401, { code: 'auth_required', error: 'expired' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://core', 'wfc-stale');
    await expect(client.adminPeers()).rejects.toMatchObject({
      status: 401,
      code: 'auth_required',
    });
    await expect(client.adminPeers()).rejects.toBeInstanceOf(ApiError);
    expect(loadSession().token).toBe('');
  });

  it('wraps transport failures as network_error without losing the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const client = new CoreClient('http://core', 'wfc-t');
    await expect(client.tasks()).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('peer operations target the admin routes with the node id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, 200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoreClient('http://core', 'wfc-t');
    await client.revokePeer('node-beta');
    await client.activatePeer('node-beta');
    await client.syncStatus();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://core/api/v1/admin/peers/node-beta/revoke',
      'http://core/api/v1/admin/peers/node-beta/activate',
      'http://core/api/v1/admin/peer-sync',
    ]);
  });
});
