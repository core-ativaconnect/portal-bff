import { randomUUID } from 'node:crypto';
import { HttpError } from './command.mjs';
import { must, required, now } from './store.mjs';
import { writable } from './contracts.mjs';
import {findSession,sessionReferenceOperation} from './runtime-records.mjs';
import { externalRequest } from './network.mjs';
import { executeScript } from './scripts.mjs';
import { askAi, aiJson } from './ai.mjs';

const safeKeys=path=>String(path).replace(/^user\./,'').split('.').filter(Boolean);
export function variable(state,path) {let value=state;for(const key of safeKeys(path)){if(['__proto__','constructor','prototype'].includes(key))return undefined;value=value?.[key];}return value;}
export function setVariable(state,path,value) {const keys=safeKeys(path);if(!keys.length||keys.some(k=>['__proto__','constructor','prototype'].includes(k)))throw new HttpError(400,'Variável inválida.');let current=state;for(const key of keys.slice(0,-1)){if(!current[key]||typeof current[key]!=='object')current[key]={};current=current[key];}current[keys.at(-1)]=value;}
export const interpolate=(text,state,item)=>String(text??'').replace(/\{\{\s*([^}]+?)\s*}}/g,(_,path)=>String(path.startsWith('item')?variable(item,path.replace(/^item\.?/,''))??'':variable(state,path)??''));
function interaction(config,state) {
  const choices=[],items={};let list=null;
  const render=(template,item)=>({title:interpolate(template.title,state,item),description:interpolate(template.description,state,item)});
  if(config.messageType==='button'){
    const source=variable(state,config.buttonsDynamicSource||'');
    const buttons=config.buttonsDynamicSource&&Array.isArray(source)?source.slice(0,3).map(item=>{const row=render(config.buttonTemplate??{},item);items[row.title]=item;return row;}):config.buttons??[];
    choices.push(...buttons.map(b=>interpolate(b.title,state)).filter(Boolean));
  }
  if(config.messageType==='list'){
    const sections=(config.listSections??[]).map(section=>{
      const source=variable(state,section.dynamicSource||'');
      const rows=section.dynamicSource&&Array.isArray(source)?source.map(item=>{const row=render(section.rowTemplate??{},item);items[row.title]=item;return row;}):(section.rows??[]).map(r=>render(r));
      choices.push(...rows.map(r=>r.title).filter(Boolean));return{title:interpolate(section.title,state),rows:rows.filter(r=>r.title)};
    }).filter(s=>s.rows.length);list={buttonText:interpolate(config.listButtonText||'Ver opções',state),sections};
  }
  const text=[config.header?.type==='text'&&config.header.text?`*${interpolate(config.header.text,state)}*`:null,interpolate(config.message,state),config.footerText?`_${interpolate(config.footerText,state)}_`:null].filter(Boolean).join('\n');
  return{text,choices,list,items};
}
async function matches(value,operator,expected) {
  if(operator==='equals')return value===expected;if(operator==='notEquals')return value!==expected;
  if(operator==='contains')return value.includes(expected);if(operator==='notContains')return !value.includes(expected);
  if(operator==='regex'){
    // Run user-supplied expressions in the same bounded sandbox as scripts.
    const result=await executeScript(`user.match = new RegExp(${JSON.stringify(`^(?:${expected})$`)}).test(${JSON.stringify(value)});`,{});return result.ok&&result.user.match===true;
  }return false;
}
async function router(action,state) {
  for(const route of action.config?.routes??[]){const condition=route.condition??{},value=String(variable(state,condition.userVariable??'')??''),values=Array.isArray(condition.values)&&condition.values.length?condition.values:[condition.value??''];const results=await Promise.all(values.map(v=>matches(value,condition.operator??'equals',String(v))));if((['notEquals','notContains'].includes(condition.operator)?results.every(Boolean):results.some(Boolean)))return route.nextActionId??null;}return action.nextActionId??null;
}
export async function resolveDefinition(store,body,contractId) {
  const flow=must(await store.get('flows',{id:required(body.flowId,'Fluxo',36)}),'Fluxo não encontrado.');
  if(contractId&&flow.contract_id!==contractId)throw new HttpError(404,'Fluxo não encontrado.');
  let version;if(body.versionId&&body.versionId!==flow.id){version=must(await store.get('flow_versions',{id:body.versionId}));if(version.flow_id!==flow.id)throw new HttpError(404,'Versão não encontrada.');}
  else if(body.versionMode==='PUBLISHED'&&flow.published_version_id){version=must(await store.get('flow_versions',{id:flow.published_version_id}));if(version.flow_id!==flow.id||version.status!=='PUBLISHED'||!version.is_current)throw new HttpError(409,'Published version changed.');}
  else if(body.versionMode&&body.versionMode!=='DRAFT')version=must((await store.query('flow_versions','flow_key',flow.id,{index:'flow_version-index'}).then(rows=>rows.filter(v=>v.status===body.versionMode&&(body.versionMode!=='PUBLISHED'||v.is_current)))).sort((a,b)=>b.version_number-a.version_number)[0],'Versão indisponível.');
  const definition=JSON.parse(version?.definition_json??flow.definition_json);if(!Array.isArray(definition.actions)||!definition.actions.length)throw new HttpError(400,'O fluxo não contém ações.');
  return{flow,versionId:version?.id??flow.id,status:version?.status??'DRAFT',definition};
}
export async function processFlow(store,body,actor,{contractId,resumeIntent,operationId,resumeByCustomer=false,runtimeContext}={}) {
  if(operationId){const saved=await store.get('jobs',{id:operationId});if(saved?.response)return saved.response;}
  let resolved=runtimeContext?.resolved??await resolveDefinition(store,body,contractId);
  if(contractId&&resolved.flow.contract_id!==contractId)throw new HttpError(404,'Flow not found.');const contract=must(await store.get('contracts',{id:resolved.flow.contract_id}));writable(contract);
  if(!contractId&&actor?.role!=='OWNER'&&!await store.get('contract_access',{id:`${contract.id}#${actor?.id}`}))throw new HttpError(404,'Fluxo não encontrado.');
  const simulator=required(body.simulatorUserId,'Usuário da sessão',180),requestedKey=`${simulator}#${body.flowId}#${resolved.versionId}`;
  let old=runtimeContext&&'session' in runtimeContext?runtimeContext.session:await findSession(store,contract.id,simulator,resolved.flow.id,resolved.versionId);
  if(body.start&&!old){
    // Explicit restart may reuse a key whose session previously swapped flows.
    const previous=await store.get('engine_sessions',{session_key:requestedKey});
    if(previous){if(previous.contract_id!==contract.id||previous.simulator_user_id!==simulator)throw new HttpError(404,'Session not found.');old=previous;}
  }
  const key=old?.session_key??requestedKey;
  if(!body.start&&!old)throw new HttpError(404,'Sessão não encontrada.');
  if(old?.actor_id&&actor&&old.actor_id!==actor.id&&!contractId)throw new HttpError(404,'Sessão não encontrada.');
  const token=randomUUID();let session=body.start?{session_key:key,session_id:randomUUID(),simulator_user_id:simulator,flow_id:resolved.flow.id,version_id:resolved.versionId,version_status:resolved.status,waiting_state:'NONE',user_state_json:'{}',contract_id:contract.id,actor_id:actor?.id}: {...old};
  const claim={...session,lease_token:token,lease_until:Date.now()+60000,updated_at:now()};
  const claimCondition=old?'(attribute_not_exists(lease_until) OR lease_until < :now)'+(old.updated_at?' AND updated_at = :previous':' AND attribute_not_exists(updated_at)'):'attribute_not_exists(session_key)';
  const claimValues=old?{':now':Date.now(),...(old.updated_at?{':previous':old.updated_at}:{})}:undefined;
  await store.transaction([store.guard(contract.id),store.putOperation('engine_sessions',claim,claimCondition,claimValues)]);
  try{
    if(!body.start&&!runtimeContext?.resolved)resolved=await resolveDefinition(store,{flowId:session.flow_id,versionId:session.version_id,versionMode:session.version_status},contract.id);
    let state=JSON.parse(session.user_state_json),actions=resolved.definition.actions;
    const messages=[],actionIds=[],connectionKeys=[];let previous=null,active=null,completed=false;
    const debug=text=>messages.push({author:'system',kind:'DEBUG',text,choices:null,list:null,actionId:null});
    const global=actions.find(a=>a.systemRole==='global_router'&&a.type==='router');
    let current=body.start?(actions.find(a=>a.systemRole!=='global_router')??actions[0]).id:null;
    if(!body.start){
      const waiting=must(actions.find(a=>a.id===session.waiting_action_id),'A sessão não aguarda entrada.');previous=waiting.id;
      if(session.waiting_state==='HUMAN_HANDOFF'&&!resumeIntent&&!resumeByCustomer)throw new HttpError(409,'A conversa está em atendimento humano.');
      const input=resumeIntent??required(body.input,'Entrada',20000);if(!resumeIntent)messages.push({author:'user',kind:'USER',text:input,choices:null,list:null,actionId:waiting.id});
      setVariable(state,'input',input);setVariable(state,'lastInput',input);
      if(resumeIntent){setVariable(state,'atendimento.intent',resumeIntent);setVariable(state,'atendimento.closedBy','ATTENDANT');if(waiting.config?.intentVariable)setVariable(state,waiting.config.intentVariable,resumeIntent);}
      if(['INPUT','CHOICE'].includes(session.waiting_state)&&waiting.config?.userVariable)setVariable(state,waiting.config.userVariable,input);
      if(session.waiting_state==='CHOICE'){setVariable(state,'lastChoice',input);setVariable(state,'lastChoiceItem',interaction(waiting.config??{},state).items[input]??null);}
      if(session.waiting_state==='AI_AGENT'){const history=variable(state,`__aiAgents.${waiting.id}.history`)??[];history.push({role:'user',content:input});setVariable(state,`__aiAgents.${waiting.id}.history`,history);current=waiting.id;}else current=waiting.nextActionId??null;
      if(resumeIntent&&waiting.config?.attendantFinishActionId)current=waiting.config.attendantFinishActionId;
      if(global&&!resumeIntent&&!resumeByCustomer){const choice=await router(global,state);if(choice){current=choice;previous=global.id;}}
    }
    session.waiting_action_id=null;session.waiting_state='NONE';const deadline=Date.now()+23000;
    for(let steps=0;current;steps++){
      if(steps>=100||Date.now()>deadline)throw new HttpError(400,'O fluxo excedeu o limite de execução.');
      const action=actions.find(a=>a.id===current);if(!action){current=null;break;}const c=action.config??{};
      active=action.id;if(!actionIds.includes(active))actionIds.push(active);if(previous)connectionKeys.push(`${previous}|${active}`);
      let next=action.nextActionId??null;
      if(['interaction','input','atendimento'].includes(action.type)){
        const output=interaction(c,state);messages.push({author:'bot',kind:'BUSINESS',text:output.text,choices:output.choices,list:output.list,actionId:active});
        if(action.type==='atendimento'||action.type==='input'||output.choices.length){session.waiting_action_id=active;session.waiting_state=action.type==='atendimento'?'HUMAN_HANDOFF':output.choices.length?'CHOICE':'INPUT';break;}
      }else if(action.type==='router')next=await router(action,state);
      else if(action.type==='typescript'){const result=await executeScript(c.script??'',state);if(result.ok)state=result.user;for(const log of result.logs)debug(`console: ${log}`);if(!result.ok)debug(`Erro no script: ${result.error}`);}
      else if(action.type==='http'){
        let response={data:null,status:null};try{
          const url=new URL(interpolate(c.url,state));for(const p of c.queryParams??[])if(p.enabled&&p.key)url.searchParams.append(interpolate(p.key,state),interpolate(p.value,state));
          const headers={};for(const h of c.headers??[])if(h.enabled&&h.key)headers[interpolate(h.key,state)]=interpolate(h.value,state);
          let requestBody;if(c.bodyEnabled){requestBody={};for(const f of c.bodyFields??[])if(f.enabled&&f.key){const value=interpolate(f.value,state);try{requestBody[f.key]=f.isJson?JSON.parse(value):value;}catch{requestBody[f.key]=value;}}headers['Content-Type']??='application/json';}
          response=await externalRequest(url,{method:c.method??'GET',headers,body:requestBody,timeout:5000});debug(`Consulta concluída (status ${response.status}).`);
        }catch(error){debug(`Não foi possível consultar a API. ${error.message}`);}
        if(c.responseBodyVariable)setVariable(state,c.responseBodyVariable,response.data);if(c.responseStatusVariable)setVariable(state,c.responseStatusVariable,response.status);
      }else if(action.type==='email')debug(`Simulação de email para ${interpolate(c.to,state)}: ${interpolate(c.subject,state)}`);
      else if(action.type==='flow_swap'){
        resolved=await resolveDefinition(store,{flowId:c.targetFlowId,versionMode:session.version_status==='PUBLISHED'?'PUBLISHED':'DRAFT'},contract.id);actions=resolved.definition.actions;
        if(!actions.some(a=>a.id===c.targetActionId))throw new HttpError(400,'Ação de destino não encontrada.');
        session.flow_id=resolved.flow.id;session.version_id=resolved.versionId;session.version_status=resolved.status;next=c.targetActionId;
      }else if(action.type==='ai_agent'){
        if(c.contractId&&c.contractId!==contract.id)throw new HttpError(400,'A integração de IA pertence a outro contrato.');
        const history=variable(state,`__aiAgents.${active}.history`)??[];
        let result;
        if(history.length>=Math.max(2,(c.maxTurns??6)*2))result={status:'ESCALATE',reply:interpolate(c.transferMessage||'Vou transferir seu atendimento.',state)};
        else{
          const instructions=['Responda apenas JSON: {"status":"CONTINUE|COMPLETED|ESCALATE","reply":"texto","intent":"","summary":"","output":{},"metadata":{}}.',...['instructions','objective','specialty','coverageNotes','handoffRules','agentPrompt','historyPrompt','guardrailsText','exitConditions','toolsNotes'].map(k=>interpolate(c[k],state))].join('\n');
          const selected=c.historyEnabled===false?history.slice(-1):history.slice(-Math.max(1,c.historyWindowSize??50));
          const answer=await askAi(store,contract.id,c.providerConfigId,instructions,selected.length?selected:[{role:'user',content:String(variable(state,'lastInput')??'Inicie o atendimento.')}]);result=aiJson(answer.text);
        }
        if(!['CONTINUE','COMPLETED','ESCALATE'].includes(result.status))throw new HttpError(502,'Status de IA inválido.');
        setVariable(state,c.outputVariable||'ai.output',result.output??result.reply??'');setVariable(state,c.intentVariable||'ai.intent',result.intent??'');setVariable(state,c.summaryVariable||'ai.summary',result.summary??'');setVariable(state,c.statusVariable||'ai.status',result.status);
        if(result.reply)messages.push({author:'bot',kind:'BUSINESS',text:result.reply,choices:null,list:null,actionId:active});
        if(result.status==='CONTINUE'){history.push({role:'assistant',content:result.reply??''});setVariable(state,`__aiAgents.${active}.history`,history);session.waiting_action_id=active;session.waiting_state='AI_AGENT';break;}
        setVariable(state,`__aiAgents.${active}.history`,[]);if(result.status==='ESCALATE'&&c.directHandoffEnabled&&c.handoffTargetActionId)next=c.handoffTargetActionId;
      }else throw new HttpError(400,`Tipo de ação inválido: ${action.type}`);
      previous=active;current=next;
    }
    if(!session.waiting_action_id){completed=true;debug('Fim do fluxo.');}
    session={...session,user_state_json:JSON.stringify(state),completed,updated_at:now()};delete session.lease_token;delete session.lease_until;
    const response={flowId:session.flow_id,resolvedVersionId:session.version_id,resolvedVersionStatus:session.version_status,sessionId:session.session_id,simulatorUserId:simulator,started:body.start===true,completed,waitingState:session.waiting_state,waitingActionId:session.waiting_action_id,messages,trace:{actionIds,connectionKeys,activeActionId:active}};
    const writes=[store.guard(contract.id),store.putOperation('engine_sessions',session,'lease_token = :token',{':token':token}),sessionReferenceOperation(store,session)];
    if(operationId)writes.push(store.putOperation('jobs',{id:operationId,contract_id:contract.id,response:{...response,messages:response.messages.filter(m=>m.kind==='BUSINESS')},expires_at:Math.floor(Date.now()/1000)+1209600},'attribute_not_exists(id)'));
    await store.transaction(writes);
    return response;
  }catch(error){
    const rollback=old??{...session,user_state_json:'{}'};delete rollback.lease_token;delete rollback.lease_until;
    await store.transaction([store.guard(contract.id),store.putOperation('engine_sessions',rollback,'lease_token = :token',{':token':token})]).catch(()=>{});throw error;
  }
}
