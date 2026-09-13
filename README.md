# Portal BFF

Pacotes SaaS, franquias de MAU e dashboard de consumo: veja [docs/saas-mau.md](docs/saas-mau.md),
incluindo a migração necessária dos contratos existentes antes de ativar o novo backend.

Backend Node.js 20 / Serverless Framework 3 com handlers nativos e DynamoDB.

## Swagger e contratos da API

- Swagger UI local: http://localhost:3001/docs (alias: /swagger).
- Após o deploy: https://api.tiudi.com.br/portal/docs.
- OpenAPI: /openapi.json. AsyncAPI do chat: /asyncapi.json.
- Guia do WebSocket: /docs/websocket.html.

O catálogo pesquisável permite selecionar cada comando do Studio, com campos,
exemplo, autorização e resposta. As operações lógicas são enviadas ao endpoint
POST /commands; elas não são anunciadas como rotas REST inexistentes.
O Swagger principal também mostra os endpoints reais do Desk e da Meta.
Selecione o servidor e use Authorize com o accessToken para testar chamadas
protegidas. O token não é persistido entre recargas e a especificação não é
enviada a validadores externos. Os arquivos do Swagger são servidos pelo BFF.

Execute npm run docs:check para validar OpenAPI, exemplos, AsyncAPI e cobertura
do catálogo. npm run docs:export gera os arquivos em docs/generated para
importação em ferramentas externas. Os schemas ficam em src/docs/contracts.json,
com regras do runtime em src/docs/schemas.mjs. Ao adicionar uma rota de negócio,
atualize seu contrato; os testes falham se faltar documentação.

| Cliente | Transporte local |
| --- | --- |
| Flow Studio | POST http://localhost:3001/commands |
| Flow Desk | REST em http://localhost:3001/flow-desk/api/v1 |
| Meta | GET e POST http://localhost:3001/v1/webhook/meta |
| Chat | ws://localhost:3003/ws/webchat |

## Execução local

Use Node.js 20, instale com npm ci, disponibilize DynamoDB Local na porta 8000,
execute npm run init:local e depois npm run start:local.
APP_DYNAMODB_ENDPOINT permite usar outra porta. npm run start:prod também roda
localmente, mas usa configuração de produção; não faz deploy.

O Studio mantém o envelope {"path":"/api/v1/auth/login","method":"POST","body-data":{}}.
O token de usuário permanece no cabeçalho Authorization: Bearer.
As 120 operações legadas, exceto os webhooks, estão em src/routes.json.
O endpoint HTTP de webchat existente foi mantido por compatibilidade.

O Desk envia método e corpo HTTP diretamente, por exemplo
POST /flow-desk/api/v1/auth/login com {"email":"...","password":"..."}.
A API permite login, perfil, contratos acessíveis, leitura de configurações de
atendimento e operações de tickets. Rotas administrativas do Studio não são
expostas por esse transporte. Configure VITE_API_BASE_URL no Flow Desk.

## WebSocket

Depois do handshake, envie:

    {"type":"connect","agentName":"meu-agente","contactName":"Visitante"}

O servidor devolve connected com contactId e contactToken. Guarde o token e
inclua-o em um novo connect para retomar o histórico. Um contactId sozinho não
autoriza acesso a uma conversa. Na conexão autenticada, envie
{"type":"message","text":"Olá"} ou {"type":"ping"}.
O servidor responde com envelopes messages, pong ou error.
Mensagens do atendente são enviadas pelo servidor, sem polling do navegador.

Os exemplos em ../chat aceitam globalThis.PORTAL_CHAT_WS_URL antes do script.
O padrão é local. Em produção, configure o output ChatWebSocketUrl do deploy.
CloudFront publica /ws/webchat e encaminha o handshake para o stage WebSocket
do API Gateway; o envio pelo servidor usa o endereço interno do API Gateway.
As conexões ficam em flow_bff_websocket_connections com TTL e são removidas
no disconnect ou quando o API Gateway informa conexão encerrada.

## Meta

O GET valida o verify token cadastrado no app e devolve hub.challenge.
O POST valida X-Hub-Signature-256 sobre os bytes originais do corpo,
usando o App Secret da Meta, diferente do access token e do verify token.

Configure APP_WHATSAPP_META_APP_SECRETS como JSON com App IDs como chaves:

    {"123456789":"app-secret-configurado-na-meta"}

Não versione segredos reais. Na AWS, eventos autenticados entram em SQS FIFO,
ordenados por telefone e remetente, antes do EVENT_RECEIVED. O worker registra
mensagens, atualiza status, executa fluxos publicados, envia textos/botões/listas
e abre ou retoma atendimento humano. Falhas são repetidas e, após cinco tentativas,
seguem para a DLQ. No Offline, o processamento é síncrono e dispensa SQS.

O estado do motor e a resposta para reentrega são gravados na mesma transação.
O envio externo à Meta não participa dessa transação: uma interrupção depois do
aceite da Graph API e antes da confirmação local ainda pode duplicar uma resposta.
Revise a DLQ antes de reenviar mensagens. Anexos recebidos são preservados no
histórico; somente texto e respostas interativas alimentam o motor.

## Validação

Execute npm run init:local e npm test com RUN_DYNAMODB_TESTS=1.
Com o Offline rodando, adicione RUN_OFFLINE_TESTS=1 para o teste de WebSocket
real, resposta do atendente pelo Desk e reconexão. Sem essas variáveis, os testes
que dependem de serviços locais são ignorados. O CI inicia os serviços.

npm run package -- --stage local valida o empacotamento sem publicar recursos.
O health verifica o transporte; businessHandlersReady não certifica a migração.
A substituição do serviço antigo ainda exige configurar endpoints, segredos e
homologar integrações externas. Veja [DEPLOYMENT.md](DEPLOYMENT.md).
