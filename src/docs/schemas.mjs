import {readFileSync} from 'node:fs';

// These checked-in contracts are maintained with the native Node handlers.
// Building/deploying the documentation does not require the legacy repository.
const contracts=JSON.parse(readFileSync(new URL('./contracts.json',import.meta.url),'utf8'));
export const schemas=contracts.schemas;
export const operationContracts=contracts.operations;
export const ref=name=>({$ref:`#/components/schemas/${name}`});
const string={type:'string'},boolean={type:'boolean'},integer={type:'integer'};
const object=(properties,required=[])=>({type:'object',properties,...(required.length?{required}:{})});

const requiredFields={
  BlogPostRequest:['slug','title','pillar','audience','author'],BlogImportRequest:['posts'],BlogSettingsRequest:['navigation'],BlogMenuItemRequest:['label','href'],
  StaticPageRequest:['path','title'],WhatsAppAppRequest:['name','appId','accessToken','verifyToken'],WhatsAppWabaRequest:['name','wabaId','appConfigId'],
  LoginRequest:['email','password'],RegisterRequest:['name','email','password'],ChannelRequest:['name','type'],ChannelUpdateRequest:['name'],ChannelPhoneBindingRequest:['whatsAppPhoneNumberId'],
  ContractRequest:['companyName','cnpj','contactEmail','contactPhone','address','neighborhood','city','state','zipCode','startDate','endDate','maxFlowCount','maxChannelCount'],
  ContractAccessRequest:['email'],ContractAiProviderRequest:['name','providerType','model','apiKey','maxInputTokens','maxOutputTokens','temperature','enabled'],
  ContractEmailConnectionRequest:['name','providerType','fromEmail','username','enabled'],ContractEmailConnectionTestRequest:['targetEmail'],
  FlowRequest:['name'],ContractSlugRequest:['slug'],ContractWhatsAppWabaLinkRequest:['wabaConfigId'],FlowProcessingRequest:['flowId','simulatorUserId'],
  FlowAiDraftRequest:['providerConfigId','goal'],ContractHelpDeskCloseIntentRequest:['name','intentKey','enabled'],ContractHelpDeskQueueRequest:['name','enabled'],
  HelpDeskTicketCloseRequest:['intent'],HelpDeskTicketMessageRequest:['text'],HelpDeskTicketTransferRequest:['targetUserId'],
  StartCompanyRequest:['companyName','cnpj','contactEmail','contactPhone','address','neighborhood','city','state','zipCode'],UserRoleUpdateRequest:['role'],UserStatusUpdateRequest:['active'],
};
for(const [name,required] of Object.entries(requiredFields))schemas[name].required=required;
const prop=(schema,field,patch)=>Object.assign(schemas[schema].properties[field],patch);
prop('RegisterRequest','password',{minLength:8,maxLength:120,format:'password',writeOnly:true});
prop('LoginRequest','password',{format:'password',writeOnly:true});
for(const name of ['LoginRequest','RegisterRequest','ContractAccessRequest'])prop(name,'email',{format:'email',example:'usuario@example.com'});
prop('FlowRequest','definitionJson',{description:'JSON serializado como string; deve conter actions. Limite de 300.000 bytes.',example:JSON.stringify({actions:[{id:'hello',type:'interaction',config:{message:'Olá!'},nextActionId:null}]})});
prop('FlowAiDraftRequest','goal',{maxLength:12000,example:'Crie um fluxo de atendimento com menu de opções.'});
prop('FlowProcessingRequest','start',{default:false,description:'true inicia/reinicia a sessão; false continua uma sessão existente com input.'});
prop('FlowProcessingRequest','simulatorUserId',{maxLength:180,example:'simulador-documentacao'});
prop('FlowProcessingRequest','input',{maxLength:20000});
prop('ChannelRequest','type',{enum:['WEBCHAT','WHATSAPP']});
prop('ChannelRequest','agentName',{description:'Obrigatório para WEBCHAT; nome único do agente.'});
prop('ChannelFlowBindingsRequest','primaryFlowId',{nullable:true,description:'Fluxo principal publicado; null remove o vínculo principal.'});
prop('ContractEmailConnectionRequest','secret',{format:'password',writeOnly:true,description:'Obrigatório ao criar. Omitir na atualização mantém o segredo salvo.'});
schemas.ContractEmailConnectionRequest.description='GMAIL e OUTLOOK usam presets SMTP. Para SMTP, informe host, port e security.';
schemas.ChannelUpdateRequest.description='Ao atualizar WEBCHAT, informe agentName; ao atualizar WHATSAPP, informe whatsAppPhoneNumberId.';
prop('WhatsAppAppRequest','accessToken',{writeOnly:true,format:'password'});
prop('WhatsAppAppRequest','verifyToken',{writeOnly:true});
prop('ContractAiProviderRequest','apiKey',{writeOnly:true,format:'password'});
prop('UserRoleUpdateRequest','role',{enum:['OWNER','USER']});
for(const name of ['BlogPostRequest','BlogPostResponse','BlogPostSummaryResponse']){
  prop(name,'pillar',{enum:['novidade','mercado','educativo','case']});prop(name,'audience',{enum:['essencial','flow-studio','ambos']});
}
// Nullable fields are emitted by the native response builders.
for(const name of ['FlowResponse','HelpDeskTicketResponse','ChannelResponse','FlowProcessingMessage']){
  for(const [field,schema] of Object.entries(schemas[name].properties)){
    if(schema.$ref)schemas[name].properties[field]={allOf:[schema],nullable:true};else schema.nullable=true;
  }
}
// This operation returns the native onboarding shape, not the Java service object.
schemas.StartResult=object({id:{...string,format:'uuid'},slug:string},['id','slug']);
schemas.SlugResult=object({slug:string,available:boolean,suggestion:string},['slug','available','suggestion']);
schemas.ApiError=object({timestamp:{...string,format:'date-time'},status:integer,message:string,path:string},['status','message']);
schemas.Health=object({status:{type:'string',enum:['UP']},service:string,stage:string,environment:string,businessHandlersReady:{type:'boolean',enum:[false]}},['status','service']);
schemas.PendingJob=object({type:{type:'string',enum:['portal-job']},jobId:{type:'string',format:'uuid'}},['type','jobId']);
schemas.EmptyBody={type:'object',description:'Esta operação não exige campos no corpo.',example:{}};
schemas.WebChatMessage=object({id:string,kind:string,text:string,choices:{type:'array',items:string},list:{allOf:[ref('FlowProcessingListPayload')],nullable:true},actionId:{...string,nullable:true},occurredAt:{...string,format:'date-time'}},['id','text']);
schemas.WebChatCommand=object({type:{type:'string',enum:['connect','message','poll','ping']},agentName:string,contactName:string,contactToken:{...string,description:'Token devolvido no connect. Obrigatório para retomar uma conversa.'},text:{...string,maxLength:20000},since:{...string,format:'date-time'}},['type','agentName']);
schemas.WebChatEnvelope=object({type:{type:'string',enum:['connected','messages','pong','error']},contactId:string,contactToken:string,agentName:string,channelSlug:string,channelName:string,message:{...string,nullable:true},status:integer,messages:{type:'array',items:ref('WebChatMessage')}},['type']);
operationContracts['WebChatCommands.execute']={request:'WebChatCommand',response:ref('WebChatEnvelope'),query:[]};

