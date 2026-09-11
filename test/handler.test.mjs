import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/handler.mjs';

const event = body => ({ requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) });

test('health confirma o runtime sem declarar a migração pronta', async () => {
  const result = await handler(event({ path: '/actuator/health', method: 'GET', 'body-data': {} }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).businessHandlersReady, false);
});
test('retorna 400 para JSON inválido e 404 para caminho inexistente', async () => {
  assert.equal((await handler({ ...event({}), body: '{' })).statusCode, 400);
  assert.equal((await handler(event({ path: '/inexistente', method: 'GET' }))).statusCode, 404);
});
test('login validates input instead of returning the migration placeholder', async () => {
  const result = await handler(event({ path: '/api/v1/auth/login', method: 'POST', 'body-data': {} }));
  assert.equal(result.statusCode, 400);
});
