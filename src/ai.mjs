import { must, required } from './store.mjs';
import { HttpError } from './command.mjs';
import { externalRequest } from './network.mjs';
import { flowOperation } from './flows.mjs';

export async function askAi(store,contractId,providerId,instructions,messages) {
  const provider=must(await store.get('contract_ai_provider_configs',{id:required(providerId,'Provedor',36)}));
  if(provider.contract_id!==contractId||!provider.enabled)throw new HttpError(400,'Provedor indisponível para este contrato.');
  if(JSON.stringify(messages).length+instructions.length>provider.max_input_tokens*4)throw new HttpError(400,'Entrada ultrapassa o limite do provedor.');
  const headers={'Content-Type':'application/json'};let url,body;
  const max=provider.max_output_tokens;
  if(provider.provider_type==='OPENAI') {
    url=(provider.base_url||'https://api.openai.com').replace(/\/$/,'')+'/v1/responses';headers.Authorization=`Bearer ${provider.api_key}`;
    body={model:provider.model,instructions,input:messages,max_output_tokens:max};
  }else if(provider.provider_type==='ANTHROPIC'){
    url=(provider.base_url||'https://api.anthropic.com').replace(/\/$/,'')+'/v1/messages';headers['x-api-key']=provider.api_key;headers['anthropic-version']='2023-06-01';
    body={model:provider.model,system:instructions,messages,max_tokens:max,temperature:provider.temperature};
  }else if(provider.provider_type==='GEMINI'){
    url=(provider.base_url||'https://generativelanguage.googleapis.com').replace(/\/$/,'')+`/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`;
    headers['x-goog-api-key']=provider.api_key;body={systemInstruction:{parts:[{text:instructions}]},contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:max,temperature:provider.temperature}};
  }else throw new HttpError(400,'Provedor inválido.');
  const response=await externalRequest(url,{method:'POST',headers,body,timeout:Number(process.env.PORTAL_AI_TIMEOUT_MS||18000)});if(response.status<200||response.status>=300)throw new HttpError(502,`O provedor de IA recusou a solicitação (${response.status}).`);
  const data=response.data;
  const text=provider.provider_type==='OPENAI'?(data.output_text??data.output?.flatMap(o=>o.content??[]).map(c=>c.text??'').join('')):provider.provider_type==='ANTHROPIC'?data.content?.map(c=>c.text??'').join(''):data.candidates?.[0]?.content?.parts?.map(c=>c.text??'').join('');
  if(!text)throw new HttpError(502,'O provedor retornou uma resposta vazia.');
  const usage=data.usage??data.usageMetadata??{};
  return{text,inputTokens:usage.input_tokens??usage.promptTokenCount??null,outputTokens:usage.output_tokens??usage.candidatesTokenCount??null,totalTokens:usage.total_tokens??usage.totalTokenCount??((usage.input_tokens??0)+(usage.output_tokens??0))};
}
export function aiJson(text) {try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new HttpError(502,'A IA não retornou JSON válido.');}}
export async function aiDraft(store,body,params,actor,contract) {
  const flow=must((await store.list('flows',f=>f.contract_id===contract.id&&f.slug===params.flowSlug))[0]);
  const goal=required(body.goal,'Objetivo',12000);
  const prompt=`Crie uma definição de fluxo JSON válida, mantendo o formato do exemplo. Responda apenas com JSON contendo name, description e actions. Cada action tem id único, name, type, config, nextActionId (id existente ou null). Tipos permitidos: interaction, input, router, http, typescript, email, atendimento, ai_agent, flow_swap. Não invente credenciais ou IDs de integrações. Preserve IDs existentes quando possível. Objetivo: ${goal}\nInstruções: ${body.instructions??''}\nDefinição atual: ${flow.definition_json}`;
  const generated=await askAi(store,contract.id,body.providerConfigId,prompt,[{role:'user',content:'Gere o fluxo solicitado.'}]);
  const document=aiJson(generated.text);if(!Array.isArray(document.actions)||!document.actions.length)throw new HttpError(502,'A IA não retornou ações válidas.');
  const ids=new Set(document.actions.map(a=>a.id));if(ids.size!==document.actions.length||document.actions.some(a=>a.nextActionId&&!ids.has(a.nextActionId)))throw new HttpError(502,'A IA retornou conexões inválidas.');
  const saved=await flowOperation(store,'saveDraft',{name:document.name||flow.name,slug:flow.slug,description:document.description||flow.description,definitionJson:JSON.stringify(document)},params,actor,contract);
  return{flow:saved,inputTokens:generated.inputTokens,outputTokens:generated.outputTokens,totalTokens:generated.totalTokens};
}
