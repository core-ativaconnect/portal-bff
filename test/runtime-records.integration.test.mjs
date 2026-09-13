import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store,now} from '../src/store.mjs';
import {processDelivery} from '../src/meta-webhook.mjs';
import {persistMessage,applyMetaStatus,conversationPage,saveTicket,activeTicket,runtimeTable,messageReferenceKey} from '../src/runtime-records.mjs';
import {channelMessages} from '../src/messages.mjs';
import {migrateRuntime} from '../scripts/migrate-runtime-records.mjs';
import {deleteContract} from '../src/deletion.mjs';

const enabled=process.env.RUN_DYNAMODB_TESTS==='1';
test('DynamoDB: message and callback processing use zero Scans; status races, summaries and scoped pagination',{skip:!enabled},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);
  const id=randomUUID(),phoneId=randomUUID(),channelId=randomUUID(),flowId=randomUUID(),versionId=randomUUID();
  const contract={id,slug:id,status:'ACTIVE',package_id:'test',max_mau:10,start_date:'2020-01-01',end_date:'2035-12-31'};
  const channel={id:channelId,contract_id:id,slug:'wa',name:'WA',type:'WHATSAPP',whatsapp_phone_number_id:phoneId};
  const originalList=store.list.bind(store);let contactId;
  try{
    await store.put('contracts',contract);
    await store.put('contract_channels',channel);
    await store.put('whatsapp_phone_numbers',{id:phoneId,waba_config_id:'waba'});
    const definition=JSON.stringify({actions:[{id:'ask',type:'input',config:{message:'Hello'},nextActionId:'answer'},{id:'answer',type:'interaction',config:{message:'Thanks'}}]});
    await store.put('flows',{id:flowId,contract_id:id,published_version_id:versionId,definition_json:definition});
    await store.put('flow_versions',{id:versionId,flow_id:flowId,status:'PUBLISHED',is_current:true,version_number:1,definition_json:definition});
    await store.put('contract_channel_flows',{id:randomUUID(),channel_id:channelId,flow_id:flowId,is_primary:true});
    store.list=async()=>{throw new Error('Scan forbidden in message path');};
    const delivery={phoneId,wabaId:'waba',message:{id:'in',from:'5511999990000',type:'text',text:{body:'Hi'}}};
    let sends=0;
    await processDelivery(delivery,store,{send:async(_store,_contract,_channel,contact,text)=>{
      contactId=contact.contact_id;sends++;
      await persistMessage(store,{contact_id:contactId,message_id:'out',contract_id:id,channel_id:channelId,direction:'OUTBOUND',contact_wa_id:delivery.message.from,message_text:text,status:'SENT',occurred_at:'2026-09-13T20:00:00.000Z'},phoneId);
    }});
    await processDelivery(delivery,store,{send:async()=>{sends++;}});assert.equal(sends,1);
    const status={id:'out',recipient_id:delivery.message.from,status:'read'};
    await Promise.all([applyMetaStatus(store,phoneId,status),applyMetaStatus(store,phoneId,{...status,status:'delivered'})]);
    assert.equal((await store.get('engine_messages',{contact_id:contactId,message_id:'out'})).status,'READ');
    await assert.rejects(applyMetaStatus(store,phoneId,{...status,recipient_id:'another-contact'}),{status:403});
    await assert.rejects(applyMetaStatus(store,phoneId,{...status,id:'early'}),{status:503});
    await persistMessage(store,{contact_id:contactId,message_id:'early',contract_id:id,channel_id:channelId,direction:'OUTBOUND',contact_wa_id:delivery.message.from,message_text:'Later',status:'SENT',occurred_at:'2099-01-01T00:00:00.000Z'},phoneId);
    await applyMetaStatus(store,phoneId,{...status,id:'early'});
    await applyMetaStatus(store,phoneId,{...status,status:'sent'});
    const summary=await store.get(runtimeTable,{pk:`CHANNEL#${channelId}`,sk:`CONTACT#${contactId}`});
    assert.equal(summary.message_id,'early');assert.equal(summary.status,'READ');
    const page1=await conversationPage(store,channel,contactId,{limit:1});assert.equal(page1.items[0].message_id,'early');assert.ok(page1.nextKey);
    const page2=await conversationPage(store,channel,contactId,{limit:1,after:page1.nextKey});assert.notEqual(page2.items[0].message_id,'early');
    const list=await channelMessages(store,'listContacts',{channelSlug:'wa'},contract,new URLSearchParams('paged=true&limit=1'));
    assert.equal(list.items.length,1);assert.equal(list.items[0].lastMessagePreview,'Later');
    assert.equal((await conversationPage(store,{...channel,id:randomUUID()},contactId)).items.length,0);
    const ticket={id:randomUUID(),contract_id:id,channel_id:channelId,contact_id:contactId,status:'OPEN',updated_at:now()};
    await saveTicket(store,ticket,{create:true});
    assert.equal((await activeTicket(store,channelId,contactId)).id,ticket.id);
    await assert.rejects(saveTicket(store,{...ticket,id:randomUUID()},{create:true}),{status:409});
    await saveTicket(store,{...ticket,status:'CLOSED',updated_at:now()},{previous:ticket});
    assert.equal(await activeTicket(store,channelId,contactId),undefined);
  }finally{
    store.list=originalList;await deleteContract(store,id,id);
    await store.delete('whatsapp_phone_numbers',{id:phoneId});
    if(contactId)await store.delete('engine_contacts',{contact_id:contactId});
  }
});

test('DynamoDB: runtime migration is dry-run by default and repeatable for old messages',{skip:!enabled},async()=>{
  const store=new Store(),id=randomUUID(),channelId=randomUUID(),phoneId=randomUUID(),contactId=randomUUID();
  assert.equal(store.settings.local,true);
  try{
    await store.put('contracts',{id,slug:id,status:'ACTIVE'});
    await store.put('contract_channels',{id:channelId,contract_id:id,type:'WHATSAPP',whatsapp_phone_number_id:phoneId});
    const message={contact_id:contactId,message_id:'legacy',channel_id:channelId,direction:'OUTBOUND',contact_wa_id:'55',status:'READ',occurred_at:now()};
    await store.transaction([store.putOperation('engine_messages',message)]);
    const dry=await migrateRuntime(store,{contractId:id});assert.equal(dry.counts.messages,1);
    assert.equal(await store.get(runtimeTable,messageReferenceKey(phoneId,'legacy')),undefined);
    await migrateRuntime(store,{apply:true,contractId:id});await migrateRuntime(store,{apply:true,contractId:id});
    const reference=await store.get(runtimeTable,messageReferenceKey(phoneId,'legacy'));assert.equal(reference.contact_id,contactId);
    assert.equal((await store.get('engine_messages',{contact_id:contactId,message_id:'legacy'})).status,'READ');
    await applyMetaStatus(store,phoneId,{id:'legacy',recipient_id:'55',status:'delivered'});
    assert.equal((await store.get('engine_messages',{contact_id:contactId,message_id:'legacy'})).status,'READ');
  }finally{await deleteContract(store,id,id);}
});
