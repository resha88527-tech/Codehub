import { buildClearedSessionCookie } from '../session.js';

export default function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Set-Cookie', buildClearedSessionCookie(request));
  return response.status(204).end();
}
