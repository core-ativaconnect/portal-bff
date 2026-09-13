import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Store, must, now } from './store.mjs';
import { HttpError } from './command.mjs';
import { runContactFlow } from './channel-runtime.mjs';
import { sendText } from './messages.mjs';
import {applyMetaStatus, persistMessage, updateSummary} from './runtime-records.mjs';
import {admitContact} from './billing.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const plain = (statusCode, body) => ({statusCode,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'},body});
export const inboundText = message => message.text?.body ?? message.button?.text ?? message.button?.payload
  ?? message.interactive?.button_reply?.title ?? message.interactive?.button_reply?.id
  ?? message.interactive?.list_reply?.title ?? message.interactive?.list_reply?.id ?? '';

export async function deliveries(store, payload, raw, signature, secrets) {
  if(payload?.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))throw new HttpError(400,'Payload Meta inválido.');
  if(!/^sha256=[a-f0-9]{64}$/.test(signature??''))throw new HttpError(403,'Assinatura Meta inválida.');
  const result=[];
  for(const entry of payload.entry){
    const waba=must((await store.query('whatsapp_wabas','waba_id_key',entry.id,{index:'waba_id-index'}))[0]);
    const app=must(await store.get('whatsapp_apps',{id:waba.app_config_id}));
    const secret=secrets[app.app_id];
    if(!secret||!same(signature,`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`))throw new HttpError(403,'Assinatura Meta inválida.');
    for(const change of entry.changes??[]){
      if(change.field!=='messages')continue;
      const value=change.value??{},phoneId=value.metadata?.phone_number_id;
      if(!phoneId)throw new HttpError(400,'Telefone Meta não informado.');
      const phone=must((await store.query('whatsapp_phone_numbers','meta_phone_key',phoneId,{index:'meta_phone-index'}).then(rows=>rows.filter(p=>p.waba_config_id===waba.id)))[0]);
      for(const message of value.messages??[]){
        if(!message.id||!message.from)throw new HttpError(400,'Mensagem Meta inválida.');
        result.push({phoneId:phone.id,wabaId:waba.id,message,profile:value.contacts?.find(c=>c.wa_id===message.from)?.profile});
      }
      for(const status of value.statuses??[]){
        if(!status.id||!status.recipient_id)throw new HttpError(400,'Status Meta inválido.');
        result.push({phoneId:phone.id,wabaId:waba.id,status});
      }
    }
  }
  return result;
}

export async function handler(event,_context,dependencies={}){
  const store=dependencies.store??new Store();
  try{
    const method=event.requestContext?.http?.method??event.httpMethod;
    if(method==='GET'){
      const query=event.queryStringParameters??Object.fromEntries(new URLSearchParams(event.rawQueryString));
      if(query['hub.mode']!=='subscribe'||!query['hub.challenge']||!query['hub.verify_token'])throw new HttpError(403,'Webhook verification rejected');
      const matches=await store.query('whatsapp_apps','verify_token_key',query['hub.verify_token'].toLowerCase(),{index:'verify_token-index'}).then(rows=>rows.filter(a=>same(a.verify_token,query['hub.verify_token'])));
      if(!matches.length)throw new HttpError(403,'Webhook verification rejected');
      return plain(200,query['hub.challenge']);
    }
    if(method!=='POST')return plain(405,'Method not allowed');
    const raw=event.isBase64Encoded?Buffer.from(event.body??'','base64'):Buffer.from(event.body??'');
    let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'Payload Meta inválido.');}
    const signature=Object.entries(event.headers??{}).find(([key])=>key.toLowerCase()==='x-hub-signature-256')?.[1];
    const secrets=dependencies.secrets??JSON.parse(process.env.APP_WHATSAPP_META_APP_SECRETS||'{}');
    const events=await deliveries(store,payload,raw,signature,secrets);
    // All entries are authenticated before any is accepted for processing.
    for(const delivery of events){
      if(dependencies.enqueue)await dependencies.enqueue(delivery);
      else if(process.env.IS_OFFLINE)await processDelivery(delivery,store);
      else{
        if(!process.env.PORTAL_META_QUEUE_URL)throw new Error('Meta queue is not configured');
        const body=JSON.stringify(delivery);
        await new SQSClient({region:store.settings.region}).send(new SendMessageCommand({QueueUrl:process.env.PORTAL_META_QUEUE_URL,
          MessageBody:body,MessageGroupId:hash(`${delivery.phoneId}:${delivery.message?.from??delivery.status.recipient_id}`),MessageDeduplicationId:hash(body)}));
      }
    }
    return plain(200,'EVENT_RECEIVED');
  }catch(error){
    if(!(error instanceof HttpError))console.error(JSON.stringify({event:'meta.ingress.failed',name:error.name}));
    return plain(error instanceof HttpError?error.status:503,error instanceof HttpError?error.message:'Webhook temporarily unavailable');
  }finally{store.reportMetrics?.('meta.ingress');}
}

