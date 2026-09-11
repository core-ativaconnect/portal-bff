# Deploy do portal-bff na AWS

## Provisionamento DynamoDB

O workflow cria ou atualiza todas as 26 tabelas na stack `portal-bff-data-prd`
antes de verificar as tabelas e publicar a aplicacao na stack `portal-bff-prd`.
O template completo e `infra/dynamodb-data.yml`, com chaves e indices de
`src/table-definitions.json`, capacidade sob demanda, recuperacao pontual e
TTL `expires_at` na tabela de jobs.

As 23 tabelas do BFF usam `prd_flow_bff_*`. As tres tabelas do engine usam
`flow_engine_sessions`, `flow_engine_contacts` e `flow_engine_messages`.
O workflow passa esses mesmos nomes para a stack de dados, a verificacao e
as Lambdas. As tabelas com indices sao criadas em sequencia para evitar
limites de criacao simultanea do DynamoDB.

Todas as tabelas tem `DeletionPolicy: Retain` e `UpdateReplacePolicy: Retain`.
Excluir a stack de dados preserva as tabelas. Um deploy normal atualiza a
stack existente; nao recria tabelas nem limpa os dados.

## Transicao das tabelas antigas

A criacao inicial exige que os nomes estejam livres ou que as tabelas ja sejam
gerenciadas por esta stack com os mesmos IDs logicos. CloudFormation nao adota
automaticamente tabelas existentes. Excluir tabelas apaga seus dados; faca backup
dos dados necessarios antes da remocao manual. Confira se outros servicos usam
as tabelas antes de remove-las. Nao exclua tabelas de outros projetos.

Se ja criou `portal-bff-data-prd` com `infra/dynamodb-missing-prd.yml`, o novo
template preserva os IDs logicos dessas cinco tabelas e adiciona as outras 21.
Nesse caso, mantenha as cinco tabelas que essa stack ja gerencia.
Os templates `dynamodb-missing-prd.yml` e `dynamodb-jobs.yml` sao alternativas
anteriores; use agora `dynamodb-data.yml` para o provisionamento completo.

## Atualizar o bootstrap AWS

Antes do primeiro deploy deste fluxo, atualize a pilha de bootstrap existente
(na configuracao atual ela foi nomeada `GitHubActionsDeployRoleArn`):

1. CloudFormation > pilha de bootstrap > Atualizar pilha.
2. Substitua o modelo por `infra/github-oidc-bootstrap.yml` atualizado.
3. Mantenha `CreateGitHubOidcProvider=false`, pois o provider ja existe.
4. Confirme a criacao de recursos IAM com nomes personalizados e envie.
5. Aguarde `UPDATE_COMPLETE`.

Essa atualizacao concede a role do GitHub as operacoes de provisionamento do
DynamoDB para as tabelas configuradas em us-east-1. O ARN da role permanece igual.
Para uma conta nova, crie a pilha com esse template; selecione true somente se
o provider `token.actions.githubusercontent.com` ainda nao existir.

## GitHub Environment

No environment `prd`, configure:

- Environment variable `AWS_DEPLOY_ROLE_ARN`: output `GitHubActionsDeployRoleArn` do bootstrap.
- Environment secret `APP_JWT_SECRET`: segredo JWT de producao.

A role deve estar em Variables, pois o workflow usa `vars.AWS_DEPLOY_ROLE_ARN`.
O workflow ja declara `id-token: write`. Nao sao necessarias chaves AWS estaticas.

## Executar

Depois de atualizar o bootstrap e resolver os conflitos de nomes com as tabelas
antigas, publique as alteracoes em main. O push inicia o workflow, ou use
Actions > Deploy portal-bff - PRD > Run workflow > main.

Ordem do workflow:

1. Instalar dependencias, validar sintaxe e executar testes.
2. Autenticar na AWS via OIDC e confirmar identidade.
3. Criar/atualizar `portal-bff-data-prd` com as 26 tabelas.
4. Executar `npm run check:aws:tables`.
5. Publicar a aplicacao pelo Serverless e mostrar os endpoints.

Se o provisionamento ou a verificacao falhar, a publicacao da aplicacao para.
A stack da aplicacao cria HTTP API, Lambdas, IAM de runtime, logs e recursos de
deployment. As tabelas ficam na stack de dados.

Para verificar tabelas localmente com uma sessao AWS na conta correta:

```powershell
$env:AWS_REGION="us-east-1"
$env:APP_DYNAMODB_TABLE_PREFIX="prd_"
npm run check:aws:tables
```
