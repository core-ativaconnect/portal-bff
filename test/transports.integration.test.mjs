import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store,now} from '../src/store.mjs';
import {execute} from '../src/application.mjs';
import {parseCommand} from '../src/command.mjs';
import {resolveRoute} from '../src/router.mjs';
import {handler as websocket,broadcast} from '../src/websocket.mjs';
import {handler as desk} from '../src/desk.mjs';
import {processDelivery} from '../src/meta-webhook.mjs';
import {deleteContract} from '../src/deletion.mjs';

test('DynamoDB: WebSocket session, Desk isolation, WhatsApp processing/retry/status/handoff', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);
  const suffix=randomUUID(),email=`transports-${suffix}@example.com`,connectionId=randomUUID();let auth,company,contactId;
  const invoke=async(path,method='GET',body={})=>{const command=parseCommand({path,method,'body-data':body});return execute(resolveRoute(command),command,auth?{authorization:`Bearer ${auth.accessToken}`}:{},store);};
  const phoneId=randomUUID(),waChannelId=randomUUID(),wabaId=randomUUID();
  const deliveries=[];
  try{
    auth=await invoke('/api/v1/auth/register','POST',{name:'Attendant',email,password:'password-123'});
    company=await invoke('/api/v1/start/company','POST',{companyName:'Transport test',cnpj:'40432544000147',contactEmail:email,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste',neighborhood:'Centro',city:'São Paulo',state:'SP',slug:`transport-${suffix}`});
    const base=`/api/v1/platform/contracts/${company.slug}`;
    await invoke(`${base}/help-desk/attendants`,'PUT',{userIds:[auth.user.id]});
    const queue=await invoke(`${base}/help-desk/queues`,'POST',{name:'Support',enabled:true,attendantUserIds:[auth.user.id],tagKeys:[]});
    const definition={actions:[{id:'ask',type:'input',config:{message:'Qual seu nome?',userVariable:'user.name'},nextActionId:'desk'},
      {id:'desk',type:'atendimento',config:{message:'Aguarde {{user.name}}',queueId:queue.id},nextActionId:null}]};
    const flow=await invoke(`${base}/flows`,'POST',{name:'Support',definitionJson:JSON.stringify(definition)});
    await invoke(`${base}/flows/${flow.slug}/publish`,'POST');
    const agentName=`ws-${suffix}`,channel=await invoke(`${base}/channels`,'POST',{name:'Chat',type:'WEBCHAT',agentName});
    await invoke(`${base}/channels/${channel.slug}/flows`,'PUT',{primaryFlowId:flow.id});
    const envelopes=[],post=async(_connection,envelope)=>envelopes.push(envelope);
    await store.put('websocket_connections',{id:connectionId,endpoint:'https://test.invalid',expires_at:Math.floor(Date.now()/1000)+7200},{create:true});
    const ws=body=>websocket({requestContext:{connectionId,routeKey:'$default'},body:JSON.stringify(body)},null,{store,post});
    await ws({type:'message',text:'no session'});assert.equal(envelopes.pop().status,401);
    await ws({type:'connect',agentName});const connected=envelopes.pop();contactId=connected.contactId;
    assert.equal(connected.type,'connected');assert.ok(connected.contactToken);
    await ws({type:'message',text:'Maria',contactId:'forged',agentName:'wrong',contactToken:'wrong'});
    assert.ok(envelopes.pop().messages.some(m=>m.text==='Aguarde Maria'));
    await ws({type:'ping'});assert.equal(envelopes.pop().type,'pong');
    await broadcast(store,channel.id,contactId,{id:'push',text:'Hello'},post);assert.equal(envelopes.pop().messages[0].text,'Hello');
    const tokenHeaders={authorization:`Bearer ${auth.accessToken}`};
    const rest=(path,headers=tokenHeaders)=>desk({rawPath:`/flow-desk${path}`,requestContext:{http:{method:'GET'}},headers},null,{execute:(r,c,h)=>execute(r,c,h,store)});
    assert.equal((await rest('/api/v1/auth/me')).statusCode,200);
    assert.equal((await rest(`${base}/help-desk/tickets`,{})).statusCode,401);
    assert.equal((await rest('/api/v1/platform/contracts/not-owned/help-desk/tickets')).statusCode,404);
    assert.equal(JSON.parse((await rest(`${base}/help-desk/tickets`)).body).length,1);
    // A gone connection is removed; durable message history is unaffected.
    await broadcast(store,channel.id,contactId,{id:'gone'},async()=>{throw Object.assign(new Error(),{name:'GoneException'});});
    assert.equal(await store.get('websocket_connections',{id:connectionId}),undefined);
    await store.put('whatsapp_phone_numbers',{id:phoneId,waba_config_id:wabaId,meta_phone_number_id:suffix},{create:true});
    await store.put('contract_channels',{id:waChannelId,contract_id:company.id,slug:'whatsapp',name:'WhatsApp',type:'WHATSAPP',status:'CONNECTED',whatsapp_phone_number_id:phoneId},{create:true,contractId:company.id});
    await store.put('contract_channel_flows',{id:`wa-${suffix}`,channel_id:waChannelId,flow_id:flow.id,is_primary:true},{create:true,contractId:company.id});
    const send=async(_s,contract,ch,contact,text)=>{deliveries.push(text);await store.transaction([store.putOperation('engine_messages',{contact_id:contact.contact_id,message_id:`out-${deliveries.length}`,channel_id:ch.id,contract_id:contract.id,direction:'OUTBOUND',contact_wa_id:contact.wa_id,status:'SENT'})]);};
    const message={phoneId,wabaId,message:{id:`in-${suffix}`,from:`55${suffix}`,type:'text',text:{body:'Oi'}}};
    await processDelivery(message,store,{send});await processDelivery(message,store,{send});
    assert.deepEqual(deliveries,['Qual seu nome?']);
    const second={...message,message:{...message.message,id:`in2-${suffix}`,text:{body:'João'}}};
    // Failure after the engine commits must retry the saved response without advancing it twice.
    await assert.rejects(processDelivery(second,store,{send:async()=>{throw new Error('temporary');}}));
    await processDelivery(second,store,{send});assert.equal(deliveries.at(-1),'Aguarde João');
    assert.equal((await store.list('helpdesk_tickets',t=>t.channel_id===waChannelId)).length,1);
    await processDelivery({...message,message:{...message.message,id:`in3-${suffix}`,text:{body:'Preciso de ajuda'}}},store,{send});
    assert.equal(deliveries.length,2);
    await processDelivery({...message,message:{...message.message,id:`close-${suffix}`,text:{body:'encerrar atendimento'}}},store,{send});
    assert.equal((await store.list('helpdesk_tickets',t=>t.channel_id===waChannelId))[0].close_reason,'CUSTOMER');
    const status={phoneId,wabaId,status:{id:'out-1',recipient_id:message.message.from,status:'read'}};
    await processDelivery(status,store);await processDelivery({...status,status:{...status.status,status:'delivered'}},store);
    assert.equal((await store.list('engine_messages',m=>m.channel_id===waChannelId&&m.message_id==='out-1'))[0].status,'READ');
    const sourceId=randomUUID(),targetId=randomUUID(),sourceVersion=randomUUID(),targetVersion=randomUUID();
    for(const [id,version,definition] of [
      [sourceId,sourceVersion,{actions:[{id:'swap',type:'flow_swap',config:{targetFlowId:targetId,targetActionId:'input'}}]}],
      [targetId,targetVersion,{actions:[{id:'input',type:'input',config:{message:'Nome?',userVariable:'user.name'},nextActionId:'answer'},{id:'answer',type:'interaction',config:{message:'Olá {{user.name}}'}}]}],
    ]){
      await store.put('flows',{id,contract_id:company.id,name:'Swap',definition_json:JSON.stringify(definition)},{create:true,contractId:company.id});
      await store.put('flow_versions',{id:version,flow_id:id,status:'PUBLISHED',is_current:true,version_number:1,definition_json:JSON.stringify(definition)},{create:true,contractId:company.id});
    }
    const swapped=await invoke('/api/v1/engine/process','POST',{flowId:sourceId,versionId:sourceVersion,start:true,simulatorUserId:suffix});
    assert.equal(swapped.flowId,targetId);
    const resumed=await invoke('/api/v1/engine/process','POST',{flowId:targetId,versionId:targetVersion,start:false,input:'Ana',simulatorUserId:suffix});
    assert.ok(resumed.messages.some(m=>m.text==='Olá Ana'));
  }finally{
    if(company){
      for(const row of await store.list('jobs',j=>j.contract_id===company.id))await store.delete('jobs',{id:row.id});
      for(const row of await store.list('engine_contacts',c=>c.channel_id===waChannelId))await store.delete('engine_contacts',{contact_id:row.contact_id});
      await deleteContract(store,company.id,company.slug);
    }
    await store.delete('websocket_connections',{id:connectionId});
    await store.delete('whatsapp_phone_numbers',{id:phoneId});
    if(contactId)await store.delete('engine_contacts',{contact_id:contactId});
    if(auth)await store.delete('users',{email});
  }
});
