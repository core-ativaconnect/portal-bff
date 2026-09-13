import { HttpError } from './command.mjs';
import { Store, must } from './store.mjs';
import { authOperation, authenticate, userOperation } from './auth.mjs';
import { onboarding, suggestSlug, contractBySlug, contractOperation, contractFields, accessUsers } from './contracts.mjs';
import { flowResponse, flowOperation } from './flows.mjs';
import { settingsOperation, settingsList } from './settings.mjs';
import { contentOperation } from './content.mjs';
import { whatsappOperation, wabaLinkOperation } from './whatsapp.mjs';
import { channelOperation, channelResponse } from './channels.mjs';
import { channelMessages } from './messages.mjs';
import { helpdeskOperation } from './helpdesk.mjs';
import { processFlow } from './engine.mjs';
import { aiDraft } from './ai.mjs';
import { deleteContract } from './deletion.mjs';
import { webchatOperation } from './webchat.mjs';
import {packageOperation, usageReport} from './billing.mjs';

export async function contractResponse(store,contract) {
  return {...contractFields(contract),linkedUsers:await accessUsers(store,contract.id),flows:await Promise.all((await store.list('flows',f=>f.contract_id===contract.id)).map(f=>flowResponse(store,f))),channels:await Promise.all((await store.list('contract_channels',c=>c.contract_id===contract.id)).map(c=>channelResponse(store,c,contract))),aiProviders:await settingsList(store,'AiProviders',contract.id)};
}
export async function execute(route,command,headers,store=new Store()){
  try{return await executeOperation(route,command,headers,store);}
  finally{store.reportMetrics?.(`${route.controller}.${route.operation}`);}
}
async function executeOperation(route, command, headers, store) {
  const {controller,operation,params}=route;
  const actor=route.access==='PUBLIC'&&controller!=='FlowProcessingController'?null:await authenticate(store,headers);
  if(controller==='WebChatCommands')return webchatOperation(store,command.body);
  if(route.access==='OWNER'&&actor.role!=='OWNER')throw new HttpError(403,'Acesso exclusivo do administrador.');
  if(controller==='PackageController')return packageOperation(store,operation,command.body,params);
  if(controller==='BillingController')return usageReport(store,await contractBySlug(store,params.contractSlug,actor),command.query.get('month'));
  if(controller==='AuthController')return authOperation(store,operation,command.body,actor);
  if(controller==='UserAdminController')return userOperation(store,operation,command.body,params,actor);
  if(controller==='StartController')return operation==='slug'?suggestSlug(store,command.query.get('value')):onboarding(store,command.body,actor);
  if(controller.includes('BlogController')||controller.includes('StaticPageController'))return contentOperation(store,route,command);
  if(controller==='WhatsAppAdminController')return whatsappOperation(store,operation,command.body,params);
  if(controller==='FlowProcessingController')return processFlow(store,command.body,actor);
  if(controller==='ContractDeleteController')return deleteContract(store,params.id,command.query.get('confirmation'));
  if(operation==='listContracts'||controller==='ContractController'&&operation==='list') {
    const links=actor.role==='OWNER'?null:await store.list('contract_access',a=>a.user_id===actor.id);
    return Promise.all((await store.list('contracts',c=>c.company_name&&(!links||links.some(a=>a.contract_id===c.id)))).sort((a,b)=>a.company_name.localeCompare(b.company_name)).map(c=>contractResponse(store,c)));
  }
  if(controller==='ContractController'&&operation==='create')return contractResponse(store,await contractOperation(store,operation,command.body,params));
  let contract;
  if(params.contractSlug||operation==='findBySlug')contract=await contractBySlug(store,params.contractSlug??params.slug,actor);
  else if(controller==='ContractController')contract=must(await store.get('contracts',{id:params.id}));
  else if(controller==='FlowController')contract=must(await store.get('contracts',{id:must(await store.get('flows',{id:params.id})).contract_id}));
  else if(controller==='ChannelController')contract=must(await store.get('contracts',{id:params.contractId??must(await store.get('contract_channels',{id:params.channelId})).contract_id}));
  if(['getContract','findBySlug'].includes(operation))return contractResponse(store,contract);
  if(controller==='PlatformChannelController'&&['listContacts','listConversation'].includes(operation))return channelMessages(store,operation,params,contract,command.query);
  if(controller==='ChannelController'||controller==='PlatformChannelController')return channelOperation(store,operation,command.body,params,actor,contract);
  if(operation==='generateAiDraft')return aiDraft(store,command.body,params,actor,contract);
  const kind=operation.includes('AiProvider')?'AiProviders':operation.includes('EmailConnection')?'EmailConnections':operation.includes('CloseIntent')?'CloseIntents':operation.includes('Queue')?'Queues':operation.includes('Attendant')?'Attendants':null;
  if(kind&&contract){
    const result=await settingsOperation(store,kind,operation,command.body,params,contract);
    return controller==='PlatformController'&&operation==='listAiProviders'?result.filter(p=>p.enabled):result;
  }
  if(controller==='PlatformHelpDeskController')return helpdeskOperation(store,operation,command.body,params,actor,contract,command.query);
  if(operation.includes('Waba')&&contract)return wabaLinkOperation(store,operation,command.body,params,contract);
  if(operation==='listFlows')return Promise.all((await store.list('flows',f=>f.contract_id===contract.id)).map(f=>flowResponse(store,f)));
  if(controller==='FlowController'||['createFlow','getFlow','saveDraft','publishFlow','listVersions','restoreVersion'].includes(operation))return flowOperation(store,operation,command.body,params,actor,contract);
  if(controller==='ContractController') {
    const result=await contractOperation(store,operation,command.body,params);
    return ['update','updateSlug','block','unblock'].includes(operation)?contractResponse(store,result):result;
  }
  throw new Error(`No native handler registered for ${controller}.${operation}`);
}
