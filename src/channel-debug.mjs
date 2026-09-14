import {randomUUID} from 'node:crypto';
import {now} from './store.mjs';
import {runtimeTable} from './runtime-records.mjs';

const traceKey=channelId=>`CHANNEL_DEBUG#${channelId}`;

// Diagnostic data is deliberately opt-in per channel. It is kept for seven days
// and failures here must never interrupt a customer message.
export async function trace(store,channel,event,details={}){
  if(!channel?.debug_enabled)return;
  const timestamp=now();
  const item={pk:traceKey(channel.id),sk:`TRACE#${timestamp}#${randomUUID()}`,contract_id:channel.contract_id,channel_id:channel.id,
    timestamp,event,trace_id:details.traceId??null,details,expires_at:Math.floor(Date.now()/1000)+604800};
  try{await store.put(runtimeTable,item,{contractId:channel.contract_id});}catch(error){console.warn(JSON.stringify({event:'channel.debug.write_failed',channelId:channel.id,name:error?.name}));}
}

export async function listTraces(store,channel,limit=100){
  const page=await store.queryPage(runtimeTable,'pk',traceKey(channel.id),{sort:'sk',prefix:'TRACE#',forward:false,limit:Math.min(Math.max(Number(limit)||100,1),200)});
  return page.items.map(item=>({id:item.sk.slice(6),timestamp:item.timestamp,event:item.event,traceId:item.trace_id??null,details:item.details??{}}));
}
