import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {handler as desk} from '../src/desk.mjs';
import {handler as meta} from '../src/meta-webhook.mjs';
import {metaMessage} from '../src/messages.mjs';

test('Desk uses REST bodies, preserves query and excludes Studio/admin operations',async()=>{
  const calls=[];
  const execute=async(route,command,headers)=>{calls.push({route,command,headers});return {ok:true};};
  const event={rawPath:'/flow-desk/api/v1/platform/contracts/acme/help-desk/tickets/t1/messages',rawQueryString:'limit=20',requestContext:{http:{method:'POST'}},headers:{authorization:'Bearer test'},body:JSON.stringify({text:'Olá'})};
  assert.equal((await desk(event,null,{execute})).statusCode,200);
  assert.deepEqual(calls[0].command.body,{text:'Olá'});
  assert.equal(calls[0].command.query.get('limit'),'20');
  assert.equal(calls[0].headers.authorization,'Bearer test');
  assert.equal((await desk({...event,rawPath:'/flow-desk/api/v1/auth/me',requestContext:{http:{method:'GET'}}},null,{execute})).statusCode,200);
  for(const rawPath of ['/flow-desk/api/v1/users','/flow-desk/api/v1/auth/register','/flow-desk/api/v1/platform/contracts/acme/flows']){
    assert.equal((await desk({...event,rawPath},null,{execute})).statusCode>=400,true);
  }
  assert.equal((await desk({...event,body:'{'},null,{execute})).statusCode,400);
});

const rows={whatsapp_apps:[{id:'app',app_id:'123',verify_token:'verify'}],whatsapp_wabas:[{id:'waba',waba_id:'456',app_config_id:'app'}],whatsapp_phone_numbers:[{id:'phone',meta_phone_number_id:'789',waba_config_id:'waba'}]};
const store={query:async(table,partition,value)=>rows[table].filter(r=>({waba_id_key:r.waba_id,meta_phone_key:r.meta_phone_number_id,verify_token_key:r.verify_token?.toLowerCase()})[partition]===value),list:async(table,predicate)=>rows[table].filter(predicate),get:async(table,key)=>rows[table].find(r=>r.id===key.id)};
const payload={object:'whatsapp_business_account',entry:[{id:'456',changes:[{field:'messages',value:{metadata:{phone_number_id:'789'},contacts:[{wa_id:'5511',profile:{name:'Visitor'}}],messages:[{id:'m1',from:'5511',type:'text',text:{body:'Oi'}}],statuses:[{id:'out1',recipient_id:'5511',status:'delivered'}]}}]}]};
const signed=body=>({requestContext:{http:{method:'POST'}},body,headers:{'X-Hub-Signature-256':`sha256=${createHmac('sha256','secret').update(body).digest('hex')}`}});

test('Meta accepts challenge and signed raw/base64 deliveries; rejects tampering before queueing',async()=>{
  const queued=[],dependencies={store,secrets:{123:'secret'},enqueue:async item=>queued.push(item)};
  const verify={requestContext:{http:{method:'GET'}},queryStringParameters:{'hub.mode':'subscribe','hub.verify_token':'verify','hub.challenge':'12345'}};
  assert.equal((await meta(verify,null,dependencies)).body,'12345');
  assert.equal((await meta({...verify,queryStringParameters:{...verify.queryStringParameters,'hub.verify_token':'wrong'}},null,dependencies)).statusCode,403);
  const event=signed(JSON.stringify(payload));
  assert.equal((await meta(event,null,dependencies)).body,'EVENT_RECEIVED');assert.equal(queued.length,2);
  assert.equal((await meta({...event,body:Buffer.from(event.body).toString('base64'),isBase64Encoded:true},null,dependencies)).statusCode,200);
  queued.length=0;
  assert.equal((await meta({...event,body:event.body.replace('Oi','altered')},null,dependencies)).statusCode,403);assert.equal(queued.length,0);
  assert.equal((await meta({...event,headers:{}},null,dependencies)).statusCode,403);
});

test('Meta does not acknowledge a delivery when queueing fails',async()=>{
  const result=await meta(signed(JSON.stringify(payload)),null,{store,secrets:{123:'secret'},enqueue:async()=>{throw new Error('queue unavailable');}});
  assert.equal(result.statusCode,503);
});

test('WhatsApp flow responses preserve buttons and lists',()=>{
  assert.equal(metaMessage({text:'Oi'}).type,'text');
  assert.equal(metaMessage({text:'Escolha',choices:['Sim','Não']}).interactive.action.buttons.length,2);
  assert.equal(metaMessage({text:'Escolha',list:{buttonText:'Ver',sections:[{title:'Menu',rows:[{title:'Ajuda'}]}]}}).interactive.action.sections[0].rows[0].title,'Ajuda');
});
