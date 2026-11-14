import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const pages = new Set(['/', '/pilot', '/pilot.html', '/login', '/manage', '/researcher.html']);
const assets = new Set(['/pilot.css', '/book.css', '/pilot.js', '/diagnostic.js', '/researcher.js', '/standalone.js', '/assets/reading-book-logo.png']);
const getApis = new Set(['/api/pilot', '/api/pilot/records', '/api/pilot/export', '/api/admin/invitations']);
const postApis = new Set(['/api/pilot', '/api/auth/login', '/api/auth/logout', '/api/admin/invitations', '/api/admin/revoke']);
const responseHeaders = ['content-type', 'content-disposition', 'x-content-type-options'];
const noStore = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };

function error(status, message) {
  return Response.json({ error: message }, { status, headers: noStore });
}

export function createRelay({ publicHosts, originHost, originAddress, originPort = 443, ca, readOnly = true, previewToken, productionOrigin }) {
  return async function relay(incoming, path) {
    const url = new URL(incoming.url);
    if (url.protocol !== 'https:' || !publicHosts.has(url.host)) return error(404, '入口不可用。');
    const isGet = incoming.method === 'GET';
    const isPost = incoming.method === 'POST';
    if (!(isGet && (pages.has(path) || assets.has(path) || getApis.has(path)) || isPost && postApis.has(path))) {
      return error(404, '页面不存在。');
    }
    if (isPost && readOnly) return error(405, '当前预览仅检查页面访问。');

    const headers = { Host: previewToken ? 'reading-preview.invalid' : originHost };
    if (productionOrigin) {
      headers['X-Reading-Production-Identity'] = productionOrigin.token;
      headers['X-Reading-Client-IP'] = productionOrigin.clientIp;
    }
    const applicationCookies = incoming.headers.get('cookie')?.split(';').filter((cookie) =>
      /^(?:__Host-ancient_reading_reader|ancient_standalone_session)=/.test(cookie.trim()));
    if (applicationCookies?.length) headers.Cookie = applicationCookies.join(';');
    if (previewToken) headers['X-Reading-Preview-Identity'] = previewToken;
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
      headers.Origin = `https://${productionOrigin?.applicationHost ?? originHost}`;
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }

    const upstreamPath = (productionOrigin ? '/__reading_production' : previewToken ? '/__reading_preview' : '') + path + url.search;
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
        const expectedStore = productionOrigin ? 'production' : previewToken ? 'preview-simulation' : null;
        if (expectedStore && res.headers['x-reading-store'] !== expectedStore) {
          res.resume();
          resolve(error(502, '试读源站连接失败。'));
          return;
        }
        if (expectedStore) outgoing.set('X-Reading-Store', expectedStore);
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
    if (process.env.VERCEL_ENV === 'production') return serveProduction(incoming);
    if (process.env.VERCEL_ENV !== 'preview' || !process.env.VERCEL_URL ||
        process.env.VERCEL_GIT_COMMIT_REF !== 'vercel-origin-check') return error(404, '入口不可用。');
    const previewToken = incoming.headers.get('x-vercel-oidc-token');
    if (!previewToken) return error(503, '模拟入口暂不可用。');
    const url = new URL(incoming.url);
    const path = url.searchParams.get('reading_path') ?? '/';
    url.searchParams.delete('reading_path');
    return createRelay({
      publicHosts: new Set([process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]),
      originHost: 'gujiyuedu.site',
      originAddress: '43.161.216.193',
      readOnly: false,
      previewToken,
    })(new Request(url, incoming), path);
  },
};

function serveProduction(incoming) {
  const publicHost = 'www.gujiyuedu.site';
  const url = new URL(incoming.url);
  if (process.env.VERCEL_GIT_COMMIT_REF !== 'main' || url.protocol !== 'https:') return error(404, '入口不可用。');
  const path = url.searchParams.get('reading_path') ?? '/';
  url.searchParams.delete('reading_path');
  if (url.host === 'gujiyuedu.site' && incoming.method === 'GET') {
    if (!pages.has(path) && !assets.has(path)) return error(404, '页面不存在。');
    const target = new URL(`https://${publicHost}`);
    target.pathname = path;
    target.search = url.search;
    return new Response(null, { status: 307, headers: { ...noStore, Location: target.href } });
  }
  if (url.host !== publicHost) return error(404, '入口不可用。');
  if (process.env.READING_ORIGIN_HOST !== 'origin.gujiyuedu.site') return error(503, '试读入口尚未启用。');
  const token = incoming.headers.get('x-vercel-oidc-token');
  const clientIp = incoming.headers.get('x-vercel-forwarded-for');
  if (!token || !isIP(clientIp ?? '')) return error(503, '试读入口暂不可用。');
  return createRelay({
    publicHosts: new Set([publicHost]),
    originHost: process.env.READING_ORIGIN_HOST,
    originAddress: process.env.READING_ORIGIN_HOST,
    readOnly: false,
    productionOrigin: { token, clientIp, applicationHost: 'gujiyuedu.site' },
  })(new Request(url, incoming), path);
}
