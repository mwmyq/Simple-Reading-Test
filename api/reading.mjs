import { request as httpsRequest } from 'node:https';

const pages = new Set(['/', '/pilot', '/pilot.html', '/login', '/manage', '/researcher.html']);
const assets = new Set(['/pilot.css', '/book.css', '/pilot.js', '/diagnostic.js', '/researcher.js', '/standalone.js', '/assets/reading-book-logo.png']);
const getApis = new Set(['/api/pilot', '/api/pilot/records', '/api/pilot/export', '/api/admin/invitations']);
const postApis = new Set(['/api/pilot', '/api/auth/login', '/api/auth/logout', '/api/admin/invitations', '/api/admin/revoke']);
const responseHeaders = ['content-type', 'content-disposition', 'x-content-type-options'];
const noStore = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };

function error(status, message) {
  return Response.json({ error: message }, { status, headers: noStore });
}

export function createRelay({ publicHosts, originHost, originAddress, originPort = 443, ca, previewToken }) {
  return async function relay(incoming, path) {
    const url = new URL(incoming.url);
    if (url.protocol !== 'https:' || !publicHosts.has(url.host)) return error(404, '入口不可用。');
    const isGet = incoming.method === 'GET';
    const isPost = incoming.method === 'POST';
    if (!(isGet && (pages.has(path) || assets.has(path) || getApis.has(path)) || isPost && postApis.has(path))) {
      return error(404, '页面不存在。');
    }
    if (!previewToken) return error(503, '模拟入口暂不可用。');
    const headers = { Host: 'verification-preview.invalid', 'X-Reading-Preview-Identity': previewToken };
    const applicationCookies = incoming.headers.get('cookie')?.split(';').filter((cookie) =>
      /^(?:__Host-ancient_reading_reader|ancient_standalone_session)=/.test(cookie.trim()));
    if (applicationCookies?.length) headers.Cookie = applicationCookies.join(';');
    let body;
    if (isPost) {
      if (incoming.headers.get('origin') !== url.origin || incoming.headers.get('sec-fetch-site') === 'cross-site') {
        return error(403, '请求来源无效。');
      }
      if (incoming.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return error(415, '请求格式无效。');
      }
      if (Number(incoming.headers.get('content-length')) > 16384) return error(413, '请求内容过长。');
      body = Buffer.from(await incoming.arrayBuffer());
      if (body.length > 16384) return error(413, '请求内容过长。');
      headers.Origin = `https://${originHost}`;
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }

    const upstreamPath = '/__verification_preview' + path + url.search;
    return new Promise((resolve) => {
      const upstream = httpsRequest({
        hostname: originAddress, servername: originHost, port: originPort, ca,
        method: incoming.method, path: upstreamPath, headers,
        signal: AbortSignal.timeout(12000),
      }, (res) => {
        const outgoing = new Headers(noStore);
        for (const name of responseHeaders) {
          if (typeof res.headers[name] === 'string') outgoing.set(name, res.headers[name]);
        }
        const expectedStore = 'verification-preview';
        if (res.headers['x-reading-store'] !== expectedStore) {
          res.resume();
          resolve(error(502, '试读源站连接失败。'));
          return;
        }
        outgoing.set('X-Reading-Store', expectedStore);
        for (const cookie of res.headers['set-cookie'] ?? []) outgoing.append('Set-Cookie', cookie);
        const location = res.headers.location;
        if (location?.startsWith('/') && !location.startsWith('//') && !location.includes('\\')) {
          outgoing.set('Location', location);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = [204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status: res.statusCode, headers: outgoing }));
        });
        res.on('error', () => resolve(error(502, '试读服务连接中断，请稍后重试。')));
      });
      upstream.on('error', () => resolve(error(502, '试读服务暂时无法连接，请稍后重试。')));
      upstream.end(body);
    });
  };
}

export default {
  fetch(incoming) {
    const verificationPreview = process.env.VERCEL_GIT_COMMIT_REF === 'verification-v09-preview';
    if (process.env.VERCEL_ENV !== 'preview' || !process.env.VERCEL_URL ||
        !verificationPreview) return error(404, '入口不可用。');
    const previewToken = incoming.headers.get('x-vercel-oidc-token');
    if (!previewToken) return error(503, '模拟入口暂不可用。');
    const url = new URL(incoming.url);
    const path = url.searchParams.get('reading_path') ?? '/';
    url.searchParams.delete('reading_path');
    return createRelay({
      publicHosts: new Set([process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]),
      originHost: 'gujiyuedu.site',
      originAddress: '43.161.216.193',
      previewToken,
    })(new Request(url, incoming), path);
  },
};
