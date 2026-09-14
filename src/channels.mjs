import {assertPublishable} from './flow-validation.mjs';
import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { must, now, required, fromItem, pick } from './store.mjs';
import { slugify, writable } from './contracts.mjs';
import { phoneResponse, wabaResponse } from './whatsapp.mjs';
import {listTraces} from './channel-debug.mjs';

const table='contract_channels',linksTable='contract_channel_flows',transferTable='whatsapp_phone_transfer_requests';
export async function channelPhone(store,phone) {
  if(!phone)return null;
  const waba=must(await store.get('whatsapp_wabas',{id:phone.waba_config_id})),wabaData=await wabaResponse(store,waba);
  const assigned=(await store.list(table,c=>c.whatsapp_phone_number_id===phone.id))[0];
  const contract=assigned?await store.get('contracts',{id:assigned.contract_id}):null;
  return{...phoneResponse(phone),wabaName:waba.name,wabaId:waba.waba_id,appConfigId:waba.app_config_id,appName:wabaData.appName,appId:wabaData.appId,assigned:!!assigned,assignedChannelId:assigned?.id??null,assignedChannelName:assigned?.name??null,assignedChannelSlug:assigned?.slug??null,assignedContractId:contract?.id??null,assignedContractName:contract?.company_name??null,assignedContractSlug:contract?.slug??null,hasPendingTransfer:(await store.list(transferTable,t=>t.phone_number_id===phone.id&&t.status==='PENDING')).length>0};
}
export async function transferResponse(store,item) {
  const result=pick(fromItem(item),['id','status','phoneNumberId','sourceContractId','sourceChannelId','targetContractId','targetChannelId','requestedByEmail','resolvedByEmail','requestedAt','resolvedAt']);
  for(const side of ['source','target']){
    const contract=await store.get('contracts',{id:item[`${side}_contract_id`]}),channel=await store.get(table,{id:item[`${side}_channel_id`]});
    result[`${side}ContractName`]=contract?.company_name??null;result[`${side}ContractSlug`]=contract?.slug??null;
    result[`${side}ChannelName`]=channel?.name??null;result[`${side}ChannelSlug`]=channel?.slug??null;
  }
  const phone=await store.get('whatsapp_phone_numbers',{id:item.phone_number_id});return{...result,displayPhoneNumber:phone?.display_phone_number??null,verifiedName:phone?.verified_name??null,metaPhoneNumberId:phone?.meta_phone_number_id??null};
}
export async function channelResponse(store,channel,contract) {
  const links=await store.list(linksTable,l=>l.channel_id===channel.id),flows=[];
  for(const link of links){const flow=await store.get('flows',{id:link.flow_id});if(flow)flows.push({id:link.id,flowId:flow.id,name:flow.name,slug:flow.slug,path:`/plataform/${contract.slug}/fluxos/${flow.slug}`,primary:link.is_primary,linkedAt:link.created_at});}
  const phone=channel.whatsapp_phone_number_id?await store.get('whatsapp_phone_numbers',{id:channel.whatsapp_phone_number_id}):null;
  const pending=(await store.list(transferTable,t=>t.target_channel_id===channel.id&&t.status==='PENDING'))[0];
  return{...pick(fromItem(channel),['id','contractId','name','slug','type','status','createdAt','updatedAt']),contractSlug:contract.slug,path:`/plataform/${contract.slug}/canais/${channel.slug}`,flowsPath:`/plataform/${contract.slug}/canais/${channel.slug}/fluxos`,agentName:channel.webchat_agent_name??null,debugEnabled:!!channel.debug_enabled,sessionTimeoutMinutes:channel.session_timeout_minutes??1440,whatsAppPhoneNumber:await channelPhone(store,phone),pendingTransferRequest:pending?await transferResponse(store,pending):null,linkedFlowCount:flows.length,primaryFlow:flows.find(f=>f.primary)??null,flows};
}
function sessionTimeoutMinutes(value){const minutes=Number(value);if(!Number.isInteger(minutes)||minutes<1||minutes>43_200)throw new HttpError(400,'Tempo de sessão deve ser um número inteiro entre 1 minuto e 30 dias.');return minutes;}
function channelItem(item){return{...item,updated_at:now(),contract_key:item.contract_id,name_sort:`${item.name.toLowerCase()}#${item.id}`,contract_slug_key:`${item.contract_id}#${item.slug}`,phone_key:item.whatsapp_phone_number_id??undefined,webchat_agent_key:item.webchat_agent_name?.toLowerCase()};}
function reserveAgent(store,item){return store.putOperation(table,{id:`AGENT#${item.webchat_agent_key}`,channel_id:item.id,owner_contract_id:item.contract_id},'attribute_not_exists(id) OR channel_id = :id',{':id':item.id});}
function history(store,phoneId,channel,event,actor,transferId=null){return store.putOperation('whatsapp_phone_channel_link_history',{id:randomUUID(),phone_number_id:phoneId,channel_id:channel.id,contract_id:channel.contract_id,event_type:event,actor_user_id:actor.id,actor_email:actor.email,transfer_request_id:transferId,created_at:now()});}
function transferItem(item){return{...item,source_contract_key:item.source_contract_id,target_contract_key:item.target_contract_id,target_channel_status_key:`${item.target_channel_id}#${item.status}`,source_channel_status_key:`${item.source_channel_id}#${item.status}`,phone_status_key:`${item.phone_number_id}#${item.status}`,requested_at_sort:`${item.requested_at}#${item.id}`};}
async function bindPhone(store,channel,contract,phoneId,actor) {
  if(channel.type!=='WHATSAPP')throw new HttpError(400,'Canal não é WhatsApp.');
  const phone=must(await store.get('whatsapp_phone_numbers',{id:required(phoneId,'Telefone',36)}));
  if(!(await store.list('contract_whatsapp_wabas',w=>w.contract_id===contract.id&&w.waba_config_id===phone.waba_config_id)).length)throw new HttpError(400,'O telefone não está disponível neste contrato.');
  const source=(await store.list(table,c=>c.whatsapp_phone_number_id===phoneId&&c.id!==channel.id))[0];
  if(source){
    const existing=(await store.list(transferTable,t=>(t.phone_number_id===phoneId||t.target_channel_id===channel.id)&&t.status==='PENDING'))[0];
    if(existing){if(existing.target_channel_id!==channel.id)throw new HttpError(409,'Telefone com transferência pendente.');return channelResponse(store,channel,contract);}
    const timestamp=now(),transfer=transferItem({id:randomUUID(),phone_number_id:phoneId,source_channel_id:source.id,source_contract_id:source.contract_id,target_channel_id:channel.id,target_contract_id:contract.id,requested_by_user_id:actor.id,requested_by_email:actor.email,status:'PENDING',requested_at:timestamp});
    const pending=channelItem({...channel,status:channel.whatsapp_phone_number_id?'CONNECTED':'PENDING_TRANSFER'});
    await store.transaction([store.guard(contract.id),store.putOperation(table,pending,'updated_at = :previous',{':previous':channel.updated_at}),store.putOperation(transferTable,transfer,'attribute_not_exists(id)'),history(store,phoneId,channel,'TRANSFER_REQUESTED',actor,transfer.id)]);return channelResponse(store,pending,contract);
  }
  const updated=channelItem({...channel,whatsapp_phone_number_id:phoneId,status:'CONNECTED'});
  const operations=[store.guard(contract.id),store.putOperation(table,updated,'updated_at = :previous',{':previous':channel.updated_at}),store.putOperation('whatsapp_phone_numbers',{...phone,assigned_channel_id:channel.id},'attribute_not_exists(assigned_channel_id) OR assigned_channel_id = :id',{':id':channel.id})];
  operations.push(history(store,phoneId,channel,'LINKED',actor));
  if(channel.whatsapp_phone_number_id&&channel.whatsapp_phone_number_id!==phoneId){const old=await store.get('whatsapp_phone_numbers',{id:channel.whatsapp_phone_number_id});if(old){const released={...old};delete released.assigned_channel_id;operations.push(store.putOperation('whatsapp_phone_numbers',released,'attribute_not_exists(assigned_channel_id) OR assigned_channel_id = :id',{':id':channel.id}));}}
  await store.transaction(operations);return channelResponse(store,updated,contract);
}
export async function channelOperation(store,operation,body,params,actor,contract) {
  writable(contract);
  if(['list','listByContract'].includes(operation))return Promise.all((await store.list(table,c=>c.contract_id===contract.id)).sort((a,b)=>a.name.localeCompare(b.name)).map(c=>channelResponse(store,c,contract)));
  if(operation==='listPhoneOptions') {const links=await store.list('contract_whatsapp_wabas',w=>w.contract_id===contract.id);return Promise.all((await store.list('whatsapp_phone_numbers',p=>links.some(w=>w.waba_config_id===p.waba_config_id))).map(p=>channelPhone(store,p)));}
  if(operation==='listTransferRequests')return Promise.all((await store.list(transferTable,t=>t.source_contract_id===contract.id||t.target_contract_id===contract.id)).map(t=>transferResponse(store,t)));
  if(['approveTransfer','rejectTransfer'].includes(operation)) {
    const old=must(await store.get(transferTable,{id:params.requestId}));if(old.source_contract_id!==contract.id)throw new HttpError(404,'Transferência não encontrada.');if(old.status!=='PENDING')throw new HttpError(409,'Transferência já resolvida.');
    const target=must(await store.get(table,{id:old.target_channel_id})),source=must(await store.get(table,{id:old.source_channel_id}));
    const updated=transferItem({...old,status:operation==='approveTransfer'?'APPROVED':'REJECTED',resolved_by_email:actor.email,resolved_by_user_id:actor.id,resolved_at:now()});
    const operations=[store.guard(contract.id)];if(target.contract_id!==contract.id)operations.push(store.guard(target.contract_id));
    operations.push(store.putOperation(transferTable,updated,'#status = :pending', {':pending':'PENDING'}));operations.at(-1).Put.ExpressionAttributeNames={'#status':'status'};
    if(operation==='approveTransfer'){
      if(source.whatsapp_phone_number_id!==old.phone_number_id)throw new HttpError(409,'O telefone mudou de canal.');
      const phone=must(await store.get('whatsapp_phone_numbers',{id:old.phone_number_id}));
      operations.push(store.putOperation(table,channelItem({...source,whatsapp_phone_number_id:null,status:'UNASSIGNED'}),'updated_at = :previous',{':previous':source.updated_at}));
      operations.push(store.putOperation(table,channelItem({...target,whatsapp_phone_number_id:phone.id,status:'CONNECTED'}),'updated_at = :previous',{':previous':target.updated_at}));
      operations.push(store.putOperation('whatsapp_phone_numbers',{...phone,assigned_channel_id:target.id},'attribute_not_exists(assigned_channel_id) OR assigned_channel_id = :id',{':id':source.id}));
      operations.push(history(store,phone.id,source,'UNLINKED',actor,old.id),history(store,phone.id,target,'TRANSFER_APPROVED',actor,old.id),history(store,phone.id,target,'LINKED',actor,old.id));
      if(target.whatsapp_phone_number_id&&target.whatsapp_phone_number_id!==phone.id){const previous=await store.get('whatsapp_phone_numbers',{id:target.whatsapp_phone_number_id});if(previous){delete previous.assigned_channel_id;operations.push(store.putOperation('whatsapp_phone_numbers',previous));}}
    }else{
      operations.push(store.putOperation(table,channelItem({...target,status:target.whatsapp_phone_number_id?'CONNECTED':'UNASSIGNED'}),'updated_at = :previous',{':previous':target.updated_at}),history(store,old.phone_number_id,target,'TRANSFER_REJECTED',actor,old.id));
    }
    await store.transaction(operations);return transferResponse(store,updated);
  }
  if(operation==='create') {
    const name=required(body.name,'Nome',180),type=required(body.type,'Tipo',40).toUpperCase();if(!['WHATSAPP','WEBCHAT'].includes(type))throw new HttpError(400,'Tipo de canal inválido.');
    const channels=await store.list(table,c=>c.contract_id===contract.id);if(contract.max_channel_count!=null&&channels.length>=contract.max_channel_count)throw new HttpError(400,'Limite de canais atingido.');
    const base=slugify(name);if(!base)throw new HttpError(400,'Nome inválido.');let slug=base;for(let i=2;channels.some(c=>c.slug===slug);i++)slug=`${base}-${i}`;
    const agent=type==='WEBCHAT'?required(body.agentName,'Nome do agente',120):null;
    if(agent&&(await store.list(table,c=>c.webchat_agent_key===agent.toLowerCase())).length)throw new HttpError(409,'Nome de agente já existe.');
    const item=channelItem({id:randomUUID(),contract_id:contract.id,name,slug,type,status:type==='WEBCHAT'?'CONNECTED':'UNASSIGNED',webchat_agent_name:agent,session_timeout_minutes:body.sessionTimeoutMinutes==null?1440:sessionTimeoutMinutes(body.sessionTimeoutMinutes),created_at:now()});
    if(body.whatsAppPhoneNumberId){const phone=must(await store.get('whatsapp_phone_numbers',{id:body.whatsAppPhoneNumberId}));if(type!=='WHATSAPP'||!(await store.list('contract_whatsapp_wabas',w=>w.contract_id===contract.id&&w.waba_config_id===phone.waba_config_id)).length)throw new HttpError(400,'Telefone indisponível para este canal.');}
    const operations=[store.advanceContract(contract),store.putOperation(table,item,'attribute_not_exists(id)')];if(agent)operations.push(reserveAgent(store,item));
    await store.transaction(operations);return body.whatsAppPhoneNumberId?bindPhone(store,item,contract,body.whatsAppPhoneNumberId,actor):channelResponse(store,item,contract);
  }
  const channel=must(params.channelSlug?(await store.list(table,c=>c.contract_id===contract.id&&c.slug===params.channelSlug))[0]:await store.get(table,{id:params.channelId}));
  if(channel.contract_id!==contract.id)throw new HttpError(404,'Canal não encontrado.');
  if(operation==='find')return channelResponse(store,channel,contract);
  if(operation==='listDebugTraces')return listTraces(store,channel,body?.limit);
  if(operation==='setDebug'){
    const updated=channelItem({...channel,debug_enabled:body?.enabled===true});
    await store.transaction([store.advanceContract(contract),store.putOperation(table,updated,'updated_at = :previous',{':previous':channel.updated_at})]);
    return channelResponse(store,updated,contract);
  }
  if(operation==='updatePhone')return bindPhone(store,channel,contract,body.whatsAppPhoneNumberId,actor);
  if(operation==='updateFlows') {
    const links=await store.list(linksTable,l=>l.channel_id===channel.id),operations=[store.advanceContract(contract),...links.map(l=>store.deleteOperation(linksTable,{id:l.id}))];
    if(body.primaryFlowId){const flow=must(await store.get('flows',{id:body.primaryFlowId}));if(flow.contract_id!==contract.id)throw new HttpError(400,'Fluxo não pertence ao contrato.');if(flow.published_version_id){const version=must(await store.get('flow_versions',{id:flow.published_version_id}));await assertPublishable(store,{...flow,definition_json:version.definition_json},contract.id,{channelTypes:[channel.type]});}const id=randomUUID(),timestamp=now();operations.push(store.putOperation(linksTable,{id,channel_id:channel.id,flow_id:flow.id,is_primary:true,created_at:timestamp,channel_key:channel.id,created_at_sort:`${timestamp}#${id}`}));}
    if(operations.length>1)await store.transaction(operations);return channelResponse(store,channel,contract);
  }
  if(operation==='deleteChannel') {
    if(actor.role!=='OWNER')throw new HttpError(403,'Apenas o administrador pode excluir canais.');
    for(const link of await store.list(linksTable,l=>l.channel_id===channel.id))await store.delete(linksTable,{id:link.id},contract.id);
    const operations=[store.guard(contract.id),store.deleteOperation(table,{id:channel.id})];
    if(channel.webchat_agent_key)operations.push(store.deleteOperation(table,{id:`AGENT#${channel.webchat_agent_key}`},'attribute_not_exists(id) OR channel_id = :id',{':id':channel.id}));
    if(channel.whatsapp_phone_number_id){const phone=await store.get('whatsapp_phone_numbers',{id:channel.whatsapp_phone_number_id});if(phone){delete phone.assigned_channel_id;operations.push(store.putOperation('whatsapp_phone_numbers',phone,'attribute_not_exists(assigned_channel_id) OR assigned_channel_id = :id',{':id':channel.id}));}}
    await store.transaction(operations);return null;
  }
  const updated=channelItem({...channel,name:required(body.name,'Nome',180),session_timeout_minutes:body.sessionTimeoutMinutes==null?(channel.session_timeout_minutes??1440):sessionTimeoutMinutes(body.sessionTimeoutMinutes)});
  if(channel.type==='WEBCHAT'){updated.webchat_agent_name=required(body.agentName,'Nome do agente',120);updated.webchat_agent_key=updated.webchat_agent_name.toLowerCase();if((await store.list(table,c=>c.id!==channel.id&&c.webchat_agent_key===updated.webchat_agent_key)).length)throw new HttpError(409,'Nome de agente já existe.');}
  const operations=[store.advanceContract(contract),store.putOperation(table,updated,'updated_at = :previous',{':previous':channel.updated_at})];
  if(updated.webchat_agent_key)operations.push(reserveAgent(store,updated));
  if(channel.webchat_agent_key&&channel.webchat_agent_key!==updated.webchat_agent_key)operations.push(store.deleteOperation(table,{id:`AGENT#${channel.webchat_agent_key}`},'attribute_not_exists(id) OR channel_id = :id',{':id':channel.id}));
  await store.transaction(operations);
  return channel.type==='WHATSAPP'?bindPhone(store,updated,contract,body.whatsAppPhoneNumberId,actor):channelResponse(store,updated,contract);
}
