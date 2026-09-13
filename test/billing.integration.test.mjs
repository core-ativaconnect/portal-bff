import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store,now} from '../src/store.mjs';
import {admitContact,billingDay,contactIdentity,packageOperation,packageFields,usageReport} from '../src/billing.mjs';
import {contractOperation} from '../src/contracts.mjs';
import {flowOperation} from '../src/flows.mjs';
import {processDelivery} from '../src/meta-webhook.mjs';
import {webchatOperation} from '../src/webchat.mjs';
import {execute} from '../src/application.mjs';
import {authOperation} from '../src/auth.mjs';
import {parseCommand} from '../src/command.mjs';
import {resolveRoute} from '../src/router.mjs';
import {helpdeskOperation} from '../src/helpdesk.mjs';
import {channelOperation} from '../src/channels.mjs';
import {deleteContract} from '../src/deletion.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('Billing uses the Brasília calendar and stable identities across WhatsApp channels',()=>{
  assert.equal(billingDay('2026-10-01T02:59:59Z'),'2026-09-30');
  assert.equal(billingDay('2026-10-01T03:00:00Z'),'2026-10-01');
  assert.equal(contactIdentity({type:'WHATSAPP',id:'a'},{wa_id:'5511999999999'}),contactIdentity({type:'WHATSAPP',id:'b'},{wa_id:'5511999999999'}));
  assert.notEqual(contactIdentity({type:'WEBCHAT'},{contact_id:'a'}),contactIdentity({type:'WEBCHAT'},{contact_id:'b'}));
});

test('DynamoDB: package editing preserves contracted terms and deletion protects links and default', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const suffix=randomUUID();let plan,contract;
  const body={companyName:`Edit ${suffix}`,cnpj:'40432544000147',contactEmail:`${suffix}@example.com`,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste',neighborhood:'Centro',city:'São Paulo',state:'SP',startDate:'2026-01-01',endDate:'2030-01-01'};
  const terms={name:'Original',maxMau:1000,maxUserCount:10,maxFlowCount:1,maxChannelCount:1,monthlyPriceCents:1234};
  try {
    plan=await packageOperation(store,'create',terms,{});
    contract=await contractOperation(store,'create',{...body,packageId:plan.id},{});
    const changed=await packageOperation(store,'update',{...terms,name:'Edited',maxMau:2000,maxChannelCount:2,monthlyPriceCents:5678},{id:plan.id});
    assert.equal(changed.id,plan.id);assert.equal(changed.maxChannelCount,2);
    const saved=await contractOperation(store,'update',{...body,companyName:'Updated company',packageId:plan.id},{id:contract.id});
    assert.equal(saved.max_mau,1000);assert.equal(saved.max_channel_count,1);assert.equal(saved.monthly_price_cents,1234);assert.equal(saved.package_name,'Original');
    await assert.rejects(packageOperation(store,'delete',{}, {id:plan.id}),{status:409});
    await deleteContract(store,contract.id,contract.slug);contract=null;
    // Default protection can be tested against the existing local default without changing it.
    const defaultRow=await store.get('packages',{id:'DEFAULT'});
    await assert.rejects(packageOperation(store,'delete',{}, {id:defaultRow.packageId}),{status:409});
    assert.equal(await packageOperation(store,'delete',{}, {id:plan.id}),null);
    assert.equal(await store.get('packages',{id:plan.id}),undefined);
    await assert.rejects(packageOperation(store,'update',terms,{id:plan.id}),{status:404});
  } finally {if(contract)await deleteContract(store,contract.id,contract.slug);if(plan)await store.delete('packages',{id:plan.id});}
});

