import {routes} from '../router.mjs';
import {isDeskRoute} from '../desk-routes.mjs';
import {schemas,operationContracts,ref,exampleFor} from './schemas.mjs';

export const productionUrl='https://api.tiudi.com.br/portal';
const groups={AuthController:'Autenticação',UserAdminController:'Usuários',StartController:'Onboarding',ContractController:'Contratos',ContractDeleteController:'Contratos',FlowController:'Fluxos',FlowProcessingController:'Motor de fluxos',PlatformController:'Plataforma',PlatformChannelController:'Canais da plataforma',ChannelController:'Canais',PlatformHelpDeskController:'Atendimento',WhatsAppAdminController:'Administração WhatsApp',AdminBlogController:'Blog administrativo',PublicBlogController:'Blog público',AdminStaticPageController:'Páginas administrativas',PublicStaticPageController:'Páginas públicas',WebChatCommands:'Webchat HTTP'};
const extraRoutes=[
  {controller:'Runtime',operation:'health',method:'GET',path:'/actuator/health',access:'PUBLIC'},
  {controller:'Jobs',operation:'status',method:'GET',path:'/api/v1/jobs/{jobId}',access:'AUTHENTICATED'},
];
const extras={
  'Runtime.health':{request:null,response:ref('Health'),query:[]},
  'Jobs.status':{request:null,response:{anyOf:[ref('FlowAiDraftResponse'),ref('PendingJob')]},query:[]},
};
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const key=r=>`${r.controller}.${r.operation}`;
const auth=r=>r.access==='PUBLIC'&&r.controller!=='FlowProcessingController';
const contract=r=>operationContracts[key(r)]??extras[key(r)];
const needsJob=r=>r.controller==='ContractDeleteController'||r.operation==='generateAiDraft'||r.controller==='Jobs';
const content=schema=>({'application/json':{schema}});
const errorResponses=()=>Object.fromEntries([400,401,403,404,405,409,500,502,503,504].map(code=>[code,{description:({400:'Entrada inválida',401:'Autenticação ausente ou inválida',403:'Acesso negado',404:'Recurso ou comando não encontrado',405:'Método não permitido',409:'Conflito ou registro em exclusão',500:'Falha interna',502:'Falha da integração externa',503:'Serviço indisponível',504:'Tempo de execução excedido'})[code],content:content(ref('ApiError'))}]));

