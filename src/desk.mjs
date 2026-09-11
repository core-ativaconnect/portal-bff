import { HttpError, parseCommand } from './command.mjs';
import { resolveRoute } from './router.mjs';
import { execute } from './application.mjs';

// A separate REST boundary; the Studio command envelope is never required here.
export async function handler(event, _context, dependencies = {}) {
  const path = event.rawPath ?? event.path ?? '';
  try {
    if (!path.startsWith('/flow-desk/api/v1/')) throw new HttpError(404, 'Endpoint não encontrado.');
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    let body = {};
    if (event.body) {
      try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); }
      catch { throw new HttpError(400, 'O corpo deve conter um JSON válido.'); }
    }
    const query = event.rawQueryString ?? new URLSearchParams(event.queryStringParameters ?? {}).toString();
    const command = parseCommand({path: path.slice('/flow-desk'.length) + (query ? `?${query}` : ''), method, 'body-data': body});
    const route = resolveRoute(command);
    const allowed = route.controller === 'AuthController' && ['login', 'currentUser'].includes(route.operation)
      || route.controller === 'PlatformController' && ['listContracts', 'getContract'].includes(route.operation)
      || route.controller === 'PlatformHelpDeskController' && (method === 'GET' || ['assign', 'release', 'transfer', 'sendMessage', 'close'].includes(route.operation));
    if (!allowed) throw new HttpError(404, 'Endpoint não disponível no Flow Desk.');
    const result = await (dependencies.execute ?? execute)(route, command, event.headers);
    const statusCode = result === null && method === 'DELETE' ? 204 : 200;
    return {statusCode, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}, body: statusCode === 204 ? '' : JSON.stringify(result)};
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.status : 500;
    if (statusCode === 500) console.error(JSON.stringify({event: 'desk.failed', name: error.name}));
    return {statusCode, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}, body: JSON.stringify({status: statusCode, path, message: error instanceof HttpError ? error.message : 'Erro interno no Flow Desk.'})};
  }
}
