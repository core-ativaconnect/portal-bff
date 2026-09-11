import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { execute } from '../src/application.mjs';
import { parseCommand } from '../src/command.mjs';
import { resolveRoute } from '../src/router.mjs';
import { deleteContract } from '../src/deletion.mjs';

test('webchat, human handoff, assignment, messaging, release and closure without Java', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const suffix=randomUUID(),address=`desk-${suffix}@example.com`;let auth,company,contactId;
  const invoke=async(path,method='GET',body={},session=auth)=>{const command=parseCommand({path,method,'body-data':body});return execute(resolveRoute(command),command,session?{authorization:`Bearer ${session.accessToken}`}:{},store);};
  try{
    auth=await invoke('/api/v1/auth/register','POST',{name:'Attendant',email:address,password:'password-123'});
    company=await invoke('/api/v1/start/company','POST',{companyName:'Desk test',cnpj:'40432544000147',contactEmail:address,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste',neighborhood:'Centro',city:'São Paulo',state:'SP',slug:`desk-${suffix}`});
    const base=`/api/v1/platform/contracts/${company.slug}`;
    await invoke(`${base}/help-desk/attendants`,'PUT',{userIds:[auth.user.id]});
    const tag=await invoke(`${base}/help-desk/close-intents`,'POST',{name:'Resolvido',intentKey:'RESOLVIDO',enabled:true});
    const queue=await invoke(`${base}/help-desk/queues`,'POST',{name:'Suporte',tagKeys:[tag.intentKey],attendantUserIds:[auth.user.id],enabled:true});
    const definition={actions:[{id:'desk',type:'atendimento',config:{message:'Aguarde um atendente.',queueId:queue.id,intentVariable:'user.reason',attendantFinishActionId:'done'},nextActionId:null},{id:'done',type:'interaction',config:{message:'Encerrado: {{user.reason}}'},nextActionId:null}]};
    const flow=await invoke(`${base}/flows`,'POST',{name:'Atendimento',definitionJson:JSON.stringify(definition)});await invoke(`${base}/flows/${flow.slug}/publish`,'POST');
    const agentName=`desk-agent-${suffix}`,channel=await invoke(`${base}/channels`,'POST',{name:'Chat',type:'WEBCHAT',agentName});await invoke(`${base}/channels/${channel.slug}/flows`,'PUT',{primaryFlowId:flow.id});
    const chat=await invoke('/api/v1/public/webchat','POST',{type:'connect',agentName,contactName:'Visitante'},null);contactId=chat.contactId;assert.ok(chat.contactToken);assert.ok(chat.messages.some(m=>m.text==='Aguarde um atendente.'));
    await assert.rejects(invoke('/api/v1/public/webchat','POST',{type:'poll',agentName,contactId},null),e=>e.status===401);
    const tickets=await invoke(`${base}/help-desk/tickets`);assert.equal(tickets.length,1);const path=`${base}/help-desk/tickets/${tickets[0].id}`;
    assert.equal((await invoke(`${path}/assign`,'POST')).assignedUserId,auth.user.id);
    await invoke(`${path}/messages`,'POST',{text:'Olá, como posso ajudar?'});
    const polled=await invoke('/api/v1/public/webchat','POST',{type:'poll',agentName,contactToken:chat.contactToken},null);assert.ok(polled.messages.some(m=>m.text==='Olá, como posso ajudar?'));
    assert.equal((await invoke(`${path}/release`,'POST')).status,'OPEN');
    assert.equal((await invoke(`${path}/close`,'POST',{intent:'RESOLVIDO'})).status,'CLOSED');
    const final=await invoke('/api/v1/public/webchat','POST',{type:'poll',agentName,contactToken:chat.contactToken},null);assert.ok(final.messages.some(m=>m.text==='Encerrado: RESOLVIDO'));
  }finally{
    if(company)await deleteContract(store,company.id,company.slug);
    if(contactId)await store.delete('engine_contacts',{contact_id:contactId});
    if(auth)await store.delete('users',{email:address});
  }
});
