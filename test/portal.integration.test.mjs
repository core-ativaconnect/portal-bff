import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { execute } from '../src/application.mjs';
import { parseCommand } from '../src/command.mjs';
import { resolveRoute } from '../src/router.mjs';
import { deleteContract } from '../src/deletion.mjs';

test('native portal: tenant isolation, flows, versions, engine, channels and cascade deletion', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'}, async()=>{
  const store=new Store();assert.equal(store.settings.local,true);
  const suffix=randomUUID(),address=`portal-suite-${suffix}@example.com`;let auth,other,company;
  const invoke=async(path,method='GET',body={},session=auth)=>{const command=parseCommand({path,method,'body-data':body});return execute(resolveRoute(command),command,session?{authorization:`Bearer ${session.accessToken}`}:{},store);};
  try{
    auth=await invoke('/api/v1/auth/register','POST',{name:'Integration',email:address,password:'password-123'});
    company=await invoke('/api/v1/start/company','POST',{companyName:'Integration',cnpj:'40432544000147',contactEmail:address,contactPhone:'1143134620',zipCode:'04709110',address:'Rua 1',neighborhood:'Centro',city:'São Paulo',state:'SP',slug:`test-${suffix}`});
    const base=`/api/v1/platform/contracts/${company.slug}`;
    assert.equal((await invoke('/api/v1/platform/contracts')).length,1);
    await assert.rejects(invoke('/api/v1/contracts'),e=>e.status===403);
    other=await invoke('/api/v1/auth/register','POST',{name:'Other tenant',email:`other-${address}`,password:'password-123'});
    await assert.rejects(invoke(base,'GET',{},other),e=>e.status===404);
    const definition={name:'Teste',entryActionId:'ask',actions:[{id:'ask',type:'input',config:{message:'Qual seu nome?',userVariable:'user.name'},nextActionId:'script'},{id:'script',type:'typescript',config:{script:'user.greeting = "Olá " + user.name;'},nextActionId:'answer'},{id:'answer',type:'interaction',config:{message:'{{user.greeting}}'},nextActionId:null}]};
    const flow=await invoke(`${base}/flows`,'POST',{name:'Teste',definitionJson:JSON.stringify(definition)});
    assert.equal(flow.versions.length,1);assert.equal(flow.draftVersion.status,'DRAFT');
    await assert.rejects(invoke(`${base}/flows`,'POST',{name:'Extra'}),e=>e.status===400);
    await invoke(`${base}/flows/${flow.slug}/publish`,'POST');
    const published=await invoke(`${base}/flows/${flow.slug}`);assert.equal(published.publishedVersion.status,'PUBLISHED');
    const simulation={flowId:flow.id,simulatorUserId:`sim-${suffix}`,start:true};
    const first=await invoke('/api/v1/engine/process','POST',simulation);assert.equal(first.waitingState,'INPUT');
    const second=await invoke('/api/v1/engine/process','POST',{...simulation,start:false,input:'Maria'});assert.equal(second.completed,true);assert.ok(second.messages.some(m=>m.text==='Olá Maria'));
    await assert.rejects(invoke('/api/v1/engine/process','POST',simulation,other),e=>e.status===404);
    const channel=await invoke(`${base}/channels`,'POST',{name:'Webchat',type:'WEBCHAT',agentName:`agent-${suffix}`});
    const linked=await invoke(`${base}/channels/${channel.slug}/flows`,'PUT',{primaryFlowId:flow.id});assert.equal(linked.primaryFlow.flowId,flow.id);
    const contract=await invoke(base);assert.equal(contract.channels.length,1);assert.equal(contract.flows.length,1);
    await assert.rejects(deleteContract(store,company.id,'incorrect'),e=>e.status===400);
    await deleteContract(store,company.id,company.slug);
    assert.equal(await store.get('contracts',{id:company.id}),undefined);
    assert.equal(await store.get('flows',{id:flow.id}),undefined);
    assert.equal((await store.list('engine_sessions',s=>s.flow_id===flow.id)).length,0);
    assert.ok(await store.get('users',{email:address}));
    company=null;
  }finally{
    if(company)await deleteContract(store,company.id,company.slug);
    if(auth)await store.delete('users',{email:address});
    if(other)await store.delete('users',{email:`other-${address}`});
  }
});
