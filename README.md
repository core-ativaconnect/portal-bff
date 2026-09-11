# Portal BFF

> **AWS/DynamoDB:** o workflow cria as 26 tabelas na stack `portal-bff-data-prd` antes de publicar a aplicacao. Veja `DEPLOYMENT.md`.


Projeto em construção para Node.js 20 e Serverless Framework 3.
Ainda não está pronto para substituir o backend em produção.

## Rodar com Serverless Offline

Use Node.js 20 e execute `npm install` na pasta `portal-bff`.

```bash
npm run start:local
```

Inicia o endpoint em `http://localhost:3001/commands` com stage `local` e
`NODE_ENV=development`. `npm run dev` e `npm start` são atalhos para esse comando.

```bash
npm run start:prod
```

Também inicia **localmente**, na mesma porta, mas com stage `prd` e
`NODE_ENV=production`. Não faz deploy. Rode apenas um dos dois de cada vez.
O Serverless carrega `.env.local` ou `.env.prd` conforme o stage, se existirem.
Não coloque credenciais nesses arquivos versionados.

Para verificar o servidor no PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3001/commands -ContentType 'application/json' -Body '{"path":"/actuator/health","method":"GET","body-data":{}}'
```

O health confirma o funcionamento do transporte. Os caminhos de negócio mapeados
retornam **501** enquanto seus handlers não forem migrados; o Offline não substitui
essa implementação. Por isso o flow-studio ainda não foi conectado definitivamente
ao novo backend. Não há acesso ao DynamoDB nesta etapa de inicialização.

Plugin: [Serverless Offline 13.9.0](https://github.com/dherault/serverless-offline/tree/v13.9.0), compatível com Serverless 3.

Entrada HTTP prevista: `POST /commands`.

```json
{
  "path": "/api/v1/contracts?confirmation=empresa",
  "method": "DELETE",
  "body-data": {}
}
```

`uri` é aceito como alias de `path`. O token continua no cabeçalho
`Authorization: Bearer <token>`. Os parâmetros de consulta ficam no caminho.
As respostas devem preservar os status HTTP e os DTOs esperados pelo flow-studio.

`src/routes.json` contém o inventário de 120 operações HTTP do flow-bff,
com seus caminhos, métodos e classificação inicial de acesso. O webhook da Meta
foi excluído desse inventário. As permissões por contrato continuam necessárias
além dessa classificação por rota.

Concluído: inventário, parser, resolução de rotas e testes do transporte.
Pendente: handlers de negócio, autenticação, persistência e integração efetiva
do aplicativo. As decisões de backend independente versus encaminhamento e do
transporte em tempo real foram solicitadas ao usuário antes dessa implementação.

Referência da configuração HTTP API:
https://www.serverless.com/framework/docs/providers/aws/events/http-api
