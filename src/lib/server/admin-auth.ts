import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Cookies, RequestEvent } from '@sveltejs/kit';

export const ADMIN_COOKIE = 'jemecompte_gui';
export const ADMIN_SESSION_SECONDS = 60 * 60;
export const ADMIN_IDLE_SECONDS = 15 * 60;
const MAX_ADMIN_SESSIONS = 128;
// A session must have been issued by this process. Restarting or logging out revokes it.
// This small, bounded registry requires one application instance.
const sessions = new Map<string, { expiresAt: number; lastSeenAt: number }>();
const HASH_PREFIX = 'scrypt$131072$8$1$';
const HASH_PATTERN = /^scrypt\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < 16 || password.length > 256) throw new Error('Use a password between 16 and 256 characters.');
  const salt = randomBytes(16);
  return `${HASH_PREFIX}${salt.toString('base64url')}$${(await derive(password, salt)).toString('base64url')}`;
}

function configuration(): { hash: string; secret: string } | undefined {
  const hash = process.env.ADMIN_PASSWORD_HASH ?? '';
  const secret = process.env.ADMIN_SESSION_SECRET ?? '';
  if (!HASH_PATTERN.test(hash) || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) return;
  return { hash, secret };
}

export function adminConfigured(): boolean { return configuration() !== undefined; }

export async function verifyAdminPassword(password: unknown): Promise<boolean> {
  const config = configuration();
  if (!config || typeof password !== 'string' || password.length < 16 || password.length > 256) return false;
  const match = HASH_PATTERN.exec(config.hash)!;
  const key = await derive(password, Buffer.from(match[1]!, 'base64url'));
  return timingSafeEqual(key, Buffer.from(match[2]!, 'base64url'));
}

function signature(payload: string, config: { hash: string; secret: string }): string {
  // Rotating either variable invalidates every existing session.
  return createHmac('sha256', config.secret).update('gui-session\0').update(config.hash).update('\0').update(payload).digest('base64url');
}

export function createAdminSession(now = Date.now()): string {
  const config = configuration();
  if (!config) throw new Error('Private administration is not configured.');
  const seconds = Math.floor(now / 1000);
  for (const [token, session] of sessions) {
    if (session.expiresAt <= seconds || session.lastSeenAt + ADMIN_IDLE_SECONDS <= seconds) sessions.delete(token);
  }
  if (sessions.size >= MAX_ADMIN_SESSIONS) throw new Error('Administrative session capacity reached.');
  const expiresAt = seconds + ADMIN_SESSION_SECONDS;
  const payload = `v1.${expiresAt}.${randomBytes(16).toString('base64url')}`;
  const token = `${payload}.${signature(payload, config)}`;
  sessions.set(token, { expiresAt, lastSeenAt: seconds });
  return token;
}

export function validAdminSession(value: string | undefined, now = Date.now()): boolean {
  const config = configuration();
  if (!config || !value || value.length > 150) return false;
  const match = /^(v1\.([0-9]{10,12})\.[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const expiry = Number(match[2]);
  const seconds = Math.floor(now / 1000);
  if (expiry <= seconds || expiry > seconds + ADMIN_SESSION_SECONDS) return false;
  const supplied = Buffer.from(match[3]!, 'base64url');
  const expected = Buffer.from(signature(match[1]!, config), 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  const session = sessions.get(value);
  if (!session) return false;
  if (session.expiresAt !== expiry || session.lastSeenAt + ADMIN_IDLE_SECONDS <= seconds) {
    sessions.delete(value);
    return false;
  }
  session.lastSeenAt = seconds;
  return true;
}

export function revokeAdminSession(value: string | undefined): void {
  if (value) sessions.delete(value);
}

export function adminAuthenticated(cookies: Pick<Cookies, 'get'>): boolean {
  return validAdminSession(cookies.get(ADMIN_COOKIE));
}

export function setAdminSession(event: Pick<RequestEvent, 'cookies' | 'url'>): void {
  const origin = new URL(process.env.ORIGIN || event.url.origin);
  revokeAdminSession(event.cookies.get(ADMIN_COOKIE));
  event.cookies.set(ADMIN_COOKIE, createAdminSession(), {
    path: '/gui', httpOnly: true, sameSite: 'strict', secure: origin.protocol === 'https:', maxAge: ADMIN_SESSION_SECONDS
  });
}

export function clearAdminSession(cookies: Pick<Cookies, 'get' | 'delete'>): void {
  revokeAdminSession(cookies.get(ADMIN_COOKIE));
  cookies.delete(ADMIN_COOKIE, { path: '/gui' });
}

/** Bounded, process-local attempt budget. Raw addresses are never retained. */
export class AdminLoginLimiter {
  private readonly secret = randomBytes(32);
  private peers = new Map<string, { attempts: number; expiresAt: number }>();
  private global = { attempts: 0, expiresAt: 0 };
  private active = false;

  acquire(address: string, now = Date.now(), operation: 'login' | 'delete' = 'login'): (() => void) | undefined {
    for (const [key, bucket] of this.peers) if (bucket.expiresAt <= now) this.peers.delete(key);
    if (this.global.expiresAt <= now) this.global = { attempts: 0, expiresAt: now + 60_000 };
    const key = createHmac('sha256', this.secret).update(operation).update('\0').update(address).digest('base64url');
    let peer = this.peers.get(key);
    if (this.active || this.global.attempts >= 30 || (peer && peer.attempts >= 5)) return;
    if (!peer) {
      if (this.peers.size >= 256) return;
      peer = { attempts: 0, expiresAt: now + 60_000 };
      this.peers.set(key, peer);
    }
    peer.attempts++;
    this.global.attempts++;
    this.active = true;
    let released = false;
    return () => { if (!released) { released = true; this.active = false; } };
  }
}

export const adminLoginLimiter = new AdminLoginLimiter();
