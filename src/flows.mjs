import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { must, now, required, pick, fromItem } from './store.mjs';
import { slugify, writable } from './contracts.mjs';

function versionResponse(item) { return {...pick(fromItem(item),['id','versionNumber','status','createdAt','createdByUserId','createdByName','createdByEmail']),current:item.is_current}; }
export async function flowResponse(store,flow) {
  const versions = (await store.list('flow_versions',v => v.flow_id === flow.id)).sort((a,b)=>b.version_number-a.version_number).map(versionResponse);
  return {...pick(fromItem(flow),['id','contractId','name','slug','description','definitionJson','createdAt','updatedAt']),versions,draftVersion:versions.find(v=>v.status==='DRAFT' && v.current)??null,publishedVersion:versions.find(v=>v.status==='PUBLISHED' && v.current)??null};
}
function definition(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || Buffer.byteLength(value)>300000) throw new HttpError(400,'Definição do fluxo inválida ou muito grande.');
  try { const document=JSON.parse(value); if (!document || typeof document!=='object' || !Array.isArray(document.actions)) throw new Error(); }
  catch { throw new HttpError(400,'O fluxo deve conter JSON válido com actions.'); } return value;
}
async function writeVersion(store,flow,previous,actor,status='DRAFT',contract) {
  const versions=await store.list('flow_versions',v=>v.flow_id===flow.id);
  const number=Math.max(0,...versions.map(v=>v.version_number))+1;
  const current=versions.filter(v=>v.status===status&&v.is_current);
  const version={id:randomUUID(),flow_id:flow.id,version_number:number,status,is_current:true,definition_json:flow.definition_json,created_by_user_id:actor.id,created_by_name:actor.name,created_by_email:actor.email,created_at:now(),flow_key:flow.id,version_sort:String(number).padStart(9,'0'),flow_status_current_key:`${flow.id}#${status}#true`};
  const updated={...flow,updated_at:now(),revision:(previous?.revision??0)+1};
  const condition=previous ? 'attribute_exists(id) AND (attribute_not_exists(revision) OR revision = :revision)' : 'attribute_not_exists(id)';
  const operations=[store.advanceContract(contract),store.putOperation('flows',updated,condition,previous?{':revision':previous.revision??0}:undefined),store.putOperation('flow_versions',version,'attribute_not_exists(id)')];
  for(const old of current) operations.push(store.putOperation('flow_versions',{...old,status:status==='PUBLISHED'?'ARCHIVED':old.status,is_current:false,flow_status_current_key:`${flow.id}#${status==='PUBLISHED'?'ARCHIVED':old.status}#false`}));
  await store.transaction(operations); return flowResponse(store,updated);
}
export async function flowOperation(store,operation,body,params,actor,contract) {
  writable(contract);
  if (operation==='createFlow'||operation==='create') {
    const name=required(body.name,'Nome',180); const base=slugify(body.slug||name);
    if (!base) throw new HttpError(400,'Slug inválido.');
    const flows=await store.list('flows',f=>f.contract_id===contract.id);
    if (contract.max_flow_count!=null && flows.length>=contract.max_flow_count) throw new HttpError(400,'Limite de fluxos atingido.');
    let slug=base;for(let i=2;flows.some(f=>f.slug===slug);i++) slug=`${base}-${i}`;
    const id=randomUUID(), timestamp=now();
    const flow={id,contract_id:contract.id,name,slug,description:body.description?.trim()||`Fluxo ${name}`,definition_json:definition(body.definitionJson,JSON.stringify({id:`flow-${Date.now()}`,name,description:'',actions:[],isActive:false,createdAt:timestamp,updatedAt:timestamp})),created_at:timestamp,contract_key:contract.id,name_sort:`${name.toLowerCase()}#${id}`,contract_slug_key:`${contract.id}#${slug}`};
    return writeVersion(store,flow,null,actor,'DRAFT',contract);
  }
  const flow=must(params.flowSlug ? (await store.list('flows',f=>f.contract_id===contract.id&&f.slug===params.flowSlug))[0] : await store.get('flows',{id:params.id}),'Fluxo não encontrado.');
  if (flow.contract_id!==contract.id) throw new HttpError(404,'Fluxo não encontrado.');
  if (['find','getFlow'].includes(operation)) return flowResponse(store,flow);
  if (operation==='listVersions') return (await flowResponse(store,flow)).versions;
  if (operation==='delete') {
    const bindings=await store.list('contract_channel_flows',b=>b.flow_id===flow.id);
    for(const row of [...bindings.map(item=>({table:'contract_channel_flows',item})),...(await store.list('flow_versions',v=>v.flow_id===flow.id)).map(item=>({table:'flow_versions',item}))]) await store.delete(row.table,{id:row.item.id},contract.id);
    await store.delete('flows',{id:flow.id},contract.id);return null;
  }
  if (['publish','publishFlow'].includes(operation)) return writeVersion(store,flow,flow,actor,'PUBLISHED',contract);
  let updated={...flow};
  if (operation==='restoreVersion') {
    const version=must(await store.get('flow_versions',{id:params.versionId}));
    if(version.flow_id!==flow.id) throw new HttpError(404,'Versão não encontrada.');
    updated.definition_json=version.definition_json;
  } else {
    updated.name=required(body.name,'Nome',180);updated.slug=slugify(body.slug||updated.name);
    if(!updated.slug) throw new HttpError(400,'Slug inválido.');
    if((await store.list('flows',f=>f.contract_id===contract.id&&f.slug===updated.slug&&f.id!==flow.id)).length) throw new HttpError(409,'Slug do fluxo já existe.');
    updated.description=body.description?.trim()||`Fluxo ${updated.name}`;
    updated.definition_json=definition(body.definitionJson,flow.definition_json);
    updated.name_sort=`${updated.name.toLowerCase()}#${flow.id}`;updated.contract_slug_key=`${contract.id}#${updated.slug}`;
  }
  return writeVersion(store,updated,flow,actor,'DRAFT',contract);
}
