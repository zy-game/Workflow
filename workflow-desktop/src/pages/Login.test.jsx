// Login.test.jsx - renders the login form and drives a real submit so
// missing imports or broken handlers (the class of bug that used to hang
// the form forever) fail the test instead of the user.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Login } from './Login.jsx';

function jsonResponse(ok, status, body) {
  return { ok, status, json: async () => body };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('Login page', () => {
  it('submits credentials to the configured core and hands over the session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(true, 200, { access_token: 'wfc-demo' }));
    vi.stubGlobal('fetch', fetchMock);
    const onLogin = vi.fn();
    const user = userEvent.setup();
    render(<Login onLogin={onLogin} />);

    await user.type(screen.getByPlaceholderText(/127\.0\.0\.1/), 'http://127.0.0.1:8710');
    await user.type(screen.getByLabelText(/邮箱/), 'demo@workflow.local');
    await user.type(screen.getByLabelText(/密码/), 'demo-workflow-12345');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(onLogin).toHaveBeenCalledWith('http://127.0.0.1:8710', 'wfc-demo');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8710/api/v1/auth/client-login');
    expect(options.method).toBe('POST');
  });

  it('shows a visible error and resets the button on rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const onLogin = vi.fn();
    const user = userEvent.setup();
    render(<Login onLogin={onLogin} />);

    await user.type(screen.getByLabelText(/邮箱/), 'demo@workflow.local');
    await user.type(screen.getByLabelText(/密码/), 'demo-workflow-12345');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText(/无法访问|超时/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    expect(onLogin).not.toHaveBeenCalled();
  });
});