const metaMessage=object({id:string,from:string,timestamp:string,type:string,text:object({body:string}),button:object({text:string,payload:string}),interactive:object({button_reply:object({id:string,title:string}),list_reply:object({id:string,title:string})})},['id','from']);
const metaStatus=object({id:string,recipient_id:string,status:{type:'string',enum:['sent','delivered','read','failed']},timestamp:string,errors:{type:'array',items:{type:'object',additionalProperties:true}}},['id','recipient_id','status']);
const metaValue=object({
  metadata:object({phone_number_id:string,display_phone_number:string}),
  contacts:{type:'array',items:object({wa_id:string,profile:object({name:string})})},
  messages:{type:'array',items:metaMessage},statuses:{type:'array',items:metaStatus},
});
const metaChange=object({field:string,value:metaValue},['field','value']);
const metaEntry=object({id:string,changes:{type:'array',items:metaChange}},['id','changes']);
schemas.MetaWebhook=object({object:{type:'string',enum:['whatsapp_business_account']},entry:{type:'array',items:metaEntry}},['object','entry']);

const count={type:'integer',minimum:0};
schemas.PackageRequest=object({name:{type:'string',maxLength:120},maxMau:count,maxUserCount:{type:'integer',minimum:1},maxFlowCount:count,maxChannelCount:count,monthlyPriceCents:count},['name','maxMau','maxUserCount','maxFlowCount','maxChannelCount','monthlyPriceCents']);
schemas.SubscriptionPackage=object({...schemas.PackageRequest.properties,id:string,active:boolean,isDefault:boolean,currency:{type:'string',enum:['BRL']}});
schemas.DailyUsage=object({date:{type:'string',format:'date'},newMau:count,activeUsers:count,cumulativeMau:count});
schemas.MonthlyUsage=object({month:string,mau:count});
schemas.UsageReport=object({month:string,timezone:string,mau:count,limit:{...count,nullable:true},remaining:{...count,nullable:true},packageId:{...string,nullable:true},packageName:{...string,nullable:true},monthlyPriceCents:{...count,nullable:true},maxUserCount:{...count,nullable:true},maxFlowCount:{...count,nullable:true},maxChannelCount:{...count,nullable:true},trackingStartedAt:{...string,nullable:true},daily:{type:'array',items:ref('DailyUsage')},history:{type:'array',items:ref('MonthlyUsage')}});
for(const operation of ['create','update','setDefault','archive'])operationContracts[`PackageController.${operation}`]={request:['create','update'].includes(operation)?'PackageRequest':null,response:ref('SubscriptionPackage'),query:[]};
operationContracts['PackageController.list']={request:null,response:{type:'array',items:ref('SubscriptionPackage')},query:[]};
operationContracts['BillingController.usage']={request:null,response:ref('UsageReport'),query:[{name:'month',in:'query',required:false,schema:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$'},description:'Mês YYYY-MM, horário de Brasília. Padrão: mês atual.'}]};
schemas.ContractRequest.properties.packageId={type:'string',description:'Pacote que define MAU, usuários e fluxos.'};
schemas.ContractRequest.required=schemas.ContractRequest.required.filter(k=>!['maxFlowCount','maxChannelCount'].includes(k)).concat('packageId');
for(const name of ['ContractResponse','ManagedContractResponse'])if(schemas[name])Object.assign(schemas[name].properties,{packageId:string,packageName:string,maxMau:count,maxUserCount:count,monthlyPriceCents:count});
schemas.WebChatEnvelope.properties.unavailable={type:'boolean',description:'Franquia MAU atingida; nenhuma resposta de conversa é enviada.'};

export function exampleFor(name){
  if(!name)return{};
  const explicit={
    LoginRequest:{email:'usuario@example.com',password:'senha-exemplo-123'},RegisterRequest:{name:'Usuário exemplo',email:'usuario@example.com',password:'senha-exemplo-123'},
    FlowRequest:{name:'Boas-vindas',definitionJson:schemas.FlowRequest.properties.definitionJson.example},
    ChannelRequest:{name:'Chat do site',type:'WEBCHAT',agentName:'agente-exemplo'},
    WebChatCommand:{type:'connect',agentName:'agente-exemplo',contactName:'Visitante'},
    ContractEmailConnectionRequest:{name:'Email suporte',providerType:'GMAIL',fromEmail:'suporte@example.com',username:'suporte@example.com',secret:'substitua-pelo-segredo',enabled:true},
    FlowProcessingRequest:{flowId:'11111111-1111-4111-8111-111111111111',versionMode:'DRAFT',simulatorUserId:'simulador-documentacao',start:true},
  };
  if(explicit[name])return explicit[name];
  const values={companyName:'Empresa exemplo',cnpj:'40432544000147',contactEmail:'contato@example.com',contactPhone:'1143134620',address:'Rua exemplo, 100',neighborhood:'Centro',city:'São Paulo',state:'SP',zipCode:'04709110',startDate:'2026-01-01',endDate:'2030-01-01',maxFlowCount:5,maxChannelCount:5,name:'Exemplo',slug:'empresa-exemplo',path:'/pagina-exemplo',title:'Título exemplo',author:'Equipe',pillar:'educativo',audience:'ambos',role:'USER',text:'Olá, como posso ajudar?',intent:'ATENDIMENTO_CONCLUIDO',intentKey:'ATENDIMENTO_CONCLUIDO',model:'modelo-configurado',apiKey:'substitua-pela-chave',accessToken:'substitua-pelo-token',verifyToken:'substitua-pelo-verify-token',targetEmail:'destino@example.com',goal:'Crie um fluxo de boas-vindas',maxInputTokens:1000,maxOutputTokens:200,temperature:0.5};
  const example=(schema,field)=>{
    if(values[field]!==undefined)return values[field];
    if(schema.$ref)return exampleFor(schema.$ref.split('/').at(-1));
    if(schema.example!==undefined)return schema.example;
    if(schema.enum)return schema.enum[0];
    if(schema.type==='boolean')return true;
    if(schema.type==='integer'||schema.type==='number')return 1;
    if(schema.type==='array')return schema.items.$ref?[exampleFor(schema.items.$ref.split('/').at(-1))]:[];
    if(schema.format==='uuid')return '11111111-1111-4111-8111-111111111111';
    if(schema.format==='email')return 'usuario@example.com';
    return 'exemplo';
  };
  const schema=schemas[name];if(schema.enum)return schema.enum[0];
  return Object.fromEntries((schema.required??Object.keys(schema.properties??{})).map(field=>[field,example(schema.properties[field],field)]));
}

operationContracts['PackageController.delete']={request:null,response:null,query:[]};