test('DynamoDB: channel quota comes from the package, rejects races and prevents incompatible downgrades', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const suffix=randomUUID();let contract,plan,smaller;
  const body={companyName:`Channels ${suffix}`,cnpj:'40432544000147',contactEmail:`${suffix}@example.com`,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste',neighborhood:'Centro',city:'São Paulo',state:'SP',startDate:'2026-01-01',endDate:'2030-01-01'};
  const terms={name:'Channel quota',maxMau:10,maxUserCount:1,maxFlowCount:1,monthlyPriceCents:0};
  try {
    for(const maxChannelCount of [undefined,-1,1.5])await assert.rejects(packageOperation(store,'create',{...terms,maxChannelCount},{}),{status:400});
    plan=await packageOperation(store,'create',{...terms,maxChannelCount:1},{});
    smaller=await packageOperation(store,'create',{...terms,maxChannelCount:0},{});
    contract=await contractOperation(store,'create',{...body,packageId:plan.id,maxChannelCount:999},{});
    assert.equal(contract.max_channel_count,1);
    const results=await Promise.allSettled([0,1].map(i=>channelOperation(store,'create',{name:`Channel ${i}`,type:'WEBCHAT',agentName:`${suffix}-${i}`},{},{id:'owner',role:'OWNER'},contract)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(contractOperation(store,'update',{...body,packageId:smaller.id},{id:contract.id}),{status:400});
    const saved=await contractOperation(store,'update',{...body,packageId:plan.id,maxChannelCount:999},{id:contract.id});
    assert.equal(saved.max_channel_count,1);
    assert.equal((await usageReport(store,saved)).maxChannelCount,1);
  } finally {
    if(contract)await deleteContract(store,contract.id,contract.slug);
    for(const p of [plan,smaller])if(p)await store.delete('packages',{id:p.id});
  }
});

test('DynamoDB: legacy package migration is a dry run by default and preserves existing terms', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const id=randomUUID();let packageId;
  const contract={id,company_name:'Legacy test',slug:`legacy-${id}`,max_flow_count:7,max_channel_count:4,status:'ACTIVE',updated_at:now(),start_date:'2026-01-01',end_date:'2027-01-01'};
  const script=fileURLToPath(new URL('../scripts/migrate-packages.mjs',import.meta.url));
  const args=['--max-mau','37','--max-users','2','--price-cents','4567','--contract-id',id];
  try {
    await store.put('contracts',contract,{create:true});
    await promisify(execFile)(process.execPath,[script,...args]);assert.equal((await store.get('contracts',{id})).package_id,undefined);
    await promisify(execFile)(process.execPath,[script,...args,'--apply']);
    const migrated=await store.get('contracts',{id});packageId=migrated.package_id;
    assert.ok(packageId);assert.equal(migrated.max_flow_count,7);assert.equal(migrated.max_channel_count,4);assert.equal((await store.get('packages',{id:packageId})).maxChannelCount,4);assert.equal(migrated.end_date,'2027-01-01');assert.equal(migrated.max_mau,37);
    await promisify(execFile)(process.execPath,[script,...args,'--apply']);assert.deepEqual(await store.get('contracts',{id}),migrated);
  } finally {await store.delete('contracts',{id});if(packageId)await store.delete('packages',{id:packageId});}
});

test('DynamoDB: atomic MAU admission, daily deduplication, rollover, isolation and package limits', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);
  const id=randomUUID(),otherId=randomUUID(),channel={id:randomUUID(),type:'WHATSAPP'};
  const email=`billing-${id}@example.com`;let plan;
  try {
    plan=await packageOperation(store,'create',{name:'Billing test',maxMau:3,maxUserCount:1,maxFlowCount:0,maxChannelCount:0,monthlyPriceCents:19900},{});
    const contract={id,company_name:'Billing test',slug:`billing-${id}`,status:'ACTIVE',start_date:'2020-01-01',end_date:'2035-12-31',...packageFields(plan),updated_at:now()};
    await store.put('contracts',contract,{create:true});await store.put('contracts',{...contract,id:otherId,slug:`other-${id}`},{create:true});
    const date='2026-07-12T12:00:00Z',person={wa_id:'5511000000001'};
    const same=await Promise.all(Array.from({length:8},()=>admitContact(store,id,channel,person,date)));
    assert.equal(same.filter(r=>r.newMau).length,1);
    const distinct=await Promise.all(Array.from({length:8},(_,i)=>admitContact(store,id,channel,{wa_id:`55110000001${i}`},date)));
    assert.equal(distinct.filter(r=>r.allowed).length,2);
    assert.equal((await admitContact(store,id,{...channel,id:'another-channel'},person,date)).allowed,true);
    assert.equal((await admitContact(store,id,channel,person,'2026-07-13T12:00:00Z')).newMau,false);
    const report=await usageReport(store,contract,'2026-07');assert.equal(report.mau,3);assert.equal(report.remaining,0);
    assert.equal(report.daily[11].newMau,3);assert.equal(report.daily[11].activeUsers,3);
    assert.equal(report.daily[12].newMau,0);assert.equal(report.daily[12].activeUsers,1);assert.equal(report.daily[12].cumulativeMau,3);
    assert.equal((await admitContact(store,id,channel,person,'2026-08-01T03:00:00Z')).newMau,true);
    assert.equal((await admitContact(store,otherId,channel,person,date)).newMau,true);
    // Upgrades preserve usage; downgrades continue serving already admitted contacts.
    await store.put('contracts',{...contract,max_mau:4});assert.equal((await admitContact(store,id,channel,{wa_id:'upgrade'},date)).allowed,true);
    await store.put('contracts',{...contract,max_mau:1});assert.equal((await admitContact(store,id,channel,person,date)).allowed,true);
    assert.equal((await admitContact(store,id,channel,{wa_id:'blocked'},date)).allowed,false);
    await assert.rejects(usageReport(store,contract,'2026-13'),{status:400});

    const auth=await authOperation(store,'register',{name:'Billing user',email,password:'test-password-123'});
    const user=await store.get('users',{email});
    const command=path=>{const c=parseCommand({path,method:'GET'});return execute(resolveRoute(c),c,{authorization:`Bearer ${auth.accessToken}`},store);};
    await assert.rejects(command('/api/v1/packages'),{status:403});
    await assert.rejects(command(`/api/v1/platform/contracts/${contract.slug}/usage`),{status:404});
    await contractOperation(store,'addAccessUser',{email},{id});
    assert.equal((await command(`/api/v1/platform/contracts/${contract.slug}/usage?month=2026-07`)).mau,4);
    await assert.rejects(flowOperation(store,'createFlow',{name:'Not allowed'}, {},user,contract),{status:400});
    const secondEmail=`second-${email}`;
    await store.put('users',{email:secondEmail,id:randomUUID(),active:true});
    try {await assert.rejects(contractOperation(store,'addAccessUser',{email:secondEmail},{id}),{status:400});}
    finally {await store.delete('users',{email:secondEmail});}
  } finally {
    for(const row of await store.list('billing_usage',r=>r.pk.startsWith(`CONTRACT#${id}#`)||r.pk.startsWith(`CONTRACT#${otherId}#`)))await store.transaction([store.deleteOperation('billing_usage',{pk:row.pk,sk:row.sk})]);
    for(const row of await store.list('contract_access',r=>r.contract_id===id))await store.delete('contract_access',{id:row.id});
    await store.delete('contracts',{id});await store.delete('contracts',{id:otherId});await store.delete('users',{email});if(plan)await store.delete('packages',{id:plan.id});
  }
});

