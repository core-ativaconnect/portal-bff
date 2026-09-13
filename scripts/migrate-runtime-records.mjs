import {pathToFileURL} from 'node:url';
import {Store,indexedItem} from '../src/store.mjs';
import {messageOperations,sessionReferenceOperation,saveTicket,updateSummary,runtimeTable} from '../src/runtime-records.mjs';

// Run with writers paused. Scans belong in this one-time maintenance operation,
// never in a webhook, callback, poll or message request.
export async function migrateRuntime(store,{apply=false,contractId}={}){
  const counts={indexed:0,messages:0,sessions:0,tickets:0,published:0,skipped:0};
  const channels=await store.list('contract_channels');
  const channelById=new Map(channels.map(c=>[c.id,c]));
  const contracts=await store.list('contracts',c=>!c.id.startsWith('SLUG#')&&!c.deletion_in_progress);
  const eligible=new Set(contracts.filter(c=>!contractId||c.id===contractId).map(c=>c.id));
  if(contractId&&!eligible.has(contractId))throw new Error('Contract not found or being deleted.');
  // Small configuration tables; apply only changed index attributes.
  for(const table of ['whatsapp_wabas','whatsapp_apps','whatsapp_phone_numbers','contract_channels','contract_channel_flows','contract_help_desk_queues','flow_versions']){
    for(const row of await store.list(table)){
      const updated=indexedItem(table,row);
      if(JSON.stringify(updated)===JSON.stringify(row))continue;
      counts.indexed++;
      if(apply)await store.transaction([store.putOperation(table,updated,row.updated_at?'updated_at = :old':'attribute_exists(id)',row.updated_at?{':old':row.updated_at}:undefined)]);
    }
  }
  for(const flow of await store.list('flows',f=>eligible.has(f.contract_id))){
    const versions=(await store.query('flow_versions','flow_key',flow.id,{index:'flow_version-index'})).filter(v=>v.status==='PUBLISHED'&&v.is_current);
    // During dry-run legacy rows may not have index keys yet.
    const selected=versions.sort((a,b)=>b.version_number-a.version_number)[0]
      ??(await store.list('flow_versions',v=>v.flow_id===flow.id&&v.status==='PUBLISHED'&&v.is_current)).sort((a,b)=>b.version_number-a.version_number)[0];
    if(selected&&flow.published_version_id!==selected.id){counts.published++;if(apply)await store.transaction([store.guard(flow.contract_id),store.putOperation('flows',{...flow,published_version_id:selected.id},flow.updated_at?'updated_at = :old':'attribute_exists(id)',flow.updated_at?{':old':flow.updated_at}:undefined)]);}
  }
  // Sessions sorted oldest-first so the most recent valid session wins an alias.
  for(const session of (await store.list('engine_sessions',s=>eligible.has(s.contract_id))).sort((a,b)=>(a.updated_at??'').localeCompare(b.updated_at??''))){
    if(!session.simulator_user_id||!session.flow_id||!session.version_id){counts.skipped++;continue;}
    counts.sessions++;if(apply)await store.transaction([store.guard(session.contract_id),sessionReferenceOperation(store,session)]);
  }
  const active=new Set();
  for(const ticket of await store.list('helpdesk_tickets',t=>eligible.has(t.contract_id)&&t.status!=='CLOSED')){
    const key=`${ticket.channel_id}#${ticket.contact_id}`;
    if(active.has(key))throw new Error(`Multiple active tickets for ${key}; reconcile before migration.`);
    active.add(key);counts.tickets++;if(apply)await saveTicket(store,ticket,{previous:ticket});
  }
  // Paginated Scan avoids retaining the entire message history in memory.
  for await(const page of store.scanPages('engine_messages'))for(const row of page){
    const channel=channelById.get(row.channel_id),id=row.contract_id??channel?.contract_id;
    if(!eligible.has(id))continue;
    if(!channel||channel.contract_id!==id||!row.occurred_at){counts.skipped++;continue;}
    counts.messages++;
    if(apply){
      const item={...row,contract_id:id};
      const writes=messageOperations(store,item,channel.whatsapp_phone_number_id).slice(1);
      // Fill legacy ownership without replacing a concurrently updated status.
      if(!row.contract_id)writes.push({Update:{TableName:store.table('engine_messages'),Key:{contact_id:row.contact_id,message_id:row.message_id},UpdateExpression:'SET contract_id = :id',ConditionExpression:'attribute_exists(message_id) AND attribute_not_exists(contract_id)',ExpressionAttributeValues:{':id':id}}});
      await store.transaction([store.guard(id),...writes]);await updateSummary(store,item);
    }
  }
  return {apply,counts};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const apply=process.argv.includes('--apply');
  if(apply&&!process.argv.includes('--writers-paused'))throw new Error('Pause message/configuration writers, then pass --writers-paused with --apply.');
  const argument=process.argv.find(a=>a.startsWith('--contract-id='));
  console.log(JSON.stringify(await migrateRuntime(new Store(),{apply,contractId:argument?.slice(14)}),null,2));
}
