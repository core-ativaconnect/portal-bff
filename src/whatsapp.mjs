import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { must, required, now, fromItem, pick } from './store.mjs';
const phoneFields=['id','wabaConfigId','metaPhoneNumberId','verifiedName','displayPhoneNumber','qualityRating','codeVerificationStatus','nameStatus','platformType','throughput','lastSyncedAt','createdAt','updatedAt'];
export const phoneResponse=item=>pick(fromItem(item),phoneFields);
export async function graph(path,token,{method='GET',body}={}) {
  const startedAt=Date.now(),operation=path.includes('/messages')?'messages':path.includes('/phone_numbers')?'phone_numbers':'graph';
  const url=new URL(`https://graph.facebook.com/${process.env.APP_WHATSAPP_META_API_VERSION||'v23.0'}/${path}`);
  try{
    const response=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(18000)});
    let data;try{data=await response.json();}catch{data={};}
    const meta=data.error??{};
    if(!response.ok){
      console.error(JSON.stringify({service:'whatsapp-graph',event:'request.failed',operation,method,httpStatus:response.status,metaCode:meta.code??null,metaSubcode:meta.error_subcode??null,metaType:meta.type??null,fbtraceId:meta.fbtrace_id??null,durationMs:Date.now()-startedAt}));
      const error=new HttpError(502,`A Meta recusou a operação (${meta.code??response.status}).`);
      error.meta={code:meta.code??null,subcode:meta.error_subcode??null,type:meta.type??null,fbtraceId:meta.fbtrace_id??null};throw error;
    }
    console.info(JSON.stringify({service:'whatsapp-graph',event:'request.completed',operation,method,httpStatus:response.status,durationMs:Date.now()-startedAt}));return data;
  }catch(error){
    if(error instanceof HttpError)throw error;
    console.error(JSON.stringify({service:'whatsapp-graph',event:'request.transport_failed',operation,method,name:error?.name??'Error',message:error?.message??null,durationMs:Date.now()-startedAt}));throw error;
  }
}
export async function wabaResponse(store,waba) {
  const app=await store.get('whatsapp_apps',{id:waba.app_config_id});
  return{...pick(fromItem(waba),['id','name','wabaId','appConfigId','createdAt','updatedAt']),appName:app?.name??null,appId:app?.app_id??null};
}
export async function whatsappOperation(store,operation,body,params) {
  if(operation.includes('PhoneNumbers')) {
    const waba=must(await store.get('whatsapp_wabas',{id:params.wabaId})),app=must(await store.get('whatsapp_apps',{id:waba.app_config_id}));
    const existing=await store.list('whatsapp_phone_numbers',p=>p.waba_config_id===waba.id);
    if(operation==='listPhoneNumbers')return existing.map(phoneResponse);
    let after,importedCount=0,updatedCount=0;const synced=[];
    do {
      const data=await graph(`${encodeURIComponent(waba.waba_id)}/phone_numbers?fields=id,verified_name,display_phone_number,quality_rating,code_verification_status,name_status,platform_type,throughput&limit=100${after?'&after='+encodeURIComponent(after):''}`,app.access_token);
      for(const remote of data.data??[]) {
        const old=existing.find(p=>p.meta_phone_number_id===remote.id),id=old?.id??randomUUID(),timestamp=now();
        const item={...old,id,waba_config_id:waba.id,meta_phone_number_id:remote.id,verified_name:remote.verified_name??'',display_phone_number:remote.display_phone_number??'',quality_rating:remote.quality_rating??null,code_verification_status:remote.code_verification_status??null,name_status:remote.name_status??null,platform_type:remote.platform_type??null,throughput:typeof remote.throughput==='object'?JSON.stringify(remote.throughput):remote.throughput??null,last_synced_at:timestamp,created_at:old?.created_at??timestamp,updated_at:timestamp,waba_key:waba.id,meta_phone_key:remote.id,display_sort:`${remote.display_phone_number??''}#${id}`};
        await store.put('whatsapp_phone_numbers',item,{create:!old,previous:old});synced.push(phoneResponse(item));if(old)updatedCount++;else importedCount++;
      }
      after=data.paging?.next?data.paging.cursors?.after:null;
    }while(after);
    return{wabaId:waba.waba_id,wabaName:waba.name,appId:app.app_id,appName:app.name,importedCount,updatedCount,totalSynced:synced.length,syncedAt:now(),phoneNumbers:synced};
  }
  const apps=operation.endsWith('Apps')||operation.endsWith('App'),table=apps?'whatsapp_apps':'whatsapp_wabas';
  const response=async item=>apps?pick(fromItem(item),['id','name','appId','accessToken','verifyToken','createdAt','updatedAt']):wabaResponse(store,item);
  if(operation.startsWith('list'))return Promise.all((await store.list(table)).sort((a,b)=>a.name.localeCompare(b.name)).map(response));
  const id=params.appId??params.wabaId,old=id?must(await store.get(table,{id})):null;
  if(operation.startsWith('delete')) {
    if(apps&&(await store.list('whatsapp_wabas',w=>w.app_config_id===id)).length)throw new HttpError(400,'App vinculado a uma WABA.');
    if(!apps&&(await store.list('contract_whatsapp_wabas',w=>w.waba_config_id===id)).length)throw new HttpError(400,'WABA vinculada a um contrato.');
    await store.delete(table,{id});return null;
  }
  const name=required(body.name,'Nome',180),externalId=required(apps?body.appId:body.wabaId,'Identificador',180),field=apps?'app_id':'waba_id';
  if((await store.list(table,i=>i[field].toLowerCase()===externalId.toLowerCase()&&i.id!==id)).length)throw new HttpError(409,'Identificador já cadastrado.');
  const item={...old,id:id??randomUUID(),name,[field]:externalId,created_at:old?.created_at??now(),updated_at:now(),all_key:'ALL',[`${field}_key`]:externalId.toLowerCase()};
  item.name_sort=`${name.toLowerCase()}#${item.id}`;
  if(apps){item.access_token=required(body.accessToken,'Access token',4096);item.verify_token=required(body.verifyToken,'Verify token',255);item.verify_token_key=item.verify_token.toLowerCase();}
  else{item.app_config_id=must(await store.get('whatsapp_apps',{id:required(body.appConfigId,'App',36)})).id;item.app_key=item.app_config_id;}
  await store.put(table,item,{create:!old,previous:old});return response(item);
}
export async function wabaLinkOperation(store,operation,body,params,contract) {
  const links=await store.list('contract_whatsapp_wabas',w=>w.contract_id===contract.id);
  const toResponse=async(w,link)=>{const data=await wabaResponse(store,w);return{id:link?.id??null,contractId:contract.id,wabaConfigId:w.id,name:w.name,wabaId:w.waba_id,appConfigId:w.app_config_id,appName:data.appName,appId:data.appId,phonesPath:`/admin/settings/whatsapp/wabas/${w.id}/phones`,linkedAt:link?.created_at??null};};
  if(operation.startsWith('list')){const wabas=await store.list('whatsapp_wabas',w=>operation==='listAvailableWabas'?!links.some(l=>l.waba_config_id===w.id):links.some(l=>l.waba_config_id===w.id));return Promise.all(wabas.map(w=>toResponse(w,links.find(l=>l.waba_config_id===w.id))));}
  if(operation==='removeLinkedWaba'){const link=must(links.find(l=>l.waba_config_id===params.wabaConfigId));await store.delete('contract_whatsapp_wabas',{id:link.id},contract.id);return null;}
  const waba=must(await store.get('whatsapp_wabas',{id:required(body.wabaConfigId,'WABA',36)}));if(links.some(l=>l.waba_config_id===waba.id))throw new HttpError(409,'WABA já vinculada.');
  const id=randomUUID(),timestamp=now(),item={id,contract_id:contract.id,waba_config_id:waba.id,created_at:timestamp,contract_key:contract.id,waba_key:waba.id,created_at_sort:`${timestamp}#${id}`,all_key:'ALL'};
  await store.put('contract_whatsapp_wabas',item,{create:true,contractId:contract.id});return toResponse(waba,item);
}