test('DynamoDB: exhausted MAU stops Meta processing and webchat replies without billing status callbacks', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const id=randomUUID(),phoneId=randomUUID(),channelId=randomUUID(),webId=randomUUID();
  const contract={id,status:'ACTIVE',package_id:'test',max_mau:0,start_date:'2020-01-01',end_date:'2035-12-31'};
  let contactId;const oldContactId=randomUUID(),ticketId=randomUUID();
  try {
    await store.put('contracts',contract,{create:true});
    await store.put('whatsapp_phone_numbers',{id:phoneId,waba_config_id:'test'},{create:true});
    await store.put('contract_channels',{id:channelId,contract_id:id,type:'WHATSAPP',whatsapp_phone_number_id:phoneId},{create:true});
    await store.put('contract_channels',{id:webId,contract_id:id,type:'WEBCHAT',webchat_agent_name:webId},{create:true});
    await store.transaction([store.putOperation('engine_contacts',{contact_id:oldContactId,wa_id:'5511999999999'})]);
    await store.put('helpdesk_tickets',{id:ticketId,contract_id:id,channel_id:channelId,contact_id:oldContactId,status:'OPEN',updated_at:now()});
    await assert.rejects(helpdeskOperation(store,'sendMessage',{text:'Old ticket reply'},{ticketId},{id:'attendant'},contract),{status:403});
    let called=false;
    const delivery={phoneId,wabaId:'test',message:{id:randomUUID(),from:'5511999999999',type:'text',text:{body:'Hello'}}};
    await processDelivery(delivery,store,{runFlow:async()=>{called=true;},send:async()=>{called=true;}});
    await processDelivery(delivery,store,{runFlow:async()=>{called=true;}});assert.equal(called,false);
    await processDelivery({phoneId,wabaId:'test',status:{id:'unknown',recipient_id:'5511999999999',status:'read'}},store);
    const connected=await webchatOperation(store,{type:'connect',agentName:webId});contactId=connected.contactId;
    assert.equal(connected.unavailable,true);assert.deepEqual(connected.messages,[]);
    const response=await webchatOperation(store,{type:'message',agentName:webId,contactToken:connected.contactToken,text:'Hello'});
    assert.equal(response.unavailable,true);assert.deepEqual(response.messages,[]);
    assert.equal((await store.list('billing_usage',r=>r.pk.startsWith(`CONTRACT#${id}#`))).length,0);
    assert.equal((await store.list('engine_messages',r=>r.contract_id===id)).length,0);
  } finally {
    for(const j of await store.list('jobs',j=>j.contract_id===id))await store.delete('jobs',{id:j.id});
    if(contactId)await store.transaction([store.deleteOperation('engine_contacts',{contact_id:contactId})]);
    await store.transaction([store.deleteOperation('engine_contacts',{contact_id:oldContactId})]);await store.delete('helpdesk_tickets',{id:ticketId});
    await store.delete('contract_channels',{id:channelId});await store.delete('contract_channels',{id:webId});await store.delete('whatsapp_phone_numbers',{id:phoneId});await store.delete('contracts',{id});
  }
});
