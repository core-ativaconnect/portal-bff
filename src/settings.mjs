import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { HttpError } from './command.mjs';
import { now, must, required, email, snake, fromItem, pick } from './store.mjs';
import { writable } from './contracts.mjs';

export const settingsTables={AiProviders:'contract_ai_provider_configs',EmailConnections:'contract_email_connections',Queues:'contract_help_desk_queues',CloseIntents:'contract_help_desk_close_intents',Attendants:'contract_help_desk_attendants'};
const common=['id','contractId','name','enabled','createdAt','updatedAt'];
const mask=value=>!value?'':value.length<=8?'••••':`${value.slice(0,4)}••••••${value.slice(-4)}`;
export function settingResponse(kind,item) {
  const data=fromItem(item);
  if(kind==='AiProviders') return {...pick(data,[...common,'providerType','model','apiKey','baseUrl','maxInputTokens','maxOutputTokens','temperature']),maskedApiKey:mask(item.api_key)};
  if(kind==='EmailConnections') return {...pick(data,[...common,'providerType','fromEmail','username','host','port','security']),maskedSecret:mask(item.secret)};
  if(kind==='Queues') return {...pick(data,[...common,'description']),attendantUserIds:item.attendant_user_ids??[],tagKeys:item.tag_keys??[]};
  if(kind==='Attendants') return {...pick(data,common),name:item.user_name,email:item.user_email,userId:item.user_id,active:item.active};
  return pick(data,[...common,'intentKey','description']);
}
export async function settingsList(store,kind,contractId) {
  return (await store.list(settingsTables[kind],i=>i.contract_id===contractId)).sort((a,b)=>(a.name??a.user_name).localeCompare(b.name??b.user_name)).map(i=>settingResponse(kind,i));
}
function bool(value) { if(typeof value!=='boolean') throw new HttpError(400,'enabled inválido.');return value; }
function array(value) { if(!Array.isArray(value)||value.some(v=>typeof v!=='string')) throw new HttpError(400,'Lista inválida.');return [...new Set(value)]; }
function intentKey(value) { const key=required(value,'Chave',120).replace(/[- ]/g,'_').toUpperCase();if(!/^[A-Z0-9_]+$/.test(key))throw new HttpError(400,'Chave inválida.');return key; }
export async function settingsOperation(store,kind,operation,body,params,contract) {
  const table=settingsTables[kind];writable(contract);
  if(operation.startsWith('list')) return settingsList(store,kind,contract.id);
  const rows=await store.list(table,i=>i.contract_id===contract.id);
  if(kind==='Attendants') {
    const ids=array(body.userIds??[]), users=await store.list('users');
    const selected=[];
    for(const id of ids) {
      const u=must(users.find(u=>u.id===id&&u.active),'Atendente inexistente ou inativo.');
      if(u.role!=='OWNER'&&!await store.get('contract_access',{id:`${contract.id}#${u.id}`}))throw new HttpError(400,'O atendente não tem acesso ao contrato.');
      const old=rows.find(r=>r.user_id===id); const timestamp=now();
      selected.push({...old,id:old?.id??randomUUID(),contract_id:contract.id,user_id:id,user_name:u.name,user_email:u.email,active:u.active,enabled:true,created_at:old?.created_at??timestamp,updated_at:timestamp,contract_key:contract.id,name_sort:`${u.name.toLowerCase()}#${id}`});
    }
    if(rows.length+selected.length>98)throw new HttpError(400,'A lista ultrapassa o limite de atualização atômica.');
    const operations=[store.guard(contract.id),...rows.filter(r=>!ids.includes(r.user_id)).map(r=>store.deleteOperation(table,{id:r.id})),...selected.map(r=>store.putOperation(table,r))];
    if(operations.length>1)await store.transaction(operations);return selected.map(i=>settingResponse(kind,i));
  }
  const id=params.providerId??params.connectionId??params.queueId??params.intentId;
  const old=id?must(rows.find(i=>i.id===id)):undefined;
  if(operation.startsWith('delete')) {await store.delete(table,{id:old.id},contract.id);return null;}
  if(operation==='testEmailConnection') {
    if(!old.enabled)throw new HttpError(400,'Conexão desativada.');
    const target=email(body.targetEmail);
    const transport=nodemailer.createTransport({host:old.host,port:old.port,secure:old.security==='SSL_TLS',requireTLS:old.security==='STARTTLS',auth:{user:old.username,pass:old.secret},connectionTimeout:10000,socketTimeout:15000});
    try {await transport.sendMail({from:old.from_email,to:target,subject:'Teste de conexão Tiudi',text:`Conexão ${old.name} funcionando. ${now()}`});}
    catch {throw new HttpError(502,'Não foi possível enviar o email. Verifique a conexão e as credenciais.');}
    finally{transport.close();}return{success:true,message:`E-mail de teste enviado com sucesso para ${target}.`};
  }
  const name=required(body.name,'Nome',180), timestamp=now();
  if(rows.some(i=>i.id!==id&&i.name.toLowerCase()===name.toLowerCase()))throw new HttpError(409,'Já existe um registro com esse nome.');
  const item={...old,id:old?.id??randomUUID(),contract_id:contract.id,name,enabled:bool(body.enabled),created_at:old?.created_at??timestamp,updated_at:timestamp,contract_key:contract.id};
  item.name_sort=`${name.toLowerCase()}#${item.id}`;
  if(kind==='AiProviders') {
    if(!['OPENAI','ANTHROPIC','GEMINI'].includes(body.providerType))throw new HttpError(400,'Provedor inválido.');
    item.provider_type=body.providerType;item.model=required(body.model,'Modelo',180);item.api_key=required(body.apiKey,'API key',4096);item.base_url=body.baseUrl?.trim()||null;
    for(const field of ['maxInputTokens','maxOutputTokens']) {if(!Number.isInteger(body[field])||body[field]<1||body[field]>200000)throw new HttpError(400,'Limite de tokens inválido.');item[snake(field)]=body[field];}
    if(typeof body.temperature!=='number'||body.temperature<0||body.temperature>2)throw new HttpError(400,'Temperatura inválida.');item.temperature=body.temperature;
  }else if(kind==='EmailConnections') {
    if(!['GMAIL','OUTLOOK','SMTP'].includes(body.providerType))throw new HttpError(400,'Provedor inválido.');
    item.provider_type=body.providerType;item.from_email=email(body.fromEmail);item.username=email(body.username);item.secret=body.secret?.trim()||old?.secret;
    if(!item.secret)throw new HttpError(400,'Senha da conexão obrigatória.');
    const presets={GMAIL:'smtp.gmail.com',OUTLOOK:'smtp.office365.com'};
    item.host=presets[body.providerType]??required(body.host,'Host',255);item.port=presets[body.providerType]?587:body.port;item.security=presets[body.providerType]?'STARTTLS':body.security;
    if(!Number.isInteger(item.port)||item.port<1||item.port>65535||!['NONE','STARTTLS','SSL_TLS'].includes(item.security))throw new HttpError(400,'Porta ou segurança inválida.');
  }else {
    item.description=body.description?.trim()??'';
    if(kind==='CloseIntents') {item.intent_key=intentKey(body.intentKey);if(rows.some(r=>r.id!==id&&r.intent_key===item.intent_key))throw new HttpError(409,'Chave já cadastrada.');}
    if(kind==='Queues') {
      item.attendant_user_ids=array(body.attendantUserIds??[]);item.tag_keys=array(body.tagKeys??[]).map(intentKey);
      const attendants=await store.list('contract_help_desk_attendants',a=>a.contract_id===contract.id&&a.enabled&&a.active);
      const tags=await store.list('contract_help_desk_close_intents',a=>a.contract_id===contract.id&&a.enabled);
      if(item.attendant_user_ids.some(id=>!attendants.some(a=>a.user_id===id))||item.tag_keys.some(key=>!tags.some(t=>t.intent_key===key)))throw new HttpError(400,'Atendente ou tag não pertence ao contrato.');
    }
  }
  await store.put(table,item,{create:!old,contractId:contract.id,previous:old});return settingResponse(kind,item);
}
