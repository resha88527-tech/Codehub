import { createQureoClient } from './qureo.js';

const SESSION_COOKIE = 'codehub_qureo_session';
const MAX_AGE = 60 * 60 * 8;

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || !Array.isArray(parsed.cookies) || parsed.cookies.length > 30) return null;
    const valid = parsed.cookies.every(cookie =>
      cookie &&
      typeof cookie.name === 'string' &&
      typeof cookie.value === 'string' &&
      cookie.name.length > 0 &&
      cookie.name.length < 100 &&
      cookie.value.length < 4000 &&
      !/[\r\n]/.test(cookie.name + cookie.value)
    );
    return valid ? parsed.cookies : null;
  } catch {
    return null;
  }
}

export function getSessionCookies(request) {
  const header = request.headers?.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return decode(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function getQureoClient(request) {
  const cookies = getSessionCookies(request);
  return cookies ? createQureoClient(cookies) : null;
}

export function buildSessionCookie(request, cookies) {
  const value = encode({ v: 1, cookies });
  const forwardedProtocol = request.headers?.['x-forwarded-proto'];
  const secure = forwardedProtocol === 'https' || String(request.url || '').startsWith('https://');
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}

export function buildClearedSessionCookie(request) {
  const forwardedProtocol = request.headers?.['x-forwarded-proto'];
  const secure = forwardedProtocol === 'https' || String(request.url || '').startsWith('https://');
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