export const commandCatalog=[...routes,...extraRoutes].map(route=>{
  const definition=contract(route);if(!definition)throw new Error(`Missing documentation for ${key(route)}`);
  const parameters=[...route.path.matchAll(/\{(\w+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
  let samplePath=route.path.replace(/\{(\w+)\}/g,(_,name)=>/slug/i.test(name)?'empresa-exemplo':'11111111-1111-4111-8111-111111111111');
  if(definition.query.length)samplePath+='?'+new URLSearchParams(definition.query.filter(q=>!['cursor','contactId'].includes(q.name)).map(q=>[q.name,q.name==='month'?'2026-09':['paged','sync'].includes(q.name)?'true':q.name==='limit'?'50':q.name==='path'?'/pagina-exemplo':'empresa-exemplo']));
  const pattern='^'+route.path.split('/').map(segment=>/^\{\w+\}$/.test(segment)?'[^/?]+':escape(segment)).join('/')+'/?(?:\\?.*)?$';
  const access=route.controller==='FlowProcessingController'?'AUTHENTICATED':route.operation==='deleteChannel'?'OWNER':route.access;
  return {...route,access,id:key(route),group:groups[route.controller]??route.controller,public:auth(route),
    requestSchema:definition.request??'EmptyBody',responseSchema:definition.response,parameters:[...parameters,...definition.query],
    asynchronous:needsJob(route),example:{path:samplePath,method:route.method,'body-data':exampleFor(definition.request)},pattern};
});

function envelope(entry){
  const access=entry.public?'Público':entry.access==='OWNER'?'Exige usuário OWNER':'Exige JWT de usuário ativo e acesso ao contrato quando aplicável';
  return {title:`${entry.method} ${entry.path}`,description:`${access}. ${entry.asynchronous?'Em produção pode retornar 202; consulte o job pelo próprio /commands.':''}`,
    type:'object',properties:{path:{type:'string',pattern:entry.pattern,example:entry.example.path},uri:{type:'string',pattern:entry.pattern,description:'Alias de path. Se ambos forem enviados, devem ser iguais.'},method:{type:'string',enum:[entry.method]},'body-data':ref(entry.requestSchema)},
    required:['method'],anyOf:[{required:['path']},{required:['uri']}],example:entry.example,
    'x-access':entry.public?'PUBLIC':entry.access,'x-logical-parameters':entry.parameters,'x-response-schema':entry.responseSchema};
}

export function buildOpenApi(selectedCommand){
  const entries=selectedCommand?commandCatalog.filter(c=>c.id===selectedCommand):commandCatalog;
  if(!entries.length)throw new Error('Unknown command');
  const componentSchemas=structuredClone(schemas);
  for(const entry of entries)componentSchemas[`Command.${entry.id}`]=envelope(entry);
  const commandResponses=entries.map(e=>e.responseSchema).filter(Boolean);
  const responses={...errorResponses()};
  if(commandResponses.length)responses['200']={description:'Resultado da operação selecionada. O DTO é o corpo da resposta, sem envelope adicional.',content:content(commandResponses.length===1?commandResponses[0]:{anyOf:commandResponses})};
  if(entries.some(e=>e.responseSchema===null||e.controller==='Jobs'))responses['204']={description:'Operação de exclusão concluída, sem corpo.'};
  if(entries.some(e=>e.asynchronous))responses['202']={description:'Operação em segundo plano. Consulte GET /api/v1/jobs/{jobId} dentro de POST /commands, com o mesmo JWT, até receber o resultado final.',content:content(ref('PendingJob'))};
  const exampleMap=Object.fromEntries(entries.map(e=>[e.id,{summary:`${e.group}: ${e.method} ${e.path}`,value:e.example}]));
  const publicEntries=entries.filter(e=>e.public),protectedEntries=entries.filter(e=>!e.public);
  const description=selectedCommand
    ? `Comando lógico **${entries[0].method} ${entries[0].path}**. Envie o envelope a POST /commands. Parâmetros de caminho e query ficam dentro de path, sem o prefixo /portal.\n\n${envelope(entries[0]).description}`
    : `Transporte do Studio para ${entries.length} operações, incluindo health, jobs e webchat HTTP. Selecione um exemplo ou use o catálogo acima para ver apenas um comando.\n\nAs rotas /api/v1/... deste catálogo são caminhos lógicos dentro do JSON: não são endpoints REST publicados. Use Authorize para comandos protegidos. OWNER é exigido conforme x-access. O webhook Meta e a API REST do Desk são endpoints separados.\n\nQueries como confirmation, path e value devem constar na string path do envelope. Em produção exclusão de contrato e geração de rascunho por IA usam jobs assíncronos.`;
  const paths={'/commands':{post:{tags:['Studio — Commands'],operationId:selectedCommand?`command.${selectedCommand}`:'executeCommand',summary:selectedCommand?`${entries[0].method} ${entries[0].path}`:'Executar comando do Studio',description,
    security:[...(publicEntries.length?[{}]:[]),...(protectedEntries.length?[{bearerAuth:[]}]:[])],
    requestBody:{required:true,content:{'application/json':{schema:entries.length===1?ref(`Command.${entries[0].id}`):{anyOf:entries.map(e=>ref(`Command.${e.id}`))},examples:exampleMap}}},responses,
    'x-command-catalog':entries.map(({id,method,path,access,public:pub,requestSchema,responseSchema,parameters,asynchronous})=>({id,method,path,access:pub?'PUBLIC':access,requestSchema,responseSchema,parameters,asynchronous}))}}};
  if(!selectedCommand){
    for(const entry of commandCatalog.filter(isDeskRoute)){
      const path='/flow-desk'+entry.path;
      const operation={tags:['Flow Desk — REST'],operationId:`desk.${entry.id}`,summary:`${entry.group}: ${entry.operation}`,description:'Método e corpo HTTP diretos, sem envelope de commands. Exige usuário ativo e acesso ao contrato.',security:entry.public?[]:[{bearerAuth:[]}],parameters:entry.parameters,
        responses:{...errorResponses(),...(entry.responseSchema?{'200':{description:'Resultado da operação.',content:content(entry.responseSchema)}}:{'204':{description:'Operação concluída, sem corpo.'}})}};
      if(entry.requestSchema!=='EmptyBody')operation.requestBody={required:true,content:{'application/json':{schema:ref(entry.requestSchema),example:entry.example['body-data']}}};
      paths[path]??={};paths[path][entry.method.toLowerCase()]=operation;
    }
    paths['/v1/webhook/meta']={
      get:{tags:['Meta — Webhook'],operationId:'meta.verify',summary:'Verificar a assinatura da inscrição do webhook',description:'Valida o verify token cadastrado no app. Não usa JWT nem /commands.',security:[],parameters:['hub.mode','hub.verify_token','hub.challenge'].map(name=>({name,in:'query',required:true,schema:{type:'string',...(name==='hub.mode'?{enum:['subscribe']}:{})}})),responses:{'200':{description:'Challenge original em texto puro.',content:{'text/plain':{schema:{type:'string'},example:'12345'}}},'403':{description:'Verify token ou solicitação inválidos.'}}},
      post:{tags:['Meta — Webhook'],operationId:'meta.receive',summary:'Receber mensagens e status da Meta',description:'X-Hub-Signature-256 = sha256= + HMAC-SHA256 hexadecimal dos bytes EXATOS do corpo, usando o App Secret configurado em APP_WHATSAPP_META_APP_SECRETS. O app é localizado pelo WABA. Não usa JWT. Na AWS confirma apenas após enfileirar em SQS FIFO; Offline processa sincronamente. Uma assinatura produzida sobre outro JSON será rejeitada.',security:[{metaSignature:[]}],requestBody:{required:true,content:content(ref('MetaWebhook'))},responses:{'200':{description:'Recebimento confirmado.',content:{'text/plain':{schema:{type:'string',enum:['EVENT_RECEIVED']}}}},'400':{description:'Payload inválido.'},'403':{description:'Assinatura ausente ou inválida.'},'404':{description:'WABA, app ou telefone não encontrados.'},'503':{description:'Falha ao enfileirar; a entrega pode ser repetida pela Meta.'}}},
    };
    for(const [path,summary,type] of [['/docs','Swagger UI','text/html'],['/openapi.json','Documento OpenAPI','application/json'],['/asyncapi.json','Protocolo WebSocket em AsyncAPI','application/json']]){
      paths[path]={get:{tags:['Documentação'],operationId:'docs.'+path.slice(1).replace('.','_'),summary,security:[],responses:{
        '200':{description:summary,content:{[type]:{schema:type==='text/html'?{type:'string'}:{type:'object',additionalProperties:true}}}},
      }}};
    }
    paths['/openapi.json'].get.parameters=[{name:'command',in:'query',required:false,description:'ID do catálogo, por exemplo AuthController.login. Filtra o Swagger para uma operação lógica.',schema:{type:'string',enum:commandCatalog.map(e=>e.id)}}];
  }
  return {openapi:'3.0.3',info:{title:selectedCommand?`Portal BFF — ${entries[0].group}`:'Portal BFF — API completa',version:'0.1.0',description:'Studio via commands, Flow Desk via REST, webhook Meta e documentação. Chat WebSocket: veja /docs/websocket.html e /asyncapi.json. Os exemplos usam valores fictícios; substitua IDs e credenciais. Testar operações pode alterar dados do servidor selecionado.'},
    servers:[{url:'.',description:'Servidor onde este documento foi aberto'},{url:productionUrl,description:'Produção Tiudi'},{url:'http://localhost:3001',description:'Serverless Offline'}],
    tags:[{name:'Studio — Commands'},{name:'Flow Desk — REST'},{name:'Meta — Webhook'},{name:'Documentação'}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'JWT',description:'accessToken devolvido pelo login. Informe somente o token; o Swagger adiciona Bearer.'},metaSignature:{type:'apiKey',in:'header',name:'X-Hub-Signature-256',description:'Assinatura HMAC-SHA256 dos bytes originais do corpo; não é um token fixo.'}},schemas:componentSchemas}};
}
