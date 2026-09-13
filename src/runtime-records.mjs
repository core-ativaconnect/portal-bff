import {HttpError} from './command.mjs';
import {now} from './store.mjs';
import {changeOperations} from './conversation-sync.mjs';

export const runtimeTable='runtime_records';
export const messageReferenceKey=(phoneId,messageId)=>({pk:`META#${phoneId}`,sk:`MESSAGE#${messageId}`});
export const conversationKey=(channelId,contactId)=>`CONVERSATION#${channelId}#${contactId}`;
export const sessionReferenceKey=(contractId,userId,flowId,versionId)=>({pk:`SESSION#${contractId}#${userId}`,sk:`FLOW#${flowId}#${versionId}`});
const ticketKey=(channelId,contactId)=>({pk:conversationKey(channelId,contactId),sk:'TICKET'});

export async function findSession(store,contractId,userId,flowId,versionId){
  const ref=await store.get(runtimeTable,sessionReferenceKey(contractId,userId,flowId,versionId));
  const session=await store.get('engine_sessions',{session_key:ref?.session_key??`${userId}#${flowId}#${versionId}`});
  return session?.contract_id===contractId&&session.simulator_user_id===userId&&session.flow_id===flowId&&session.version_id===versionId?session:undefined;
}
export function sessionReferenceOperation(store,session){
  return store.putOperation(runtimeTable,{...sessionReferenceKey(session.contract_id,session.simulator_user_id,session.flow_id,session.version_id),contract_id:session.contract_id,session_key:session.session_key});
}
export async function activeTicket(store,channelId,contactId){
  const ref=await store.get(runtimeTable,ticketKey(channelId,contactId));
  if(!ref)return undefined;
  const ticket=await store.get('helpdesk_tickets',{id:ref.ticket_id});
  return ticket?.channel_id===channelId&&ticket.contact_id===contactId&&ticket.status!=='CLOSED'?ticket:undefined;
}
export async function saveTicket(store,ticket,{create=false,previous}={}){
  const condition=create?'attribute_not_exists(id)':previous?.updated_at?'updated_at = :previous':undefined;
  const writes=[store.guard(ticket.contract_id),store.putOperation('helpdesk_tickets',ticket,condition,condition&&!create?{':previous':previous.updated_at}:undefined)];
  const key=ticketKey(ticket.channel_id,ticket.contact_id);
  writes.push(ticket.status==='CLOSED'
    ?store.deleteOperation(runtimeTable,key,'attribute_not_exists(ticket_id) OR ticket_id = :id',{':id':ticket.id})
    :store.putOperation(runtimeTable,{...key,contract_id:ticket.contract_id,ticket_id:ticket.id},'attribute_not_exists(ticket_id) OR ticket_id = :id',{':id':ticket.id}));
  await store.transaction(writes);
}

