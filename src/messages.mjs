import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { must, now, pick, fromItem, required } from './store.mjs';
import { graph } from './whatsapp.mjs';
import {persistMessage,conversationPage,conversationKey,pageOptions,pageResult,runtimeTable} from './runtime-records.mjs';
import {trace} from './channel-debug.mjs';
export function messageResponse(item){return{...pick(fromItem(item),['messageId','direction','messageKind','messageType','messagePayloadJson','status','contactId','contactName','contactUserId','contactWaId','occurredAt']),text:item.message_text??''};}
export async function conversation(store,channel,contactId){return(await store.query('engine_messages','contact_id',contactId).then(rows=>rows.filter(m=>m.channel_id===channel.id))).sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)).map(messageResponse);}
export async function channelMessages(store,operation,params,contract,query){
  const channel=must((await store.query('contract_channels','contract_key',contract.id,{index:'contract_name-index'}).then(rows=>rows.filter(c=>c.slug===params.channelSlug)))[0]);
  if(operation==='listConversation'){
    if(query?.get('paged')==='true'){const scope=conversationKey(channel.id,params.contactId);const page=await conversationPage(store,channel,params.contactId,pageOptions(query,scope));return pageResult(page.items.map(messageResponse),page.nextKey,scope);}
    return conversation(store,channel,params.contactId);
  }
  const scope=`CHANNEL#${channel.id}`;
  const selected=query?.get('contactId')?await store.get(runtimeTable,{pk:scope,sk:`CONTACT#${query.get('contactId')}`}):null;
  const page=query?.get('contactId')?{items:selected?[selected]:[],nextKey:undefined}:query?.get('paged')==='true'?await store.queryPage(runtimeTable,'list_pk',scope,{index:'list-index',forward:false,...pageOptions(query,scope)}):null;
  const messages=page?page.items:(await store.query(runtimeTable,'list_pk',scope,{index:'list-index',forward:false})),seen=new Set();
  const items=messages.filter(m=>{if(seen.has(m.contact_id))return false;seen.add(m.contact_id);return true;}).map(m=>({contactId:m.contact_id,name:m.contact_name,userId:m.contact_user_id,waId:m.contact_wa_id,lastDirection:m.direction,lastMessagePreview:m.message_text,lastStatus:m.status,lastOccurredAt:m.occurred_at,conversationPath:`/plataform/${contract.slug}/canais/${channel.slug}/contatos/${m.contact_id}`}));
  return page?pageResult(items,page.nextKey,scope):items;
}
export async function sendText(store,contract,channel,contact,text,kind='BUSINESS',flowMessage,deliveryContext={}){
  text=required(text,'Mensagem',20000);const payload=metaMessage(flowMessage??{text});let messageId=randomUUID(),status='SENT',phoneId;
  if(channel.type==='WHATSAPP'){
    // Cache only within this delivery, never across requests or contracts.
    deliveryContext.transport??=(async()=>{
      const phone=must(await store.get('whatsapp_phone_numbers',{id:channel.whatsapp_phone_number_id}));
      const waba=must(await store.get('whatsapp_wabas',{id:phone.waba_config_id}));
      return {phone,app:must(await store.get('whatsapp_apps',{id:waba.app_config_id}))};
    })();
    const {phone,app}=await deliveryContext.transport;
    phoneId=phone.id;
    await trace(store,channel,'whatsapp.send.request',{traceId:deliveryContext.traceId??null,to:contact.wa_id||contact.user_id,messageType:payload.type});
    try{
      const response=await graph(`${encodeURIComponent(phone.meta_phone_number_id)}/messages`,app.access_token,{method:'POST',body:{messaging_product:'whatsapp',to:contact.wa_id||contact.user_id,...payload}});
      messageId=must(response.messages?.[0]?.id,'A Meta não confirmou a mensagem.');
      await trace(store,channel,'whatsapp.send.accepted',{traceId:deliveryContext.traceId??null,messageId,messageType:payload.type});
    }catch(error){await trace(store,channel,'whatsapp.send.failed',{traceId:deliveryContext.traceId??null,message:error?.message??'Erro desconhecido',status:error?.status??null,meta:error?.meta??null});throw error;}
  }
  const timestamp=now(),item={contact_id:contact.contact_id,message_id:messageId,contract_id:contract.id,contract_slug:contract.slug,channel_id:channel.id,channel_slug:channel.slug,direction:'OUTBOUND',message_kind:kind,message_type:payload.type==='interactive'?payload.interactive.type:payload.type,message_text:text,message_payload_json:JSON.stringify({text:{body:text}}),contact_user_id:contact.user_id,contact_wa_id:contact.wa_id,contact_name:contact.username||contact.name,status,occurred_at:timestamp,updated_at:timestamp};
  if(flowMessage)item.message_payload_json=JSON.stringify(flowMessage);
  await persistMessage(store,item,phoneId);
  await trace(store,channel,'message.persisted',{traceId:deliveryContext.traceId??null,messageId,direction:'OUTBOUND',status});
  if(channel.type==='WEBCHAT'){
    const {broadcast}=await import('./websocket.mjs');
    await broadcast(store,channel.id,contact.contact_id,{id:messageId,kind,text,choices:flowMessage?.choices??[],list:flowMessage?.list??null,occurredAt:timestamp});
  }
  return messageResponse(item);
}

export function metaMessage(message){
  if(message.channelPayload)return message.channelPayload;
  const text=message.text||'Continuando atendimento.';
  if(message.list?.sections?.length)return{type:'interactive',interactive:{type:'list',body:{text:text.slice(0,1024)},action:{button:(message.list.buttonText||'Ver opções').slice(0,20),sections:message.list.sections.map((section,s)=>({title:(section.title||'Opções').slice(0,24),rows:section.rows.map((row,r)=>({id:`row_${s}_${r}`,title:row.title.slice(0,24),...(row.description?{description:row.description.slice(0,72)}:{})}))}))}}};
  if(message.choices?.length)return{type:'interactive',interactive:{type:'button',body:{text:text.slice(0,1024)},action:{buttons:message.choices.slice(0,3).map((title,i)=>({type:'reply',reply:{id:`button_${i}`,title:title.slice(0,20)}}))}}};
  return{type:'text',text:{body:text}};
}
