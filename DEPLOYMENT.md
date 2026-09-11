# Deploy do portal-bff na AWS com GitHub Actions

## Decisao importante sobre DynamoDB

As tabelas DynamoDB usadas pelo portal-bff sao tratadas como **recursos externos existentes**. A stack principal `portal-bff-prd` NAO cria, importa, atualiza nem remove essas tabelas.

Isso e intencional: varias tabelas ja existem na conta AWS e algumas, como `flow_engine_sessions`, `flow_engine_contacts` e `flow_engine_messages`, podem ser compartilhadas com outros servicos. Importa-las para a stack do BFF faria o CloudFormation passar a gerencia-las.

O deploy executa `npm run check:aws:tables` depois de autenticar na AWS. O script consulta as 26 tabelas esperadas. Se alguma estiver ausente, o deploy para antes de alterar Lambda/API Gateway e mostra os nomes faltantes.

## Arquitetura

GitHub Actions -> OIDC -> IAM Role temporaria -> Serverless Framework -> CloudFormation -> HTTP API Gateway + Lambdas + IAM + CloudWatch

DynamoDB fica fora da stack principal:

portal-bff Lambda -> IAM de runtime -> tabelas DynamoDB existentes

## Arquivos principais

- `.github/workflows/deploy-prd.yml`: testes, OIDC, preflight das tabelas e deploy.
- `infra/github-oidc-bootstrap.yml`: provider OIDC opcional e role de deploy.
- `scripts/check-aws-tables.mjs`: verifica se todas as tabelas esperadas existem.
- `infra/dynamodb-jobs.yml`: stack OPCIONAL apenas para `flow_bff_jobs`, caso ela seja uma das tabelas faltantes.
- `serverless.yml`: cria a aplicacao, mas nao declara tabelas DynamoDB.

## Bootstrap AWS

Crie uma vez a stack `portal-bff-github-bootstrap` usando `infra/github-oidc-bootstrap.yml`.

Se `token.actions.githubusercontent.com` ainda nao existir em IAM > Identity providers, use `CreateGitHubOidcProvider=true`. Se ja existir, use `false`.

Depois copie o output `GitHubActionsDeployRoleArn`.

## GitHub Environment

Crie o environment `prd` e configure:

Environment variable:

- `AWS_DEPLOY_ROLE_ARN`: ARN retornado pela stack bootstrap.

Environment secret:

- `APP_JWT_SECRET`: segredo JWT de producao.

Nao crie `AWS_ACCESS_KEY_ID` ou `AWS_SECRET_ACCESS_KEY` para o workflow. O acesso e via OIDC.

## Preflight DynamoDB local

Se voce ja tiver uma sessao AWS configurada no computador, pode verificar antes do primeiro push:

```powershell
$env:AWS_REGION="us-east-1"
npm run check:aws:tables
```

Se os nomes `flow_engine_*` forem diferentes nessa conta, configure antes:

```powershell
$env:APP_ENGINE_DYNAMODB_SESSIONS_TABLE="flow_engine_sessions"
$env:APP_ENGINE_DYNAMODB_CONTACTS_TABLE="flow_engine_contacts"
$env:APP_ENGINE_DYNAMODB_MESSAGES_TABLE="flow_engine_messages"
npm run check:aws:tables
```

O mesmo conjunto de variaveis existe no workflow de PRD.

## Se alguma tabela estiver faltando

Nao adicione automaticamente todas as tabelas ao `serverless.yml`.

Primeiro identifique a propriedade da tabela:

- tabela ja existente/compartilhada: mantenha externa ao BFF;
- tabela que deveria pertencer a outro servico: crie pela IaC daquele servico;
- tabela nova e exclusiva do portal-bff: crie em uma stack de dados separada.

O projeto inclui `infra/dynamodb-jobs.yml` porque `flow_bff_jobs` era a unica tabela criada pelo `serverless.yml` original. Use esse template SOMENTE se o preflight confirmar que `flow_bff_jobs` nao existe:

```powershell
aws cloudformation deploy `
  --stack-name portal-bff-data `
  --template-file infra/dynamodb-jobs.yml `
  --region us-east-1
```

Se `flow_bff_jobs` ja existir, NAO execute esse comando.

## Primeiro deploy

Depois de configurar AWS e GitHub:

```bash
git add .
git commit -m "Configure AWS deployment with GitHub Actions"
git push -u origin main
```

O workflow faz:

1. `npm ci`
2. `npm run check`
3. `npm test`
4. OIDC / `sts:AssumeRoleWithWebIdentity`
5. `npm run check:aws:tables`
6. `serverless deploy --stage prd --region us-east-1`

Se a etapa 5 falhar, nenhuma tabela sera criada pelo workflow e o deploy da aplicacao nao sera executado.

## Recursos criados pela stack principal

A stack do Serverless cria recursos da aplicacao, entre eles:

- HTTP API Gateway com `POST /commands`;
- Lambda `portal-bff-prd-commands`;
- Lambda `portal-bff-prd-worker`;
- IAM role/policies de runtime;
- CloudWatch Log Groups;
- bucket/objetos de deployment usados pelo Serverless conforme necessario.

As tabelas DynamoDB nao fazem parte dessa stack.

## Permissao de runtime para tabelas existentes

O `serverless.yml` concede as operacoes de dados requeridas para `flow_bff_*`, seus indexes, e para as tres tabelas `flow_engine_*`. Isso apenas autoriza as Lambdas a usa-las; nao as coloca sob gerenciamento do CloudFormation.

## Observacoes do projeto

- `APP_JWT_SECRET` e obrigatorio fora de local.
- O projeto continua em Node.js 20 + Serverless Framework 3 para nao misturar o primeiro deploy com migracao de runtime/framework.
- O erro de indentacao da rota `/commands` do `serverless.yml` original esta corrigido.
- O health atual informa `businessHandlersReady: false`; revise antes de usa-lo como readiness.
- `PORTAL_BOOTSTRAP_OWNER_EMAIL` nao promove automaticamente o primeiro OWNER; use `scripts/create-owner.mjs` conforme o fluxo atual.
