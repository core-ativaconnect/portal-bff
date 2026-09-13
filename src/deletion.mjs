import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { now } from './store.mjs';

export async function deleteContract(store,id,confirmation){
  const contract=await store.get('contracts',{id});if(!contract)return null;
  if(confirmation!==contract.slug)throw new HttpError(400,'Digite o slug exato do contrato para confirmar a exclusão.');
  const token=randomUUID(),timestamp=Date.now(),locked={...contract,status:'BLOCKED',deletion_in_progress:true,deletion_token:token,deletion_lease_until:timestamp+60000,updated_at:now()};
  await store.transaction([store.putOperation('contracts',locked,'attribute_exists(id) AND (attribute_not_exists(deletion_lease_until) OR deletion_lease_until < :now)',{':now':timestamp})]);
  const guard=()=>({ConditionCheck:{TableName:store.table('contracts'),Key:{id},ConditionExpression:'deletion_token = :token',ExpressionAttributeValues:{':token':token}}});
  async function remove(table,items,key=item=>({id:item.id})){
    for(let i=0;i<items.length;i+=99)await store.transaction([guard(),...items.slice(i,i+99).map(item=>store.deleteOperation(table,key(item)))]);
  }
  try{
    await remove('runtime_records',await store.list('runtime_records',row=>row.contract_id===id),row=>({pk:row.pk,sk:row.sk}));
    await remove('billing_usage',await store.list('billing_usage',row=>row.pk.startsWith(`CONTRACT#${id}#`)),row=>({pk:row.pk,sk:row.sk}));
    const channels=await store.list('contract_channels',c=>c.contract_id===id),channelIds=new Set(channels.map(c=>c.id));
    const flows=await store.list('flows',f=>f.contract_id===id),flowIds=new Set(flows.map(f=>f.id));
    const versionIds=new Set((await store.list('flow_versions',v=>flowIds.has(v.flow_id))).map(v=>v.id));
    for(const table of ['websocket_connections','contract_access','contract_ai_provider_configs','contract_email_connections','contract_help_desk_attendants','contract_help_desk_close_intents','contract_help_desk_queues','contract_whatsapp_wabas','helpdesk_tickets','whatsapp_phone_channel_link_history','whatsapp_phone_transfer_requests'])await remove(table,await store.list(table,i=>i.contract_id===id||i.source_contract_id===id||i.target_contract_id===id||channelIds.has(i.channel_id)));
    await remove('contract_channel_flows',await store.list('contract_channel_flows',l=>channelIds.has(l.channel_id)||flowIds.has(l.flow_id)));
    await remove('engine_messages',await store.list('engine_messages',m=>m.contract_id===id||channelIds.has(m.channel_id)||flowIds.has(m.flow_id)),m=>({contact_id:m.contact_id,message_id:m.message_id}));
    await remove('engine_sessions',await store.list('engine_sessions',s=>s.contract_id===id||flowIds.has(s.flow_id)||versionIds.has(s.version_id)),s=>({session_key:s.session_key}));
    const contacts=await store.list('engine_contacts',c=>flowIds.has(c.active_flow_id)||versionIds.has(c.active_flow_version_id));
    for(const contact of contacts){const updated={...contact};delete updated.active_flow_id;delete updated.active_flow_version_id;delete updated.active_flow_completed;
      await store.transaction([guard(),store.putOperation('engine_contacts',updated,'active_flow_id = :flow',{':flow':contact.active_flow_id})]);}
    const phones=await store.list('whatsapp_phone_numbers',p=>channelIds.has(p.assigned_channel_id));
    for(const phone of phones){const updated={...phone};delete updated.assigned_channel_id;await store.transaction([guard(),store.putOperation('whatsapp_phone_numbers',updated,'assigned_channel_id = :channel',{':channel':phone.assigned_channel_id})]);}
    await remove('flow_versions',await store.list('flow_versions',v=>flowIds.has(v.flow_id)));
    await remove('contract_channels',await store.list('contract_channels',c=>c.owner_contract_id===id));
    await remove('contract_channels',channels);await remove('flows',flows);
    await store.transaction([store.deleteOperation('contracts',{id},'deletion_token = :token',{':token':token}),store.deleteOperation('contracts',{id:`SLUG#${contract.slug}`},'attribute_not_exists(id) OR contract_id = :id',{':id':id})]);
    return null;
  }catch(error){
    // Keep the tombstone so all relation writers reject new children; a retry resumes cleanup.
    const current=await store.get('contracts',{id});if(current?.deletion_token===token){delete current.deletion_lease_until;await store.transaction([store.putOperation('contracts',current,'deletion_token = :token',{':token':token})]).catch(()=>{});}throw error;
  }
}
