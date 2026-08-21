// crypto.js - scrypt password hashing, opaque tokens, cookie helpers.
// Hash format and parameters are identical to the previous wf-api authority so
// existing account rows keep verifying (scrypt v1, N=32768, r=8, p=1).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const AUTH_SCHEMA_VERSION = 1;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_COOKIE_NAME = '__Host-wfc-admin-session';
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60;
export const CLIENT_TOKEN_PREFIX = 'wfc-';
export const TOKEN_BYTES = 32;
export const SCRYPT_PARAMETERS = Object.freeze({
  version: 1,
  N: 32768,
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024,
});

const COMMON_WEAK_PASSWORDS = new Set([
  '123456789012', 'admin12345678', 'changeme1234', 'letmein123456',
  'password1234', 'password12345', 'qwerty123456', 'welcome12345',
]);

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new TypeError('email must be a string');
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || /[^\x21-\x7e]/.test(email)) {
    throw new TypeError('email has an invalid format');
  }
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) throw new TypeError('email has an invalid format');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new TypeError('email has an invalid format');
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) throw new TypeError('email has an invalid format');
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || labels.some((label) => (
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) throw new TypeError('email has an invalid format');
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) throw new TypeError('email has an invalid format');
  return email;
}

export function validatePassword(password, email = null) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new RangeError(`password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  }
  if (!password.trim()) throw new TypeError('password must not be whitespace-only');
  const folded = password.normalize('NFKC').toLowerCase();
  if (email !== null && folded === normalizeEmail(email).normalize('NFKC')) {
    throw new TypeError('password must not equal the email address');
  }
  if (COMMON_WEAK_PASSWORDS.has(folded) || /^(.)\1{11,}$/.test(folded)) {
    throw new TypeError('password is too common');
  }
  return true;
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return encodeBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function formatPasswordHash(salt, derivedKey) {
  return [
    'scrypt', `v=${SCRYPT_PARAMETERS.version}`,
    `N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}`,
    encodeBase64Url(salt), encodeBase64Url(derivedKey),
  ].join('$');
}

function parsePasswordHash(storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length > 512) return null;
  const parts = storedHash.split('$');
  if (parts.length !== 5 || parts[0] !== 'scrypt' || parts[1] !== 'v=1') return null;
  const parameterMatch = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2]);
  if (!parameterMatch) return null;
  const N = Number(parameterMatch[1]);
  const r = Number(parameterMatch[2]);
  const p = Number(parameterMatch[3]);
  if (N !== SCRYPT_PARAMETERS.N || r !== SCRYPT_PARAMETERS.r || p !== SCRYPT_PARAMETERS.p) return null;
  const salt = decodeBase64Url(parts[3]);
  const derivedKey = decodeBase64Url(parts[4]);
  if (!salt || salt.length !== SCRYPT_PARAMETERS.saltBytes
    || !derivedKey || derivedKey.length !== SCRYPT_PARAMETERS.keyLength) return null;
  return { N, r, p, salt, derivedKey };
}

export async function hashPassword(password, email = null) {
  validatePassword(password, email);
  const salt = crypto.randomBytes(SCRYPT_PARAMETERS.saltBytes);
  const derivedKey = await scrypt(password, salt, SCRYPT_PARAMETERS.keyLength, {
    N: SCRYPT_PARAMETERS.N, r: SCRYPT_PARAMETERS.r, p: SCRYPT_PARAMETERS.p, maxmem: SCRYPT_PARAMETERS.maxmem,
  });
  return formatPasswordHash(salt, derivedKey);
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string') return false;
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) return false;
  try {
    const candidate = await scrypt(password, parsed.salt, parsed.derivedKey.length, {
      N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_PARAMETERS.maxmem,
    });
    return crypto.timingSafeEqual(candidate, parsed.derivedKey);
  } catch {
    return false;
  }
}

export function randomToken(byteLength = TOKEN_BYTES) {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new RangeError('token byte length must be an integer from 16 to 128');
  }
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function digestToken(token) {
  if (typeof token !== 'string' || !token) throw new TypeError('token must be a non-empty string');
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createRandomToken(byteLength = TOKEN_BYTES) {
  const token = randomToken(byteLength);
  return { token, digest: digestToken(token) };
}

export function timingSafeDigestEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function newAccountId() {
  return `acc-${crypto.randomUUID()}`;
}

export function createAccountPrincipal(account) {
  if (!account || typeof account !== 'object') throw new TypeError('account must be an object');
  if (account.status !== 'active') return null;
  return {
    subject_id: `account:${account.account_id}`,
    account_id: account.account_id,
    email: account.email,
    role: account.role,
    project_ids: account.role === 'admin' ? ['*'] : account.project_ids,
    actions: account.role === 'admin' ? ['*'] : account.actions,
    credential_version: account.credential_version,
    auth_type: 'account',
  };
}

export function parseCookies(header) {
  const cookies = Object.create(null);
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (typeof raw !== 'string' || !raw) return cookies;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || Object.hasOwn(cookies, name)) continue;
    const encodedValue = part.slice(separator + 1).trim();
    try { cookies[name] = decodeURIComponent(encodedValue); } catch { cookies[name] = encodedValue; }
  }
  return cookies;
}

export function serializeSessionCookie(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512
    || /[\u0000-\u0020\u007f;,]/.test(sessionId)) {
    throw new TypeError('session id has an invalid format');
  }
  const maxAge = options.maxAge === undefined ? DEFAULT_SESSION_MAX_AGE_SECONDS : options.maxAge;
  if (!Number.isInteger(maxAge) || maxAge <= 0 || maxAge > 24 * 60 * 60) {
    throw new RangeError('cookie maxAge must be an integer from 1 to 86400 seconds');
  }
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function serializeSessionCookieClear() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
