export function buildAsyncApi(){
  const text={type:'string'};
  const object=(properties,required)=>({type:'object',properties,required});
  const message=object({id:text,kind:text,text,choices:{type:'array',items:text},list:{type:['object','null'],additionalProperties:true},actionId:{type:['string','null']},occurredAt:{type:'string',format:'date-time'}},['id','text']);
  const messages={
    connect:{name:'connect',title:'Iniciar ou retomar conversa',payload:object({type:{const:'connect'},agentName:text,contactName:text,contactToken:{type:'string',description:'Token recebido em connected; necessário para retomar a conversa. contactId sozinho não autentica.'}},['type','agentName']),examples:[{payload:{type:'connect',agentName:'agente-exemplo',contactName:'Visitante'}}]},
    message:{name:'message',title:'Enviar mensagem do visitante',payload:object({type:{const:'message'},text:{type:'string',minLength:1,maxLength:20000}},['type','text']),examples:[{payload:{type:'message',text:'Olá'}}]},
    ping:{name:'ping',payload:object({type:{const:'ping'}},['type']),examples:[{payload:{type:'ping'}}]},
    connected:{name:'connected',payload:object({type:{const:'connected'},contactId:text,contactToken:text,agentName:text,channelSlug:text,channelName:text,messages:{type:'array',items:message}},['type','contactId','contactToken'])},
    messages:{name:'messages',payload:object({type:{const:'messages'},contactId:text,messages:{type:'array',items:message}},['type','messages'])},
    pong:{name:'pong',payload:object({type:{const:'pong'},contactId:text},['type'])},
    error:{name:'error',payload:object({type:{const:'error'},status:{type:'integer'},message:text},['type','message'])},
  };
  const channel={address:'/ws/webchat',description:'Uma conexão mantém o agente e o token de contato. message/ping exigem connect. Mensagens do atendente chegam por push. Na AWS, use ChatWebSocketUrl da stack; o host WebSocket é independente da API HTTP.',servers:[{$ref:'#/servers/local'}],messages:Object.fromEntries(Object.keys(messages).map(name=>[name,{$ref:'#/components/messages/'+name}]))};
  return {asyncapi:'3.0.0',info:{title:'Portal BFF — Webchat',version:'0.1.0',description:'Chat JSON por WebSocket. Envie ping a cada 25 segundos e reconecte com contactToken. Remova mensagens duplicadas por id. Não use JWT administrativo no handshake. O token de contato expira em 30 dias; conexões AWS podem encerrar em até 2 horas. O deploy fornece o host WSS em ChatWebSocketUrl.'},defaultContentType:'application/json',servers:{local:{host:'localhost:3003',protocol:'ws',description:'Serverless Offline. Produção: substitua pelo host de ChatWebSocketUrl.'}},channels:{webchat:channel},operations:Object.fromEntries(Object.keys(messages).map(name=>[name,{action:['connect','message','ping'].includes(name)?'receive':'send',channel:{$ref:'#/channels/webchat'},messages:[{$ref:'#/channels/webchat/messages/'+name}]}])),components:{messages}};
}
