import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routes, resolveRoute } from '../src/router.mjs';

test('todas as operações têm método, autorização e caminho únicos', () => {
  const seen = new Set();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), key);
    seen.add(key);
    assert.ok(['PUBLIC', 'AUTHENTICATED', 'OWNER'].includes(route.access));
    assert.equal(resolveRoute({ path: route.path.replace(/\{\w+\}/g, 'sample'), method: route.method }).method, route.method);
  }
});
test('rotas específicas têm prioridade sobre parâmetros', () => {
  assert.equal(resolveRoute({ path: '/api/v1/contracts/slug/empresa', method: 'GET' }).operation, 'findBySlug');
  assert.equal(resolveRoute({ path: '/api/v1/auth/login', method: 'POST' }).access, 'PUBLIC');
  assert.equal(resolveRoute({ path: '/api/v1/users', method: 'GET' }).access, 'OWNER');
});
test('webhook Meta não é disponibilizado pelo commands', () => {
  assert.throws(() => resolveRoute({ path: '/v1/webhook/meta', method: 'POST' }), { status: 404 });
});
