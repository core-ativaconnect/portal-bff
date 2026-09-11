import { readFileSync } from 'node:fs';
import { HttpError } from './command.mjs';

export const routes = JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8'));
const compiled = routes.map(route => {
  const names = [];
  const pattern = route.path.split('/').map(segment => {
    if (/^\{\w+\}$/.test(segment)) { names.push(segment.slice(1, -1)); return '([^/]+)'; }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { ...route, names, matcher: new RegExp(`^${pattern}$`) };
}).sort((a, b) => a.names.length - b.names.length);

export function resolveRoute(command) {
  const candidates = compiled.filter(route => route.matcher.test(command.path));
  const route = candidates.find(route => route.method === command.method);
  if (!route) throw new HttpError(candidates.length ? 405 : 404, candidates.length ? 'Método não permitido para este caminho.' : 'Comando não encontrado.');
  const matches = route.matcher.exec(command.path);
  const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(matches[index + 1])]));
  return { ...route, params };
}
