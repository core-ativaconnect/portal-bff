import { HttpError } from './command.mjs';
import { must, now, fromItem, pick } from './store.mjs';
import { conversation, sendText } from './messages.mjs';
import { processFlow } from './engine.mjs';
const fields=['id','contractId','contractSlug','ticketNumber','queueId','queueName','channelId','channelSlug','channelName','channelType','contactId','contactName','contactUserId','contactWaId','status','assignedUserId','assignedUserName','assignedUserEmail','closeReason','closeIntent','openedAt','assignedAt','closedAt','updatedAt'];
export const ticketResponse=(item,messages=[])=>({...Object.fromEntries(fields.map(key=>[key,fromItem(item)[key]??null])),messages});
async function canAttend(store,contractId,userId){const attendants=await store.list('contract_help_desk_attendants',a=>a.contract_id===contractId&&a.enabled);if(attendants.length&&!attendants.some(a=>a.user_id===userId&&a.active))throw new HttpError(403,'Usuário não configurado como atendente.');}
export async function helpdeskOperation(store,operation,body,params,actor,contract){
  if(operation==='listTickets')return(await store.list('helpdesk_tickets',t=>t.contract_id===contract.id)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).map(t=>ticketResponse(t));
  const ticket=must(await store.get('helpdesk_tickets',{id:params.ticketId}));if(ticket.contract_id!==contract.id)throw new HttpError(404,'Ticket não encontrado.');
  const channel=must(await store.get('contract_channels',{id:ticket.channel_id}));
  if(operation==='findTicket')return ticketResponse(ticket,await conversation(store,channel,ticket.contact_id));
  if(operation==='listMessages')return conversation(store,channel,ticket.contact_id);
  if(ticket.status==='CLOSED'){if(operation==='close')return ticketResponse(ticket);throw new HttpError(400,'Ticket já encerrado.');}
  await canAttend(store,contract.id,actor.id);
  let updated={...ticket,updated_at:now()};
  const assign=user=>{updated={...updated,status:'IN_PROGRESS',assigned_user_id:user.id,assigned_user_name:user.name,assigned_user_email:user.email,assigned_at:now()};};
  if(operation==='release'){updated.status='OPEN';updated.assigned_user_id=null;updated.assigned_user_name=null;updated.assigned_user_email=null;updated.assigned_at=null;}
  else if(operation==='transfer'){
    const queue=must(await store.get('contract_help_desk_queues',{id:ticket.queue_id}));if(queue.contract_id!==contract.id||!queue.attendant_user_ids?.includes(body.targetUserId))throw new HttpError(400,'O usuário não pertence à fila.');
    const target=must((await store.list('users',u=>u.id===body.targetUserId&&u.active))[0]);await canAttend(store,contract.id,target.id);assign(target);
  }else assign(actor);
  if(operation==='close'){
    const intent=String(body.intent??'').trim().replace(/[- ]/g,'_').toUpperCase(),intents=await store.list('contract_help_desk_close_intents',i=>i.contract_id===contract.id&&i.enabled);
    if(!intent||!(intents.length?intents.some(i=>i.intent_key===intent):intent==='ATENDIMENTO_CONCLUIDO'))throw new HttpError(400,'Tag de encerramento inválida.');
    const contact=must(await store.get('engine_contacts',{contact_id:ticket.contact_id}));
    const response=await processFlow(store,{flowId:ticket.flow_id,versionId:ticket.flow_version_id,simulatorUserId:ticket.contact_id,start:false},actor,{contractId:contract.id,resumeIntent:intent});
    for(const message of response.messages.filter(m=>m.kind==='BUSINESS'))if(message.text)await sendText(store,contract,channel,contact,message.text,'BUSINESS',message);
    updated.status='CLOSED';updated.close_reason='ATTENDANT';updated.close_intent=intent;updated.closed_at=now();
  }
  // Compare-and-swap stops simultaneous agents from overwriting each other's assignments.
  await store.put('helpdesk_tickets',updated,{previous:ticket,contractId:contract.id});
  if(operation==='sendMessage'){const contact=must(await store.get('engine_contacts',{contact_id:ticket.contact_id}));await sendText(store,contract,channel,contact,body.text);}
  return ticketResponse(updated,['sendMessage','close'].includes(operation)?await conversation(store,channel,ticket.contact_id):[]);
}
