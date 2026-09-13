import {HttpError} from './command.mjs';

const table='runtime_records';
const retention=7*24*60*60*1000;
const scopeFor=(channelId,contactId)=>`CONVERSATION#${channelId}#${contactId}`;
const changeKey=version=>`CHANGE#${String(version).padStart(16,'0')}`;

// Revision and change pointer commit with the message: a cursor cannot skip a
// delayed write with an older timestamp, nor miss a status on an old message.
export async function changeOperations(store,item){
  const pk=scopeFor(item.channel_id,item.contact_id),key={pk,sk:'REVISION'};
  const previous=await store.get(table,key);
  // Bot-only conversations do not pay for a change journal. The first Desk
  // synchronization enables it; the condition closes the activation/write race.
  if(!previous)return [{ConditionCheck:{TableName:store.table(table),Key:key,ConditionExpression:'attribute_not_exists(pk)'}}];
  const version=previous.version+1;
  return [store.putOperation(table,{...key,version,contract_id:item.contract_id},
    previous?'#version = :old':'attribute_not_exists(pk)',previous?{':old':previous.version}:undefined),
    store.putOperation(table,{pk,sk:changeKey(version),version,contract_id:item.contract_id,contact_id:item.contact_id,message_id:item.message_id,
      expires_at:Math.floor((Date.now()+retention)/1000)})].map((op,index)=>{
        if(index===0&&previous)op.Put.ExpressionAttributeNames={'#version':'version'};return op;
      });
}
const encode=(scope,version)=>Buffer.from(JSON.stringify({scope,version,time:Date.now()})).toString('base64url');
export async function syncConversation(store,channel,contactId,cursor){
  const scope=scopeFor(channel.id,contactId);let state;
  if(cursor){try{state=JSON.parse(Buffer.from(cursor,'base64url').toString());
    if(state.scope!==scope||!Number.isSafeInteger(state.version)||state.version<0||!Number.isFinite(state.time))throw new Error();
  }catch{throw new HttpError(400,'Invalid conversation cursor.');}}
  let head=await store.get(table,{pk:scope,sk:'REVISION'});
  if(!head){
    try{await store.transaction([store.guard(channel.contract_id),store.putOperation(table,{pk:scope,sk:'REVISION',version:0,contract_id:channel.contract_id},'attribute_not_exists(pk)')]);head={version:0};}
    catch(error){if(error.status!==409)throw error;head=await store.get(table,{pk:scope,sk:'REVISION'});if(!head)throw error;}
  }
  const version=head.version;
  const reset=async()=>({reset:true,messages:(await store.query('engine_messages','contact_id',contactId)).filter(m=>m.channel_id===channel.id&&m.contract_id===channel.contract_id),cursor:encode(scope,version),hasMore:false});
  if(!state||Date.now()-state.time>retention||state.version>version)return reset();
  if(state.version===version)return {reset:false,messages:[],cursor:encode(scope,version),hasMore:false};
  const page=await store.queryPage(table,'pk',scope,{sort:'sk',from:changeKey(state.version+1),to:changeKey(version),limit:100});
  // Expired/missing feed entries require a fresh snapshot, not silent data loss.
  if(!page.items.length||page.items.some((item,i)=>item.version!==state.version+i+1))return reset();
  const refs=[...new Map(page.items.map(item=>[item.message_id,item])).values()];
  const rows=await Promise.all(refs.map(ref=>store.get('engine_messages',{contact_id:contactId,message_id:ref.message_id})));
  const last=page.items.at(-1).version;
  return {reset:false,messages:rows.filter(m=>m&&m.channel_id===channel.id&&m.contract_id===channel.contract_id),cursor:encode(scope,last),hasMore:last<version};
}
