import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError } from './command.mjs';
import { must, now, required } from './store.mjs';
import { processFlow, resolveDefinition } from './engine.mjs';
import { writable } from './contracts.mjs';
import { customerHandoff } from './channel-runtime.mjs';
import { sendText } from './messages.mjs';
import {admitContact} from './billing.mjs';
import {findSession,activeTicket,saveTicket,persistMessage} from './runtime-records.mjs';

function key(store){return Buffer.from(store.settings.secret);}
export async function webchatOperation(store,body){
  const agent=required(body.agentName,'Agente',120);
  const channel=must((await store.query('contract_channels','webchat_agent_key',agent.toLowerCase(),{index:'webchat_agent-index'}).then(rows=>rows.filter(c=>c.type==='WEBCHAT')))[0]);
  const contract=must(await store.get('contracts',{id:channel.contract_id}));writable(contract);
  const today=new Date().toISOString().slice(0,10);
  if(contract.status!=='ACTIVE'||contract.start_date>today||contract.end_date<today)throw new HttpError(403,'Canal indisponível.');
  let contact,contactToken=body.contactToken;
  if(contactToken){
    let claims;try{claims=(await jwtVerify(contactToken,key(store),{algorithms:['HS256'],audience:'webchat',requiredClaims:['exp','sub']})).payload;}catch{throw new HttpError(401,'Sessão do chat inválida.');}
    if(claims.channelId!==channel.id)throw new HttpError(401,'Sessão de outro canal.');
    contact=must(await store.get('engine_contacts',{contact_id:claims.sub}));
  }else{
    if(body.type!=='connect')throw new HttpError(401,'Inicie uma sessão do chat.');
    const id=randomUUID();contact={contact_id:id,user_id:`webchat:${channel.id}:${id}`,username:required(body.contactName||'Visitante','Nome',120),created_at:now(),updated_at:now()};
    await store.transaction([store.guard(contract.id),store.putOperation('engine_contacts',contact,'attribute_not_exists(contact_id)')]);
    contactToken=await new SignJWT({channelId:channel.id}).setProtectedHeader({alg:'HS256'}).setSubject(id).setAudience('webchat').setIssuedAt().setExpirationTime('30d').sign(key(store));
  }
  const envelope=messages=>({type:body.type==='connect'?'connected':'messages',contactId:contact.contact_id,contactToken,agentName:channel.webchat_agent_name,channelSlug:channel.slug,channelName:channel.name,message:null,messages});
  if(body.type==='ping')return{...envelope([]),type:'pong'};
  if(!['connect','message','poll'].includes(body.type))throw new HttpError(400,'Comando de chat inválido.');
  if(body.type==='message')required(body.text,'Mensagem',20000);
  if(body.type==='connect'||body.type==='message') {
    const admission=await admitContact(store,contract.id,channel,contact);
    if(!admission.allowed)return {...envelope([]),unavailable:true};
  }
  const links=await store.query('contract_channel_flows','channel_key',channel.id,{index:'channel-index'}).then(rows=>rows.filter(l=>l.is_primary));
  let target;
  if(contact.active_flow_id&&!contact.active_flow_completed)target=await resolveDefinition(store,{flowId:contact.active_flow_id,versionId:contact.active_flow_version_id,versionMode:'PUBLISHED'},contract.id);
  else if(links[0])target=await resolveDefinition(store,{flowId:links[0].flow_id,versionMode:'PUBLISHED'},contract.id);
  const session=target?await findSession(store,contract.id,contact.contact_id,target.flow.id,target.versionId):null;
  const ticket=await activeTicket(store,channel.id,contact.contact_id);
  if(body.type==='message'){
    const timestamp=now(),id=randomUUID(),text=required(body.text,'Mensagem',20000);
    await persistMessage(store,{contact_id:contact.contact_id,message_id:id,contract_id:contract.id,contract_slug:contract.slug,channel_id:channel.id,channel_slug:channel.slug,direction:'INBOUND',message_kind:'USER',message_type:'webchat_text',message_text:text,contact_name:contact.username,contact_user_id:contact.user_id,status:'RECEIVED',occurred_at:timestamp,updated_at:timestamp});
  }
  let response;
  if(ticket&&body.type==='message'){
    const resumed=await customerHandoff(store,contract,channel,contact,body.text,ticket);
    for(const message of resumed?.messages.filter(m=>m.kind==='BUSINESS')??[])if(message.text)await sendText(store,contract,channel,contact,message.text,'BUSINESS',message);
  }
  if(target&&!ticket&&body.type!=='poll'&&(body.type==='message'||!session)){
    response=await processFlow(store,{flowId:target.flow.id,versionId:target.versionId,simulatorUserId:contact.contact_id,start:!session||session.completed===true,input:body.text},null,{contractId:contract.id});
    const updated={...contact,active_flow_id:response.flowId,active_flow_version_id:response.resolvedVersionId,active_flow_completed:response.completed,updated_at:now()};
    await store.transaction([store.guard(contract.id),store.putOperation('engine_contacts',updated)]);
    for(const message of response.messages.filter(m=>m.kind==='BUSINESS')){
      const id=randomUUID(),timestamp=now();await persistMessage(store,{contact_id:contact.contact_id,message_id:id,contract_id:contract.id,contract_slug:contract.slug,channel_id:channel.id,channel_slug:channel.slug,direction:'OUTBOUND',message_kind:'BUSINESS',message_type:'webchat_text',message_text:message.text,message_payload_json:JSON.stringify(message),contact_name:contact.username,contact_user_id:contact.user_id,status:'SENT',occurred_at:timestamp,updated_at:timestamp});
    }
    if(response.waitingState==='HUMAN_HANDOFF'){
      const definition=await resolveDefinition(store,{flowId:response.flowId,versionId:response.resolvedVersionId},contract.id);
      const action=definition.definition.actions.find(a=>a.id===response.waitingActionId),queues=await store.query('contract_help_desk_queues','contract_key',contract.id,{index:'contract_name-index'}).then(rows=>rows.filter(q=>q.enabled));
      const queue=must(action?.config?.queueId?queues.find(q=>q.id===action.config.queueId):queues.length===1?queues[0]:null,'Configure a fila de atendimento do fluxo.');
      const id=randomUUID(),timestamp=now();const newTicket={id,contract_id:contract.id,contract_slug:contract.slug,ticket_number:Date.now(),queue_id:queue.id,queue_name:queue.name,channel_id:channel.id,channel_slug:channel.slug,channel_name:channel.name,channel_type:'WEBCHAT',contact_id:contact.contact_id,contact_name:contact.username,contact_user_id:contact.user_id,flow_id:response.flowId,flow_version_id:response.resolvedVersionId,waiting_action_id:response.waitingActionId,status:'OPEN',opened_at:timestamp,updated_at:timestamp,channel_contact_key:`${channel.id}#${contact.contact_id}`};
      await saveTicket(store,newTicket,{create:true,contractId:contract.id});
    }
  }
  const records=(await store.query('engine_messages','contact_id',contact.contact_id).then(rows=>rows.filter(m=>m.channel_id===channel.id&&m.direction==='OUTBOUND'&&(!body.since||m.occurred_at>=body.since)))).sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at));
  return envelope(records.map(m=>{let payload={};try{payload=JSON.parse(m.message_payload_json??'{}');}catch{}return{id:m.message_id,kind:m.message_kind,text:m.message_text,choices:payload.choices??[],list:payload.list??null,actionId:payload.actionId??null,occurredAt:m.occurred_at};}));
}