export function messageOperations(store,item,phoneId){
  const writes=[store.putOperation('engine_messages',item,'attribute_not_exists(message_id)'),
    store.putOperation(runtimeTable,{pk:conversationKey(item.channel_id,item.contact_id),sk:`MESSAGE#${item.occurred_at}#${item.message_id}`,contract_id:item.contract_id,contact_id:item.contact_id,message_id:item.message_id})];
  if(phoneId&&item.direction==='OUTBOUND')writes.push(store.putOperation(runtimeTable,{
    ...messageReferenceKey(phoneId,item.message_id),contract_id:item.contract_id,channel_id:item.channel_id,contact_id:item.contact_id,
    message_id:item.message_id,contact_wa_id:item.contact_wa_id}));
  return writes;
}
export async function updateSummary(store,item){
  if(!item.occurred_at)return;
  const order=`${item.occurred_at}#${item.message_id}`;
  const summary={pk:`CHANNEL#${item.channel_id}`,sk:`CONTACT#${item.contact_id}`,contract_id:item.contract_id,
    list_pk:`CHANNEL#${item.channel_id}`,list_sk:order,contact_id:item.contact_id,channel_id:item.channel_id,
    message_id:item.message_id,contact_name:item.contact_name,contact_user_id:item.contact_user_id,contact_wa_id:item.contact_wa_id,
    message_text:item.message_text,direction:item.direction,status:item.status,occurred_at:item.occurred_at};
  try{await store.transaction([store.guard(item.contract_id),store.putOperation(runtimeTable,summary,'attribute_not_exists(list_sk) OR list_sk < :order',{':order':order})]);}
  catch(error){if(error.status!==409)throw error;}
}
export async function persistMessage(store,item,phoneId){
  for(let attempt=0;attempt<5;attempt++){
    const changes=await changeOperations(store,item);
    try{await store.transaction([store.guard(item.contract_id),...messageOperations(store,item,phoneId),...changes]);break;}
    catch(error){if(error.status!==409||attempt===4)throw error;}
  }
  await updateSummary(store,item);
}
export async function applyMetaStatus(store,phoneId,status){
  const ranks={SENT:1,DELIVERED:2,READ:3,FAILED:4},next=String(status.status).toUpperCase();
  if(!(next in ranks))return;
  const ref=await store.get(runtimeTable,messageReferenceKey(phoneId,status.id));
  // Keep early callbacks in SQS for retry/DLQ instead of silently dropping them.
  if(!ref)throw new HttpError(503,'Message reference not yet available.');
  if(ref.contact_wa_id!==status.recipient_id)throw new HttpError(403,'Status recipient mismatch.');
  const key={contact_id:ref.contact_id,message_id:ref.message_id};
  for(let attempt=0;attempt<5;attempt++){
    const row=await store.get('engine_messages',key);
    if(!row)throw new HttpError(503,'Message not yet available.');
    if(row.contract_id!==ref.contract_id||row.channel_id!==ref.channel_id||row.direction!=='OUTBOUND'||row.contact_wa_id!==status.recipient_id)throw new HttpError(403,'Status message mismatch.');
    const effective=ranks[next]>(ranks[row.status]??0)?next:row.status;
    const update={Update:{TableName:store.table('engine_messages'),Key:key,
      UpdateExpression:'SET #status = :next, status_payload_json = :payload, updated_at = :time',
      ConditionExpression:'#status = :old',ExpressionAttributeNames:{'#status':'status'},
      ExpressionAttributeValues:{':next':next,':old':row.status,':payload':JSON.stringify(status),':time':now()}}};
    try{if(effective!==row.status)await store.transaction([store.guard(ref.contract_id),update,...await changeOperations(store,row)]);}
    catch(error){if(error.status===409&&attempt<4)continue;throw error;}
    // A status for an older message must never replace the latest conversation.
    const summaryKey={pk:`CHANNEL#${ref.channel_id}`,sk:`CONTACT#${ref.contact_id}`};
    const summary=await store.get(runtimeTable,summaryKey);
    // Duplicate callbacks perform reads only; a stale summary can still recover.
    if(!summary||summary.message_id!==ref.message_id||(ranks[summary.status]??0)>=ranks[effective])return;
    const allowed=Object.keys(ranks).filter(s=>ranks[s]<ranks[effective]);
    try{await store.transaction([store.guard(ref.contract_id),{Update:{TableName:store.table(runtimeTable),Key:{pk:`CHANNEL#${ref.channel_id}`,sk:`CONTACT#${ref.contact_id}`},
      UpdateExpression:'SET #status = :next',ConditionExpression:`message_id = :id AND #status IN (${allowed.map((_,i)=>`:s${i}`).join(',')})`,ExpressionAttributeNames:{'#status':'status'},
      ExpressionAttributeValues:{':next':effective,':id':ref.message_id,...Object.fromEntries(allowed.map((s,i)=>[`:s${i}`,s]))}}}]);}catch(error){if(error.status!==409)throw error;}
    return;
  }
}

export function pageOptions(query,scope){
  const limit=Number(query?.get('limit')??50);let after;
  if(query?.get('cursor')){try{const cursor=JSON.parse(Buffer.from(query.get('cursor'),'base64url').toString());if(cursor.scope!==scope)throw new Error();after=cursor.key;}catch{throw new HttpError(400,'Invalid cursor.');}}
  return {limit,after};
}
export const pageResult=(items,nextKey,scope)=>({items,nextCursor:nextKey?Buffer.from(JSON.stringify({scope,key:nextKey})).toString('base64url'):null});
export async function conversationPage(store,channel,contactId,options={}){
  const scope=conversationKey(channel.id,contactId);
  const page=await store.queryPage(runtimeTable,'pk',scope,{sort:'sk',prefix:'MESSAGE#',forward:false,...options});
  const rows=await Promise.all(page.items.map(ref=>store.get('engine_messages',{contact_id:ref.contact_id,message_id:ref.message_id})));
  return {items:rows.filter(m=>m&&m.channel_id===channel.id&&m.contact_id===contactId&&m.contract_id===channel.contract_id).reverse(),nextKey:page.nextKey};
}
