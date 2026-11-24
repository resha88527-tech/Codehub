export const PORTAL_ORIGIN = 'https://me-portal.qureo.education';
export const LEARNING_ORIGIN = 'https://me-tp.qureo.education';

export class QureoError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'QureoError';
    this.status = status;
    this.code = code;
  }
}

function splitSetCookie(value) {
  return value.split(/,(?=\s*[^;,=\s]+=)/g).map(item => item.trim()).filter(Boolean);
}

function parseSetCookie(value, host) {
  const parts = value.split(';').map(part => part.trim());
  const first = parts.shift();
  if (!first || !first.includes('=')) return null;

  const separator = first.indexOf('=');
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1).trim();
  if (!name || /[\r\n]/.test(name + cookieValue)) return null;

  const attributes = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    const key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
    const attributeValue = index < 0 ? true : part.slice(index + 1).trim();
    attributes[key] = attributeValue;
  }

  return {
    name,
    value: cookieValue,
    domain: typeof attributes.domain === 'string' ? attributes.domain.replace(/^\./, '').toLowerCase() : '',
    path: typeof attributes.path === 'string' ? attributes.path : '/',
    host: host.toLowerCase(),
    secure: attributes.secure === true
  };
}

export function getSetCookies(response, origin) {
  const host = new URL(origin).hostname;
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : splitSetCookie(response.headers.get('set-cookie') || '');

  return values.map(value => parseSetCookie(value, host)).filter(Boolean);
}

function domainMatches(cookie, hostname) {
  if (cookie.domain) {
    return hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
  }
  return cookie.host === hostname;
}

export function createQureoClient(cookies, fetchImpl = fetch) {
  const safeCookies = Array.isArray(cookies) ? cookies : [];

  async function request(origin, path, { method = 'GET', body, timeout = 20000, allow = [] } = {}) {
    const url = new URL(path, origin);
    const hostname = url.hostname;
    const cookieHeader = safeCookies
      .filter(cookie => domainMatches(cookie, hostname))
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new QureoError('انتهت مهلة الاتصال بمنصة Qureo.', 504, 'timeout');
      }
      throw new QureoError('تعذر الاتصال بمنصة Qureo.', 502, 'network');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok && !allow.includes(response.status)) {
      const code = data?.not_fulfill_preconditions
        ? 'preconditions'
        : data?.not_contracted
          ? 'not_contracted'
          : response.status === 401
            ? 'unauthorized'
            : 'request_failed';
      throw new QureoError('رفضت منصة Qureo الطلب.', response.status, code);
    }

    return { response, data, text };
  }

  return {
    portal(path, options) {
      return request(PORTAL_ORIGIN, path, options);
    },
    learning(path, options) {
      return request(LEARNING_ORIGIN, path, options);
    }
  };
}

export async function loginToQureo(studentId, password, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetchImpl(`${PORTAL_ORIGIN}/oauth2/password-login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ student_id: studentId, password }),
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new QureoError('انتهت مهلة تسجيل الدخول.', 504, 'timeout');
    }
    throw new QureoError('تعذر الاتصال بمنصة Qureo.', 502, 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new QureoError('بيانات الدخول غير صحيحة.', response.status, 'invalid_credentials');
    }
    throw new QureoError('تعذر إكمال تسجيل الدخول عبر Qureo.', response.status, 'request_failed');
  }

  const cookies = getSetCookies(response, PORTAL_ORIGIN);
  if (cookies.length === 0) {
    throw new QureoError('لم تُنشئ المنصة جلسة صالحة.', 502, 'missing_session');
  }

  return cookies;
}
