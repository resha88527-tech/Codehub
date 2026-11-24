import { getProgress, isSessionError } from '../solver.js';
import { getQureoClient } from '../session.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const client = getQureoClient(request);
  if (!client) return response.status(401).json({ error: 'session_required' });

  try {
    const progress = await getProgress(client);
    return response.status(200).json({ progress });
  } catch (error) {
    if (isSessionError(error)) return response.status(401).json({ error: 'session_expired' });
    return response.status(502).json({ error: 'qureo_unavailable' });
  }
}
