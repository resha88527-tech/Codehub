import { isSessionError, processNextChapter } from '../solver.js';
import { getQureoClient } from '../session.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'method_not_allowed' });
  }

  const client = getQureoClient(request);
  if (!client) return response.status(401).json({ error: 'session_required' });

  try {
    const result = await processNextChapter(client);
    return response.status(200).json(result);
  } catch (error) {
    if (isSessionError(error)) return response.status(401).json({ error: 'session_expired' });
    return response.status(502).json({
      error: 'processing_failed',
      message: error?.status === 403 ? 'أكمل متطلبات المنصة أولاً ثم أعد المحاولة.' : 'تعذر إكمال الخطوة الحالية.'
    });
  }
}
