import { createQureoClient, loginToQureo } from '../qureo.js';
import { getProgress } from '../solver.js';
import { buildClearedSessionCookie, buildSessionCookie } from '../session.js';

function json(response, status, body, cookie) {
  response.setHeader('Cache-Control', 'no-store');
  if (cookie) response.setHeader('Set-Cookie', cookie);
  return response.status(status).json(body);
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return json(response, 405, { error: 'method_not_allowed' });
  }

  try {
    const body = await request.json();
    const studentId = typeof body?.student_id === 'string' ? body.student_id.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!studentId || /\s/.test(studentId) || studentId.length > 128 || !password || password.length > 256) {
      return json(response, 400, { error: 'invalid_input' });
    }

    const cookies = await loginToQureo(studentId, password);
    const client = createQureoClient(cookies);
    const userResponse = await client.portal('/oauth2/userinfo');
    const user = userResponse.data?.data && typeof userResponse.data.data === 'object'
      ? userResponse.data.data
      : userResponse.data;
    if (!user?.id) {
      return json(response, 401, { error: 'invalid_credentials' }, buildClearedSessionCookie(request));
    }

    const progress = await getProgress(client);
    const cookie = buildSessionCookie(request, cookies);
    if (cookie.length > 4200) {
      return json(response, 502, { error: 'session_too_large' }, buildClearedSessionCookie(request));
    }

    return json(response, 200, {
      user: { name: user.name || 'طالب Qureo' },
      progress
    }, cookie);
  } catch (error) {
    const invalidCredentials = error?.code === 'invalid_credentials' || error?.status === 401;
    const status = invalidCredentials ? 401 : error?.status === 504 ? 504 : 502;
    const errorCode = status === 401
      ? 'invalid_credentials'
      : status === 504
        ? 'qureo_timeout'
        : error?.code || 'qureo_unavailable';
    return json(response, status, { error: errorCode }, buildClearedSessionCookie(request));
  }
}
