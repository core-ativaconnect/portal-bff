import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFlow, assertPublishable} from '../src/flow-validation.mjs';
import {richMessage, decorateInteractive} from '../src/flow-content.mjs';
import {metaMessage} from '../src/messages.mjs';
import {sendFlowEmail} from '../src/flow-email.mjs';

const action = (type = 'interaction', config = {message: 'Olá'}) => ({id: 'start', name: 'Início', type, config, nextActionId: null});
test('publication identifies broken routes, unreachable actions and unsupported content by action', () => {
  assert.deepEqual(validateFlow({entryActionId: 'start', actions: [action()]}), []);
  assert.ok(validateFlow({actions: [action()]}).some(i => i.field === 'entryActionId'));
  const issues = validateFlow({entryActionId: 'start', actions: [
    {...action('router', {routes: [{nextActionId: 'missing', condition: {userVariable: 'user.x', operator: 'regex', value: '['}}]}), nextActionId: 'absent'},
    {...action('interaction', {messageType: 'carousel'}), id: 'orphan'},
  ]});
  for (const field of ['nextActionId', 'routes', 'routes.regex', 'messageType', 'connections']) assert.ok(issues.some(i => i.field === field), field);
  assert.ok(issues.every(i => i.actionId && i.message));
  assert.ok(validateFlow({entryActionId: 'start', actions: [action('interaction', {messageType: 'image', mediaLink: 'file:///etc/passwd'})]}).some(i => i.field === 'mediaLink'));
  assert.ok(validateFlow({entryActionId: 'start', actions: [action('interaction', {messageType: 'image', mediaLink: 'https://example.com/a.png'})]}, {channelTypes: ['WEBCHAT']}).some(i => i.field === 'messageType'));
});

test('publication rejects foreign/disabled resources and a missing published flow destination', async () => {
  const store = {list: async () => [], get: async () => ({id: 'resource', contract_id: 'another', enabled: true})};
  for (const [type, config] of [ ['ai_agent', {providerConfigId: 'resource'}], ['email', {connectionId: 'resource', to: 'a@example.com', subject: 'Oi', body: 'Oi'}], ['flow_swap', {targetFlowId: 'resource', targetActionId: 'step'}] ]) {
    await assert.rejects(assertPublishable(store, {id: 'flow', definition_json: JSON.stringify({actions: [action(type, config)]})}, 'mine'), error => error.status === 422 && error.issues.some(i => i.actionId === 'start'));
  }
});

test('media and contacts produce native Graph payloads without losing content', () => {
  const render = text => String(text ?? '').replace('{{name}}', 'Maria');
  for (const type of ['image', 'document', 'audio']) {
    const payload = richMessage({messageType: type, mediaSource: 'id', mediaId: 'media-1', mediaCaption: 'Olá {{name}}', documentFilename: 'pedido.pdf', audioIsVoice: true}, render);
    assert.equal(payload.type, type); assert.equal(payload[type].id, 'media-1');
    if (type === 'audio') { assert.equal(payload.audio.caption, undefined); assert.equal(payload.audio.voice, true); }
    else assert.equal(payload[type].caption, 'Olá Maria');
    assert.deepEqual(metaMessage({channelPayload: payload}), payload);
  }
  const contacts = richMessage({messageType: 'contacts', contacts: [{formattedName: '{{name}}', phone: '+5511999999999', company: 'Tiudi'}]}, render);
  assert.equal(contacts.contacts[0].name.formatted_name, 'Maria');
  assert.equal(contacts.contacts[0].phones[0].phone, '+5511999999999');
  const cta = decorateInteractive(richMessage({messageType: 'cta_url', message: 'Olá {{name}}', ctaLabel: 'Abrir', ctaUrl: 'https://example.com'}, render), {header: {type: 'image', mediaLink: 'https://example.com/a.png'}, footerText: 'Tiudi'}, render);
  assert.equal(cta.interactive.action.parameters.display_text, 'Abrir');
  assert.equal(cta.interactive.header.image.link, 'https://example.com/a.png');
  assert.throws(() => richMessage({messageType: 'carousel'}, render), /indisponível/);
});

test('email uses the contract connection, pins DNS, closes transport and rejects foreign/private destinations', async () => {
  let options, message, closed = false;
  const connection = {contract_id: 'mine', enabled: true, host: 'smtp.example.com', port: 587, security: 'STARTTLS', username: 'sender@example.com', secret: 'secret', from_email: 'sender@example.com'};
  const store = {get: async () => connection};
  const dependencies = {resolve: async () => [{address: '8.8.8.8'}], createTransport: value => { options = value; return {sendMail: async value => {message = value; return {accepted: ['a@example.com'], rejected: [], messageId: 'mail-1'};}, close: () => closed = true}; }};
  const config = {connectionId: 'connection', to: 'a@example.com', subject: 'Pedido', body: 'Olá'};
  assert.equal(await sendFlowEmail(store, 'mine', config, String, dependencies), 'mail-1');
  assert.equal(options.host, '8.8.8.8'); assert.equal(options.tls.servername, 'smtp.example.com'); assert.equal(options.disableFileAccess, true);
  assert.equal(message.from, connection.from_email); assert.equal(closed, true);
  await assert.rejects(sendFlowEmail(store, 'other', config, String, dependencies), /deste contrato/);
  await assert.rejects(sendFlowEmail(store, 'mine', config, String, {...dependencies, resolve: async () => [{address: '127.0.0.1'}]}), /público/);
});
