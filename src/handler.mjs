import { HttpError, parseCommand } from './command.mjs';
import { resolveRoute } from './router.mjs';
import { execute } from './application.mjs';
import { enqueue, jobStatus } from './jobs.mjs';

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export async function handler(event) {
  let command;
  try {
    const method = event.requestContext?.http?.method ?? event.httpMethod;
    if (method !== 'POST') throw new HttpError(405, 'Use POST /commands.');
    let input;
    try {
      const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
      input = JSON.parse(text ?? '');
    } catch { throw new HttpError(400, 'O corpo deve conter um JSON válido.'); }
    command = parseCommand(input);
    if(command.method==='GET'&&/^\/api\/v1\/jobs\/[a-f0-9-]{36}$/.test(command.path))return await jobStatus(command.path.split('/').at(-1),event.headers);
    if (command.method === 'GET' && command.path === '/actuator/health') {
      return response(200, {
        status: 'UP', service: 'portal-bff', stage: process.env.APP_STAGE ?? 'local',
        environment: process.env.NODE_ENV ?? 'development', businessHandlersReady: false,
      });
    }
    const route = resolveRoute(command);
    if(!process.env.IS_OFFLINE&&process.env.APP_STAGE&&process.env.APP_STAGE!=='local'&&(route.operation==='generateAiDraft'||route.controller==='ContractDeleteController'))return await enqueue(route,command,event.headers);
    const result = await execute(route, command, event.headers);
    if (result === null && command.method === 'DELETE') return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
    return response(200, result);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(JSON.stringify({event:'command.failed',name:error.name,requestId:event.requestContext?.requestId}));
    const status = error instanceof HttpError ? error.status : 500;
    return response(status, {
      timestamp: new Date().toISOString(), status,
      message: error instanceof HttpError ? error.message : 'Erro interno no portal-bff.',
      path: command?.rawPath ?? '/commands',
    });
  }
}
