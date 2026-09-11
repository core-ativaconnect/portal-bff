import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {deleteContract} from '../src/deletion.mjs';

test('Offline: real HTTP Desk and WebSocket receive an attendant reply and reconnect', {skip:!process.env.RUN_OFFLINE_TESTS,timeout:25000},async()=>{
  const {default:WebSocket}=await import('ws');
  const store=new Store();assert.equal(store.settings.local,true);
  const suffix=randomUUID(),email=`socket-${suffix}@example.com`;let auth,company,socket,contactId;
  const http=process.env.PORTAL_TEST_HTTP_URL||'http://localhost:3001';
  assert.ok(['localhost','127.0.0.1'].includes(new URL(http).hostname));
  const call=async(path,method='GET',body={})=>{
    const response=await fetch(`${http}/commands`,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth.accessToken}`}:{})},body:JSON.stringify({path,method,'body-data':body}),signal:AbortSignal.timeout(5000)});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
  const messages=[];
  const waitFor=async predicate=>{
    const end=Date.now()+8000;
    while(Date.now()<end){const found=messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,20));}
    throw new Error(`WebSocket response timeout: ${JSON.stringify(messages)}`);
  };
  const open=async()=>{
    socket=new WebSocket('ws://localhost:3003/ws/webchat');
    socket.on('message',data=>messages.push(JSON.parse(data.toString())));
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  };
  const close=async()=>{if(socket){const current=socket;socket=null;await new Promise(resolve=>{current.once('close',resolve);current.close();});}};
  try{
    auth=await call('/api/v1/auth/register','POST',{name:'Attendant',email,password:'password-123'});
    company=await call('/api/v1/start/company','POST',{companyName:'Live WS test',cnpj:'40432544000147',contactEmail:email,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste',neighborhood:'Centro',city:'São Paulo',state:'SP',slug:`socket-${suffix}`});
    const base=`/api/v1/platform/contracts/${company.slug}`;
    await call(`${base}/help-desk/attendants`,'PUT',{userIds:[auth.user.id]});
    const queue=await call(`${base}/help-desk/queues`,'POST',{name:'Support',enabled:true,attendantUserIds:[auth.user.id]});
    const flow=await call(`${base}/flows`,'POST',{name:'Desk',definitionJson:JSON.stringify({actions:[{id:'desk',type:'atendimento',config:{message:'Aguarde atendimento',queueId:queue.id},nextActionId:null}]})});
    await call(`${base}/flows/${flow.slug}/publish`,'POST');
    const agentName=`live-${suffix}`,channel=await call(`${base}/channels`,'POST',{name:'Chat',type:'WEBCHAT',agentName});
    await call(`${base}/channels/${channel.slug}/flows`,'PUT',{primaryFlowId:flow.id});
    await open();socket.send(JSON.stringify({type:'connect',agentName}));
    const connected=await waitFor(e=>e.type==='connected');contactId=connected.contactId;
    await waitFor(e=>e.messages?.some(m=>m.text==='Aguarde atendimento'));
    const rest=async(path,method='GET',body)=>{
      const response=await fetch(`${http}/flow-desk${path}`,{method,headers:{authorization:`Bearer ${auth.accessToken}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,200);return response.json();
    };
    assert.equal((await rest('/api/v1/auth/me')).email,email);
    const tickets=await rest(`${base}/help-desk/tickets`);
    await rest(`${base}/help-desk/tickets/${tickets[0].id}/messages`,'POST',{text:'Resposta do atendente via REST'});
    await waitFor(e=>e.messages?.some(m=>m.text==='Resposta do atendente via REST'));
    socket.send(JSON.stringify({type:'ping'}));await waitFor(e=>e.type==='pong');
    await close();messages.length=0;await open();
    socket.send(JSON.stringify({type:'connect',agentName,contactToken:connected.contactToken}));
    assert.equal((await waitFor(e=>e.type==='connected')).contactId,contactId);
    await waitFor(e=>e.messages?.some(m=>m.text==='Resposta do atendente via REST'));
    const webhook=await fetch(`${http}/v1/webhook/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`);
    assert.equal(webhook.status,403);
  }finally{
    await close();
    if(company)await deleteContract(store,company.id,company.slug);
    if(contactId)await store.delete('engine_contacts',{contact_id:contactId});
    if(auth)await store.delete('users',{email});
  }
});
