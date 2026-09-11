import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { must, now, pick, fromItem, required } from './store.mjs';
import { graph } from './whatsapp.mjs';
export function messageResponse(item){return{...pick(fromItem(item),['messageId','direction','messageKind','messageType','messagePayloadJson','status','contactId','contactName','contactUserId','contactWaId','occurredAt']),text:item.message_text??''};}
export async function conversation(store,channel,contactId){return(await store.list('engine_messages',m=>m.channel_id===channel.id&&m.contact_id===contactId)).sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)).map(messageResponse);}
export async function channelMessages(store,operation,params,contract){
  const channel=must((await store.list('contract_channels',c=>c.contract_id===contract.id&&c.slug===params.channelSlug))[0]);
  if(operation==='listConversation')return conversation(store,channel,params.contactId);
  const messages=(await store.list('engine_messages',m=>m.channel_id===channel.id)).sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)),seen=new Set();
  return messages.filter(m=>{if(seen.has(m.contact_id))return false;seen.add(m.contact_id);return true;}).map(m=>({contactId:m.contact_id,name:m.contact_name,userId:m.contact_user_id,waId:m.contact_wa_id,lastDirection:m.direction,lastMessagePreview:m.message_text,lastStatus:m.status,lastOccurredAt:m.occurred_at,conversationPath:`/plataform/${contract.slug}/canais/${channel.slug}/contatos/${m.contact_id}`}));
}
export async function sendText(store,contract,channel,contact,text,kind='BUSINESS'){
  text=required(text,'Mensagem',20000);let messageId=randomUUID(),status='SENT';
  if(channel.type==='WHATSAPP'){
    const phone=must(await store.get('whatsapp_phone_numbers',{id:channel.whatsapp_phone_number_id}));
    const waba=must(await store.get('whatsapp_wabas',{id:phone.waba_config_id})),app=must(await store.get('whatsapp_apps',{id:waba.app_config_id}));
    const response=await graph(`${encodeURIComponent(phone.meta_phone_number_id)}/messages`,app.access_token,{method:'POST',body:{messaging_product:'whatsapp',to:contact.wa_id||contact.user_id,type:'text',text:{body:text}}});
    messageId=must(response.messages?.[0]?.id,'A Meta não confirmou a mensagem.');
  }
  const timestamp=now(),item={contact_id:contact.contact_id,message_id:messageId,contract_id:contract.id,contract_slug:contract.slug,channel_id:channel.id,channel_slug:channel.slug,direction:'OUTBOUND',message_kind:kind,message_type:'text',message_text:text,message_payload_json:JSON.stringify({text:{body:text}}),contact_user_id:contact.user_id,contact_wa_id:contact.wa_id,contact_name:contact.username||contact.name,status,occurred_at:timestamp,updated_at:timestamp};
  await store.transaction([store.guard(contract.id),store.putOperation('engine_messages',item,'attribute_not_exists(message_id)')]);return messageResponse(item);
}
