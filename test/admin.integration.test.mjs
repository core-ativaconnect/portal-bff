import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, now } from '../src/store.mjs';
import { execute } from '../src/application.mjs';
import { parseCommand } from '../src/command.mjs';
import { resolveRoute } from '../src/router.mjs';
import { deleteContract } from '../src/deletion.mjs';

test('native administration, settings and approval of a phone transfer', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'}, async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const suffix=randomUUID(),address=`admin-test-${suffix}@example.com`;
  let auth,app,waba,phone,post,page;const contracts=[];
  const invoke=async(path,method='GET',body={})=>{const command=parseCommand({path,method,'body-data':body});return execute(resolveRoute(command),command,auth?{authorization:`Bearer ${auth.accessToken}`}:{},store);};
  try{
    auth=await invoke('/api/v1/auth/register','POST',{name:'Admin test',email:address,password:'password-123'});
    const user=await store.get('users',{email:address});await store.put('users',{...user,role:'OWNER',role_key:'OWNER',updated_at:now()},{previous:user});
    await assert.rejects(invoke(`/api/v1/users/${user.id}/role`,'PATCH',{role:'USER'}),e=>e.status===400);
    for(let i=0;i<2;i++){
      const contract=await invoke('/api/v1/contracts','POST',{packageId:'local-development',companyName:`Test ${suffix} ${i}`,cnpj:'40432544000147',contactEmail:address,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste',neighborhood:'Centro',city:'São Paulo',state:'SP',startDate:'2026-01-01',endDate:'2030-01-01',maxFlowCount:2,maxChannelCount:2});contracts.push(contract);
    }
    const [source,target]=contracts;
    const base=`/api/v1/contracts/${source.id}`,platform=`/api/v1/platform/contracts/${source.slug}`;
    assert.equal((await invoke(`${base}/block`,'POST')).status,'BLOCKED');assert.equal((await invoke(`${base}/unblock`,'POST')).status,'ACTIVE');
    const ai=await invoke(`${base}/ai-providers`,'POST',{name:'AI test',providerType:'OPENAI',model:'model-test',apiKey:'fake-key-test-only',maxInputTokens:1000,maxOutputTokens:100,temperature:0.5,enabled:true});assert.ok(ai.maskedApiKey.includes('••••'));
    await invoke(`${base}/ai-providers/${ai.id}`,'DELETE');
    const smtp=await invoke(`${base}/email-connections`,'POST',{name:'SMTP test',providerType:'GMAIL',fromEmail:address,username:address,secret:'fake-test-secret',enabled:true});assert.equal(smtp.host,'smtp.gmail.com');assert.equal(smtp.secret,undefined);
    await invoke(`${base}/email-connections/${smtp.id}`,'PUT',{name:'SMTP edited',providerType:'GMAIL',fromEmail:address,username:address,enabled:false});await invoke(`${base}/email-connections/${smtp.id}`,'DELETE');
    const attendants=await invoke(`${platform}/help-desk/attendants`,'PUT',{userIds:[user.id]});assert.equal(attendants[0].userId,user.id);
    const tag=await invoke(`${platform}/help-desk/close-intents`,'POST',{name:'Resolvido',intentKey:'RESOLVIDO',enabled:true});
    const queue=await invoke(`${platform}/help-desk/queues`,'POST',{name:'Fila',attendantUserIds:[user.id],tagKeys:['RESOLVIDO'],enabled:true});assert.deepEqual(queue.tagKeys,['RESOLVIDO']);
    await invoke(`${platform}/help-desk/queues/${queue.id}`,'DELETE');await invoke(`${platform}/help-desk/close-intents/${tag.id}`,'DELETE');
    post=await invoke('/api/v1/admin/blog/posts','PUT',{slug:`post-${suffix}`,title:'Teste',pillar:'educativo',audience:'ambos',author:'Teste',content:'Conteúdo',published:false});
    await assert.rejects(invoke(`/api/v1/public/blog/posts/${post.slug}`),e=>e.status===404);
    post=await invoke('/api/v1/admin/blog/posts','PUT',{...post,published:true});assert.equal((await invoke(`/api/v1/public/blog/posts/${post.slug}`)).content,'Conteúdo');
    page=await invoke('/api/v1/admin/content-pages','PUT',{path:`/test-${suffix}`,title:'Página',content:'Teste'});assert.equal((await invoke(`/api/v1/public/content-pages/resolve?path=${page.path}`)).title,'Página');
    app=await invoke('/api/v1/admin/whatsapp/apps','POST',{name:`Test app ${suffix}`,appId:suffix,accessToken:'fake-token-never-send',verifyToken:suffix});
    waba=await invoke('/api/v1/admin/whatsapp/wabas','POST',{name:'WABA test',wabaId:suffix,appConfigId:app.id});
    phone={id:randomUUID(),waba_config_id:waba.id,meta_phone_number_id:suffix,display_phone_number:'5511999999999',created_at:now(),updated_at:now()};await store.put('whatsapp_phone_numbers',phone,{create:true});
    for(const contract of contracts)await invoke(`/api/v1/contracts/${contract.id}/wabas`,'POST',{wabaConfigId:waba.id});
    const first=await invoke(`${platform}/channels`,'POST',{name:'Source',type:'WHATSAPP',whatsAppPhoneNumberId:phone.id});assert.equal(first.status,'CONNECTED');
    const second=await invoke(`/api/v1/platform/contracts/${target.slug}/channels`,'POST',{name:'Target',type:'WHATSAPP',whatsAppPhoneNumberId:phone.id});assert.equal(second.status,'PENDING_TRANSFER');
    const transfer=second.pendingTransferRequest;assert.ok(transfer);
    const approved=await invoke(`${platform}/channels/transfer-requests/${transfer.id}/approve`,'POST');assert.equal(approved.status,'APPROVED');
    assert.equal((await store.get('contract_channels',{id:first.id})).status,'UNASSIGNED');
    assert.equal((await store.get('contract_channels',{id:second.id})).whatsapp_phone_number_id,phone.id);
    assert.ok((await store.list('whatsapp_phone_channel_link_history',h=>h.phone_number_id===phone.id)).some(h=>h.event_type==='TRANSFER_APPROVED'));
  }finally{
    for(const contract of contracts)await deleteContract(store,contract.id,contract.slug);
    if(phone)await store.delete('whatsapp_phone_numbers',{id:phone.id});if(waba)await store.delete('whatsapp_wabas',{id:waba.id});if(app)await store.delete('whatsapp_apps',{id:app.id});
    if(post)await store.delete('blog_posts',{slug:post.slug});if(page)await store.delete('static_pages',{path:page.path});
    if(auth)await store.delete('users',{email:address});
  }
});
