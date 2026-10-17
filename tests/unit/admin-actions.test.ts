import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const auth = vi.hoisted(() => ({ configured: vi.fn(), authenticated: vi.fn(), acquire: vi.fn(), verify: vi.fn(), set: vi.fn(), clear: vi.fn() }));
const database = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/lib/server/admin-auth', () => ({
  adminConfigured: auth.configured, adminAuthenticated: auth.authenticated, adminLoginLimiter: { acquire: auth.acquire },
  verifyAdminPassword: auth.verify, setAdminSession: auth.set, clearAdminSession: auth.clear
}));
vi.mock('../../src/lib/server/admin-events', () => ({ listAdminEvents: database.list, deleteAdminEvent: database.remove }));
import { actions, load } from '../../src/routes/gui/+page.server';

const origin = 'http://127.0.0.1:5175';
const id = 'ea935eb8-2a5f-4802-b7be-5c2ec116c71a';
function event(fields: Record<string, string> = {}, requestOrigin = origin): RequestEvent {
  return { request: new Request(`${origin}/gui`, { method: 'POST', headers: { origin: requestOrigin }, body: new URLSearchParams(fields) }),
    url: new URL(`${origin}/gui`), cookies: {}, getClientAddress: () => '127.0.0.1', setHeaders: vi.fn() } as unknown as RequestEvent;
}
const action = (name: keyof typeof actions, value: RequestEvent) => actions[name]!(value as never);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ORIGIN', origin);
  auth.configured.mockReturnValue(true);
  auth.authenticated.mockReturnValue(false);
  auth.acquire.mockReturnValue(vi.fn());
});
afterEach(() => vi.unstubAllEnvs());

describe('private GUI actions', () => {
  it('does not read the database or delete anything without a valid session', async () => {
    const result = await load(event() as never);
    expect(result).toMatchObject({ configured: true, authenticated: false, events: [] });
    expect(database.list).not.toHaveBeenCalled();
    expect(await action('delete', event({ eventId: id, confirmation: 'slug' }))).toMatchObject({ status: 401 });
    expect(database.remove).not.toHaveBeenCalled();
  });

  it('rejects foreign origin even with a valid session before parsing or deleting', async () => {
    auth.authenticated.mockReturnValue(true);
    expect(await action('delete', event({ eventId: id, confirmation: 'slug' }, 'https://evil.example'))).toMatchObject({ status: 403 });
    expect(await action('login', event({ adminPassword: 'a-private-password' }, 'https://evil.example'))).toMatchObject({ status: 403 });
    expect(database.remove).not.toHaveBeenCalled();
    expect(auth.acquire).not.toHaveBeenCalled();
  });

  it('does not authenticate for missing configuration, incorrect password or exhausted budget', async () => {
    auth.configured.mockReturnValue(false);
    expect(await action('login', event({ adminPassword: 'a-private-password' }))).toMatchObject({ status: 503 });
    expect(auth.verify).not.toHaveBeenCalled();
    auth.configured.mockReturnValue(true);
    auth.verify.mockResolvedValue(false);
    const response = await action('login', event({ adminPassword: 'wrong-private-password' }));
    expect(response).toMatchObject({ status: 400 });
    expect(JSON.stringify(response)).not.toContain('wrong-private-password');
    expect(auth.set).not.toHaveBeenCalled();
    auth.acquire.mockReturnValue(undefined);
    expect(await action('login', event({ adminPassword: 'a-private-password' }))).toMatchObject({ status: 429 });
  });

  it('creates a session then redirects to /gui without reflecting the password', async () => {
    auth.verify.mockResolvedValue(true);
    await expect(action('login', event({ adminPassword: 'a-private-password' }))).rejects.toMatchObject({ status: 303, location: '/gui' });
    expect(auth.set).toHaveBeenCalledOnce();
    expect(auth.acquire.mock.results[0]!.value).toHaveBeenCalledOnce();
    await expect(action('logout', event())).rejects.toMatchObject({ status: 303, location: '/gui' });
    expect(auth.clear).toHaveBeenCalledOnce();
  });

  it('requires the service to confirm the slug, reports only sanitized errors, and preserves public confirmation', async () => {
    auth.authenticated.mockReturnValue(true);
    auth.verify.mockResolvedValue(true);
    database.remove.mockResolvedValueOnce({ status: 'confirmation_mismatch' });
    expect(await action('delete', event({ eventId: id, confirmation: 'wrong-slug' }))).toMatchObject({ status: 400, data: { failedEventId: id, confirmation: 'wrong-slug' } });
    database.remove.mockRejectedValueOnce(new Error('SQL containing sensitive information'));
    const failed = await action('delete', event({ eventId: id, confirmation: 'right-slug' }));
    expect(failed).toMatchObject({ status: 503 });
    expect(JSON.stringify(failed)).not.toContain('SQL');
    database.remove.mockResolvedValueOnce({ status: 'deleted', eventId: id });
    expect(await action('delete', event({ eventId: id, confirmation: 'right-slug' }))).toMatchObject({ deletedId: id });
    expect(database.remove).toHaveBeenLastCalledWith(id, 'right-slug', { operator: 'gui-owner', reason: expect.any(String) });
  });

  it('requires a password again before a destructive action even with a valid copied session', async () => {
    auth.authenticated.mockReturnValue(true);
    auth.verify.mockResolvedValue(false);
    expect(await action('delete', event({ eventId: id, confirmation: 'slug' }))).toMatchObject({ status: 400 });
    expect(auth.verify).toHaveBeenCalledWith(null);
    expect(database.remove).not.toHaveBeenCalled();
    const failed = await action('delete', event({ eventId: id, confirmation: 'slug', adminPassword: 'incorrect-password-for-delete' }));
    expect(failed).toMatchObject({ status: 400, data: { failedEventId: id, confirmation: 'slug' } });
    expect(JSON.stringify(failed)).not.toContain('incorrect-password-for-delete');
    expect(auth.verify).toHaveBeenCalledWith('incorrect-password-for-delete');
    expect(database.remove).not.toHaveBeenCalled();
    expect(auth.acquire.mock.results[0]!.value).toHaveBeenCalledTimes(2);
    auth.acquire.mockReturnValue(undefined);
    expect(await action('delete', event({ eventId: id, confirmation: 'slug', adminPassword: 'another-password' }))).toMatchObject({ status: 429 });
    expect(auth.verify).toHaveBeenCalledTimes(2);
  });

  it('rechecks session revocation after password verification before deleting', async () => {
    auth.authenticated.mockReturnValueOnce(true).mockReturnValue(false);
    auth.verify.mockResolvedValue(true);
    expect(await action('delete', event({ eventId: id, confirmation: 'slug', adminPassword: 'private-password' }))).toMatchObject({ status: 401 });
    expect(database.remove).not.toHaveBeenCalled();
    expect(auth.acquire.mock.results[0]!.value).toHaveBeenCalledOnce();
  });
});
