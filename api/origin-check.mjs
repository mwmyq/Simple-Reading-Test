import { request } from 'node:https';

// Preview-only probe. It sends no reader cookies, credentials, or writes.
export default {
  async fetch(incoming) {
    const headers = { 'Cache-Control': 'no-store' };
    if (process.env.VERCEL_ENV !== 'preview' || incoming.method !== 'GET') {
      return new Response(null, { status: 404, headers });
    }

    const check = (path, expectedStatus) => new Promise((resolve) => {
      const req = request({
        hostname: '43.161.216.193',
        servername: 'gujiyuedu.site',
        path,
        headers: { Host: 'gujiyuedu.site' },
        signal: AbortSignal.timeout(6000),
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode === expectedStatus }));
        res.on('error', () => resolve({ ok: false }));
      });
      req.on('error', () => resolve({ ok: false }));
      req.end();
    });

    const [homepage, anonymousExport] = await Promise.all([
      check('/', 200),
      check('/api/pilot/export?table=runs', 401),
    ]);
    const blocked = anonymousExport.status === 401 || anonymousExport.status === 403;
    return Response.json({ homepage, anonymousExport: { status: anonymousExport.status, blocked } }, {
      status: homepage.ok && blocked ? 200 : 502,
      headers,
    });
  },
};