export async function processDelivery(delivery,store=new Store(),dependencies={}){
  const phone=must(await store.get('whatsapp_phone_numbers',{id:delivery.phoneId}));
  if(phone.waba_config_id!==delivery.wabaId)throw new HttpError(409,'Vínculo WABA alterado.');
  if(delivery.status)return applyMetaStatus(store,phone.id,delivery.status);
  const candidates=await store.query('contract_channels','phone_key',phone.id,{index:'phone-index'});
  let channel;
  for(const candidate of candidates){
    const current=await store.get('contract_channels',{id:candidate.id});
    if(current?.type==='WHATSAPP'&&current.whatsapp_phone_number_id===phone.id){channel=current;break;}
  }
  if(!channel){if(candidates.length)throw new HttpError(503,'Channel binding is updating.');return;}
  const contract=must(await store.get('contracts',{id:channel.contract_id}));
  const today=now().slice(0,10);
  if(contract.deletion_in_progress||contract.status!=='ACTIVE'||contract.start_date>today||contract.end_date<today)return;
  const message=delivery.message,id=`meta-${hash(`${phone.id}:${message.id}`)}`;
  let job=await store.get('jobs',{id});
  if(job?.state==='COMPLETED')return;
  const timestamp=Date.now(),lease=randomUUID();
  job={...job,id,contract_id:contract.id,state:'RUNNING',lease,lease_until:timestamp+180000,created_at:job?.created_at??now(),expires_at:Math.floor(timestamp/1000)+1209600};
  await store.transaction([store.guard(contract.id),store.putOperation('jobs',job,'attribute_not_exists(lease_until) OR lease_until < :now',{':now':timestamp})]);
  let savedJob=structuredClone(job);
  const checkpoint=async()=>{
    const names={},values={':lease':lease},set=[],remove=[];
    for(const field of new Set([...Object.keys(savedJob),...Object.keys(job)])){
      if(JSON.stringify(savedJob[field])===JSON.stringify(job[field]))continue;
      const alias=`#f${Object.keys(names).length}`,value=`:v${Object.keys(names).length}`;names[alias]=field;
      if(job[field]===undefined)remove.push(alias);else{values[value]=job[field];set.push(`${alias} = ${value}`);}
    }
    if(!set.length&&!remove.length)return;
    await store.transaction([store.guard(contract.id),{Update:{TableName:store.table('jobs'),Key:{id},
      UpdateExpression:[set.length?`SET ${set.join(', ')}`:'',remove.length?`REMOVE ${remove.join(', ')}`:''].filter(Boolean).join(' '),
      ConditionExpression:'lease = :lease',ExpressionAttributeNames:names,ExpressionAttributeValues:values}}]);
    savedJob=structuredClone(job);
  };
  try{
    const admission=await admitContact(store,contract.id,channel,{wa_id:message.from},job.created_at);
    if(!admission.allowed){job.state='COMPLETED';job.blocked_reason='MAU_LIMIT';delete job.lease_until;await checkpoint();return;}
    let contact=await store.get('engine_contacts',{contact_id:hash(`${channel.id}:${message.from}`)});
    if(!contact)contact=(await store.query('engine_contacts','wa_id',message.from,{index:'wa_id-index'})).find(c=>!c.channel_id||c.channel_id===channel.id);
    if(!contact)contact=(await store.query('engine_contacts','user_id',message.from,{index:'user_id-index'})).find(c=>!c.channel_id||c.channel_id===channel.id);
    if(!contact){contact={contact_id:hash(`${channel.id}:${message.from}`),channel_id:channel.id,user_id:message.from,wa_id:message.from,username:delivery.profile?.name??message.from,created_at:now(),updated_at:now()};
      await store.transaction([store.guard(contract.id),store.putOperation('engine_contacts',contact)]);}
    const existing=await store.get('engine_messages',{contact_id:contact.contact_id,message_id:message.id});
    if(!existing){
      await persistMessage(store,{
        contact_id:contact.contact_id,message_id:message.id,contract_id:contract.id,contract_slug:contract.slug,
        channel_id:channel.id,channel_slug:channel.slug,direction:'INBOUND',message_kind:'USER',message_type:message.type,
        message_text:inboundText(message),message_payload_json:JSON.stringify(message),contact_user_id:contact.user_id,
        contact_wa_id:contact.wa_id,contact_name:contact.username,status:'RECEIVED',
        occurred_at:message.timestamp?new Date(Number(message.timestamp)*1000).toISOString():now(),updated_at:now()});
    }
    if(existing)await updateSummary(store,existing);
    if(!job.processed){
      const response=await (dependencies.runFlow??runContactFlow)(store,contract,channel,contact,inboundText(message),`${id}-engine`);
      job.processed=true;job.messages=response?.messages.filter(m=>m.kind==='BUSINESS')??[];job.sent_count=0;
      await checkpoint();
    }
    const deliveryContext={};
    for(let index=job.sent_count;index<job.messages.length;index++){
      const outgoing=job.messages[index];
      await (dependencies.send??sendText)(store,contract,channel,contact,outgoing.text||'Continuando atendimento.','BUSINESS',outgoing,deliveryContext);
      job.sent_count=index+1;await checkpoint();
    }
    job.state='COMPLETED';delete job.lease_until;delete job.messages;await checkpoint();
  }catch(error){delete job.lease_until;await checkpoint().catch(()=>{});throw error;}
}

export async function worker(event){
  // Batch size 1 preserves FIFO order when a delivery needs a retry.
  for(const record of event.Records??[]){
    const store=new Store(),delivery=JSON.parse(record.body);
    try{await processDelivery(delivery,store);}
    finally{store.reportMetrics(delivery.status?'meta.status':'meta.message');}
  }
}
