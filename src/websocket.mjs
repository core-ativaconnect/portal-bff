import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { Store, now } from './store.mjs';
import { HttpError } from './command.mjs';
import { webchatOperation } from './webchat.mjs';

export async function post(connection, envelope) {
  const client = new ApiGatewayManagementApiClient({
    endpoint: connection.endpoint,
    region: process.env.AWS_REGION || 'us-east-1',
    ...(process.env.IS_OFFLINE ? {credentials: {accessKeyId: 'local', secretAccessKey: 'local'}} : {}),
  });
  // API Gateway limits individual WebSocket frames to 32 KiB.
  const messages = envelope.messages ?? [];
  if (messages.length) {
    if(envelope.type==='connected')await client.send(new PostToConnectionCommand({ConnectionId:connection.id,Data:Buffer.from(JSON.stringify({...envelope,messages:[]}))}));
    for (const message of messages) await client.send(new PostToConnectionCommand({ConnectionId: connection.id, Data: Buffer.from(JSON.stringify({...envelope, type:'messages', messages: [message]}))}));
  } else await client.send(new PostToConnectionCommand({ConnectionId: connection.id, Data: Buffer.from(JSON.stringify(envelope))}));
}

export async function broadcast(store, channelId, contactId, message, send = post) {
  const connections = await store.list('websocket_connections', c => c.channel_id === channelId && c.contact_id === contactId && c.expires_at > Date.now() / 1000);
  for (const connection of connections) {
    try { await send(connection, {type: 'messages', contactId, messages: [message]}); }
    catch (error) {
      if (error.$metadata?.httpStatusCode === 410 || error.name === 'GoneException') await store.delete('websocket_connections', {id: connection.id});
      else console.error(JSON.stringify({event: 'webchat.push.failed', name: error.name}));
      // History remains available on reconnect even when a socket has gone away.
    }
  }
}

export async function handler(event, _context, dependencies = {}) {
  const store = dependencies.store ?? new Store();
  const send = dependencies.post ?? post;
  const chat = dependencies.chat ?? webchatOperation;
  const context = event.requestContext ?? {};
  const id = context.connectionId;
  if (!id) return {statusCode: 400, body: ''};
  if (context.routeKey === '$connect') {
    const endpoint = process.env.IS_OFFLINE ? 'http://localhost:3003' : process.env.PORTAL_WEBSOCKET_MANAGEMENT_ENDPOINT;
    if (!endpoint) return {statusCode: 503, body: ''};
    await store.put('websocket_connections', {id, endpoint, created_at: now(), expires_at: Math.floor(Date.now() / 1000) + 7200}, {create: true});
    return {statusCode: 200, body: ''};
  }
  if (context.routeKey === '$disconnect') {
    await store.delete('websocket_connections', {id});
    return {statusCode: 200, body: ''};
  }
  const connection = await store.get('websocket_connections', {id});
  if (!connection || connection.expires_at <= Date.now() / 1000) return {statusCode: 410, body: ''};
  try {
    let body;
    try { body = JSON.parse(event.body); } catch { throw new HttpError(400, 'JSON inválido.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Comando inválido.');
    if (!['connect', 'message', 'ping'].includes(body.type)) throw new HttpError(400, 'Comando de chat inválido.');
    if (body.type !== 'connect' && !connection.contact_token) throw new HttpError(401, 'Inicie uma sessão do chat.');
    const result = await chat(store, body.type === 'connect' ? body : {
      ...body, agentName: connection.agent_name, contactToken: connection.contact_token, since: connection.since,
    });
    const channel = (await store.list('contract_channels', c => c.type === 'WEBCHAT' && c.webchat_agent_name?.toLowerCase() === result.agentName?.toLowerCase()))[0];
    if (!channel) throw new HttpError(404, 'Canal não encontrado.');
    await store.put('websocket_connections', {...connection, contract_id: channel.contract_id, channel_id: channel.id,
      contact_id: result.contactId, contact_token: result.contactToken, agent_name: result.agentName,
      since: result.messages?.at(-1)?.occurredAt ?? connection.since, updated_at: now()}, {contractId: channel.contract_id});
    await send(connection, result);
  } catch (error) {
    await send(connection, {type: 'error', status: error instanceof HttpError ? error.status : 500,
      message: error instanceof HttpError ? error.message : 'Não foi possível processar a mensagem.'});
  }
  return {statusCode: 200, body: ''};
}
