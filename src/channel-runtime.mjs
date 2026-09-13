import { randomUUID, createHash } from 'node:crypto';
import { must, now } from './store.mjs';
import { processFlow, resolveDefinition } from './engine.mjs';
import { executeScript } from './scripts.mjs';
import {activeTicket,saveTicket,findSession} from './runtime-records.mjs';

export async function customerHandoff(store,contract,channel,contact,input,ticket,operationId){
  const resolved=await resolveDefinition(store,{flowId:ticket.flow_id,versionId:ticket.flow_version_id},contract.id);
  const action=resolved.definition.actions.find(a=>a.id===ticket.waiting_action_id);
  let patterns=action?.config?.finishRegexes?.filter(Boolean)??[];
  if(!patterns.length)patterns=action?.config?.finishRegex?[action.config.finishRegex]:['encerrar atendimento','finalizar atendimento','falar com fluxo'];
  let finish=false;
  for(const pattern of patterns){
    if(!/[\\.\[\](){}+*?|^$]/.test(pattern)){if(input.toLowerCase().includes(pattern.toLowerCase()))finish=true;}
    else{
      const result=await executeScript(`user.match = new RegExp(${JSON.stringify(`^(?:${pattern})$`)}).test(${JSON.stringify(input)});`,{});
      if(result.ok&&result.user.match)finish=true;
    }
  }
  if(!finish)return null;
  const response=await processFlow(store,{flowId:ticket.flow_id,versionId:ticket.flow_version_id,simulatorUserId:contact.contact_id,start:false,input},null,{contractId:contract.id,resumeByCustomer:true,operationId});
  await saveTicket(store,{...ticket,status:'CLOSED',close_reason:'CUSTOMER',closed_at:now(),updated_at:now()},{previous:ticket,contractId:contract.id});
  await store.transaction([store.guard(contract.id),store.putOperation('engine_contacts',{...contact,active_flow_id:response.flowId,active_flow_version_id:response.resolvedVersionId,active_flow_completed:response.completed,updated_at:now()})]);
  return response;
}

export async function runContactFlow(store, contract, channel, contact, input, operationId) {
  const saved=operationId?await store.get('jobs',{id:operationId}):null;
  const ticket = await activeTicket(store,channel.id,contact.contact_id);
  const tickets=ticket?[ticket]:[];
  if (tickets.length) return saved?.response?.waitingState==='HUMAN_HANDOFF'?saved.response:customerHandoff(store,contract,channel,contact,input,tickets[0],operationId);
  let response=saved?.response;
  if(!response){
  const links = await store.query('contract_channel_flows','channel_key',channel.id,{index:'channel-index'}).then(rows=>rows.filter(l=>l.is_primary));
  const target = contact.active_flow_id && !contact.active_flow_completed
    ? await resolveDefinition(store, {flowId: contact.active_flow_id, versionId: contact.active_flow_version_id, versionMode: 'PUBLISHED'}, contract.id)
    : links[0] ? await resolveDefinition(store, {flowId: links[0].flow_id, versionMode: 'PUBLISHED'}, contract.id) : null;
  if (!target || !input) return null;
  const session = await findSession(store,contract.id,contact.contact_id,target.flow.id,target.versionId);
  response = await processFlow(store, {flowId: target.flow.id, versionId: target.versionId,
    simulatorUserId: contact.contact_id, start: !session || session.completed === true, input}, null, {contractId: contract.id,operationId,runtimeContext:{resolved:target,session}});
  }
  await store.transaction([store.guard(contract.id), store.putOperation('engine_contacts', {...contact,
    active_flow_id: response.flowId, active_flow_version_id: response.resolvedVersionId,
    active_flow_completed: response.completed, updated_at: now()})]);
  if (response.waitingState === 'HUMAN_HANDOFF') {
    const resolved = await resolveDefinition(store, {flowId: response.flowId, versionId: response.resolvedVersionId}, contract.id);
    const action = resolved.definition.actions.find(a => a.id === response.waitingActionId);
    const queues = await store.query('contract_help_desk_queues','contract_key',contract.id,{index:'contract_name-index'}).then(rows=>rows.filter(q=>q.enabled));
    const queue = must(action?.config?.queueId ? queues.find(q => q.id === action.config.queueId) : queues.length === 1 ? queues[0] : null, 'Configure a fila de atendimento do fluxo.');
    const digest=operationId?createHash('sha256').update(operationId).digest('hex'):null;
    const id=digest?`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`:randomUUID(),timestamp=now();
    if(await store.get('helpdesk_tickets',{id}))return response;
    await saveTicket(store, {id, contract_id: contract.id, contract_slug: contract.slug,
      ticket_number: Date.now(), queue_id: queue.id, queue_name: queue.name, channel_id: channel.id,
      channel_slug: channel.slug, channel_name: channel.name, channel_type: channel.type,
      contact_id: contact.contact_id, contact_name: contact.username, contact_user_id: contact.user_id,
      contact_wa_id: contact.wa_id, flow_id: response.flowId, flow_version_id: response.resolvedVersionId,
      waiting_action_id: response.waitingActionId, status: 'OPEN', opened_at: timestamp, updated_at: timestamp,
      channel_contact_key: `${channel.id}#${contact.contact_id}`}, {create: true, contractId: contract.id});
  }
  return response;
}
