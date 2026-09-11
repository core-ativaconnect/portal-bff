export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function parseCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Informe um objeto de comando.');
  const path = input.path ?? input.uri;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020#]/.test(path)) {
    throw new HttpError(400, 'path deve ser um caminho relativo iniciado por /.');
  }
  if (input.path !== undefined && input.uri !== undefined && input.path !== input.uri) throw new HttpError(400, 'path e uri não podem divergir.');
  if (path.length > 8192) throw new HttpError(400, 'Caminho muito longo.');
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
  if (!methods.has(method)) throw new HttpError(400, 'Método de comando inválido.');
  let decoded;
  try { decoded = decodeURIComponent(path.split('?')[0]); } catch { throw new HttpError(400, 'Caminho inválido.'); }
  if (decoded.includes('\\') || decoded.includes('%') || decoded.split('/').some(segment => segment === '.' || segment === '..')) throw new HttpError(400, 'Caminho inválido.');
  const url = new URL(path, 'https://commands.invalid');
  const body = input['body-data'] ?? {};
  if(typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body-data deve ser um objeto.');
  return { path: url.pathname.replace(/\/$/, '') || '/', method, body, query: url.searchParams, rawPath: path };
}
