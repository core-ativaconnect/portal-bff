import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/command.mjs';

test('aceita path, método original, query e body-data', () => {
  const command = parseCommand({ path: '/api/v1/contracts?confirmation=empresa', method: 'delete', 'body-data': {} });
  assert.equal(command.method, 'DELETE');
  assert.equal(command.query.get('confirmation'), 'empresa');
  assert.equal(command.path, '/api/v1/contracts');
});
test('aceita uri como alias de path', () => assert.equal(parseCommand({ uri: '/api/v1/auth/login', method: 'POST' }).path, '/api/v1/auth/login'));
test('recusa URLs externas, caminhos ambíguos e métodos não suportados', () => {
  for (const path of ['https://example.com', '//example.com', '/a/../b', '/a/%2e%2e/b', '/a/%252e%252e/b', '/a\\b']) {
    assert.throws(() => parseCommand({ path, method: 'GET' }), { status: 400 });
  }
  assert.throws(() => parseCommand({ path: '/a', method: 'CONNECT' }), { status: 400 });
});
