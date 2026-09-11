import { randomUUID } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Store, now } from './store.mjs';
import { HttpError } from './command.mjs';
import { authenticate } from './auth.mjs';
import { execute } from './application.mjs';
import { parseCommand } from './command.mjs';
import { resolveRoute } from './router.mjs';

export const pendingJob=id=>({statusCode:202,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify({type:'portal-job',jobId:id})});
export async function enqueue(route,command,headers,store=new Store(),invoke){
  const actor=await authenticate(store,headers);
  if(route.access==='OWNER'&&actor.role!=='OWNER')throw new HttpError(403,'Acesso exclusivo do administrador.');
  // Authorize the target before enqueueing work.
  if(route.controller==='ContractDeleteController'){
    const contract=await store.get('contracts',{id:route.params.id});
    if(contract&&command.query.get('confirmation')!==contract.slug)throw new HttpError(400,'Confirmação inválida.');
  }else{
    const {contractBySlug}=await import('./contracts.mjs');await contractBySlug(store,route.params.contractSlug,actor);
  }
  const id=randomUUID(),item={id,user_id:actor.id,state:'PENDING',created_at:now(),expires_at:Math.floor(Date.now()/1000)+86400};
  await store.put('jobs',item,{create:true});
  const payload={jobId:id,command:{path:command.rawPath,method:command.method,'body-data':command.body},headers:{authorization:Object.entries(headers??{}).find(([k])=>k.toLowerCase()==='authorization')?.[1]}};
  try{
    if(invoke)await invoke(payload);
    else await new LambdaClient({region:store.settings.region}).send(new InvokeCommand({FunctionName:process.env.PORTAL_WORKER_FUNCTION,InvocationType:'Event',Payload:Buffer.from(JSON.stringify(payload))}));
  }catch(error){await store.put('jobs',{...item,state:'FAILED',result_status:503,result_body:JSON.stringify({message:'Não foi possível iniciar a operação.'})});throw error;}
  return pendingJob(id);
}
export async function jobStatus(id,headers,store=new Store()){
  const actor=await authenticate(store,headers),job=await store.get('jobs',{id});
  if(!job||job.user_id!==actor.id)throw new HttpError(404,'Operação não encontrada.');
  if(['PENDING','RUNNING'].includes(job.state)){
    if(Date.now()-Date.parse(job.created_at)>900000)throw new HttpError(504,'A operação excedeu o tempo permitido. Confira o registro antes de repetir.');
    return pendingJob(id);
  }
  return{statusCode:job.result_status,headers:{'content-type':'application/json','cache-control':'no-store'},body:job.result_body??''};
}
export async function runJob(event,store=new Store()){
  const job=await store.get('jobs',{id:event.jobId});if(!job||job.state!=='PENDING')return;
  const claim=store.putOperation('jobs',{...job,state:'RUNNING'},'#state = :pending',{':pending':'PENDING'});claim.Put.ExpressionAttributeNames={'#state':'state'};
  try{await store.transaction([claim]);}catch(error){if(error.status===409)return;throw error;}
  let status,body;
  try{
    const command=parseCommand(event.command),route=resolveRoute(command);
    const actor=await authenticate(store,event.headers);if(actor.id!==job.user_id)throw new HttpError(403,'Usuário da operação inválido.');
    const result=await execute(route,command,event.headers,store);status=result===null&&command.method==='DELETE'?204:200;body=status===204?'':JSON.stringify(result);
  }catch(error){status=error instanceof HttpError?error.status:500;body=JSON.stringify({status,message:error instanceof HttpError?error.message:'Falha ao executar a operação.'});}
  await store.put('jobs',{...job,state:status<400?'COMPLETED':'FAILED',result_status:status,result_body:body,finished_at:now()});
}
export async function worker(event){return runJob(event);}
