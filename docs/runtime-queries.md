# Consultas do runtime sem Scan

## O que mudou

O caminho de mensagens Meta usa GetItem e Query. Callbacks não percorrem mais
`flow_engine_messages`; procuram uma referência por telefone interno e ID Meta.
O histórico continua na tabela existente, com as mesmas chaves.

A nova tabela `flow_bff_runtime_records` contém:

| pk | sk | Finalidade |
| --- | --- | --- |
| `META#<phoneId>` | `MESSAGE#<messageId>` | Localizar contrato, canal e contato da mensagem enviada |
| `CONVERSATION#<channelId>#<contactId>` | `MESSAGE#<occurredAt>#<messageId>` | Página cronológica de referências ao histórico |
| `CONVERSATION#<channelId>#<contactId>` | `TICKET` | Ticket ativo, validado por leitura da tabela de tickets |
| `SESSION#<contractId>#<userId>` | `FLOW#<flowId>#<versionId>` | Chave real da sessão, inclusive após troca de fluxo |
| `CHANNEL#<channelId>` | `CONTACT#<contactId>` | Resumo da última mensagem da conversa |

O GSI `list-index` usa `list_pk/list_sk`, preenchidos somente nos resumos, para
listar conversas por última interação. Ele não replica o payload das mensagens.
Todos os registros têm `contract_id` para limpeza na exclusão do contrato.
Não há TTL nessas referências principais: devem acompanhar a retenção do histórico.
O diário incremental usa `expires_at`, com TTL de sete dias.

Histórico, referência cronológica e referência Meta são gravados em uma única
transação. O resumo é atualizado em seguida, condicionalmente, sem substituir
uma mensagem mais recente. Não se deve interpretar o resumo como fonte primária
de auditoria: ele pode precisar ser reconstruído após uma falha entre essas etapas.

Callbacks antecipados sem referência retornam erro ao consumidor, permanecendo
sob retry/redrive da SQS. Podem chegar à DLQ se a referência não aparecer; não são
descartados como sucesso. Repetições e regressões de status são tratadas por
atualizações condicionais; isso não elimina a janela de duplicação entre a Graph
API e a persistência do envio.

As leituras pelos índices existentes ficam restritas à WABA, telefone, canal,
contato ou fluxo solicitado. O canal retornado pelo índice do telefone é relido
na tabela base antes do roteamento. Publicações novas mantêm
`flows.published_version_id` para leitura direta. A migração preenche esse ponteiro
para os fluxos antigos. O fallback de versões usa Query por fluxo, nunca Scan.

Metadados de transporte são reutilizados somente dentro de uma entrega Meta.
Checkpoints alteram apenas os campos modificados; isso reduz tráfego, mas DynamoDB
continua calculando o custo da atualização conforme o tamanho do item, portanto
não representa por si só redução proporcional das unidades de escrita.

## Implantação com dados existentes

**Não ativar as novas Lambdas antes da migração.** Em especial, tickets abertos,
sessões que trocaram de fluxo e referências de mensagens antigas dependem dela.
A criação da tabela no CloudFormation não preenche esses registros automaticamente.

1. Provisionar a stack de dados com `infra/dynamodb-data.yml`, incluindo
   `flow_bff_runtime_records`. A esteira existente já provisiona essa stack antes
   das Lambdas; coordenar esta primeira implantação para executar a migração antes
   da etapa de deploy do código. Não executar a esteira completa sem esse preparo.
2. Configurar as mesmas região, prefixo e overrides das tabelas do ambiente alvo.
   Scripts usam `APP_STAGE=prd` para credenciais AWS, e exigem `APP_JWT_SECRET`
   devido à configuração compartilhada do Store. Não usar stage local contra AWS.
3. Executar o dry-run abaixo e analisar contagens e registros ignorados.
4. Pausar escritores: consumidor Meta, mensagens Webchat/Desk e alterações de
   canais, fluxos e tickets. Manter o ingresso Meta enfileirando quando possível;
   aguardar as execuções em andamento terminarem. Não esvaziar ou excluir a fila.
5. Executar a migração com `--apply --writers-paused`. A flag é uma declaração do
   operador; o script não pausa AWS ou frontends automaticamente.
6. Corrigir qualquer erro ou registro ignorado relevante e repetir. O script é
   reexecutável. Duplicidade de tickets ativos precisa ser reconciliada.
7. Publicar o backend novo e depois o Flow Studio; reativar os escritores.
   Verificar callbacks, DLQ, continuação de sessões e páginas de conversa.

Na pasta `portal-bff`, com ambiente e credenciais já configurados:

```powershell
# Somente leitura: não preenche referências.
node scripts/migrate-runtime-records.mjs

# Após pausar os escritores e conferir o destino.
node scripts/migrate-runtime-records.mjs --apply --writers-paused
```

`--contract-id=<id>` restringe histórico, sessões, tickets e ponteiro de publicação
ao contrato escolhido. O preenchimento dos atributos de índice das tabelas de
configuração é global, inclusive nessa modalidade, pois apps e telefones são
compartilhados. A execução é sequencial e faz Scan paginado do histórico; não
carrega todas as mensagens em memória. Scans de manutenção têm custo e não devem
ser disparados a cada deploy.

Os relacionamentos de telefone históricos são inferidos pelo canal atual na
migração. Canais excluídos, mensagens sem data e transferências antigas de telefone
podem exigir reconciliação manual. A migração informa registros ignorados e não
inventa datas. O script não substitui uma auditoria desses casos.

Para uma base local nova, `npm run init:local` cria a tabela. Para uma base local
existente, parar o servidor local, executar init e a migração antes de reiniciá-lo.

## Paginação HTTP

Os caminhos lógicos continuam sendo enviados em `/commands`:

```text
GET /api/v1/platform/contracts/<slug>/channels/<channel>/contacts?paged=true&limit=50
GET /api/v1/platform/contracts/<slug>/channels/<channel>/contacts/<contactId>/messages?paged=true&limit=50
```

Resposta:

```json
{"items": [], "nextCursor": null}
```

Passar o `nextCursor` em `cursor` para a próxima página. Limite de 1 a 100.
O cursor pertence ao canal/conversa; não reutilizar entre recursos. Contatos são
ordenados por última interação; mensagens vêm em páginas das mais recentes para
as antigas, ordenadas cronologicamente dentro de cada página. Alterações durante
a paginação podem mover resumos: o frontend elimina IDs repetidos.

`contactId` na listagem de contatos permite obter um resumo por chave, inclusive
quando o link direto aponta para uma conversa fora da primeira página.

Clientes antigos sem `paged=true` continuam recebendo arrays. A conversa legada
usa Query por contato; a lista de contatos usa os resumos. Isso preserva a API,
mas esses consumidores ainda podem ler todas as páginas daquele recurso. O Flow
Studio foi atualizado para paginação real. Polls antigos do Webchat e do Desk
continuam compatíveis e podem ler a conversa inteira. Os dois clientes do Desk
agora usam a sincronização incremental abaixo. O Webchat mantém seu protocolo.

## Sincronização incremental do Desk

No endpoint lógico de mensagens do ticket, usar `?sync=true` e depois
`?sync=true&cursor=<cursor-anterior>`. A rota REST independente do Flow Desk
aceita os mesmos parâmetros. A resposta tem `messages`, `cursor`, `reset` e
`hasMore`. Sem `sync=true`, o retorno continua sendo o array legado.

- A primeira consulta retorna um snapshot e habilita o diário daquela conversa.
- Uma conversa nunca aberta no Desk não grava esse diário. Existe uma leitura e
  uma condição transacional para verificar sua ativação, evitando perder uma
  mensagem gravada simultaneamente à primeira consulta.
- Cada alteração posterior de mensagem/status grava, na mesma transação, uma
  revisão crescente e uma referência `CHANGE#<revisão>` na partição da conversa.
- Sem mudanças, a sincronização lê somente o registro `REVISION`, sem acessar
  histórico. Isso não elimina as leituras de autenticação, contrato e ticket do
  endpoint nem a consulta separada à lista de tickets.
- Com mudanças, retorna até 100 referências por página, buscando apenas as
  mensagens afetadas. `hasMore=true` pede continuação imediata pelo novo cursor.
- O cliente faz merge por `messageId`, inclusive para status de mensagens antigas.
  `reset=true` exige substituir a cópia local pelo snapshot.
- Lacunas, expiração de cursor ou cursor adiantado provocam novo snapshot. O
  cursor inclui o canal/contato e não pode ser reutilizado em outra conversa.
- O diário expira após sete dias; o histórico principal não é excluído por esse TTL.
  Uma conversa já aberta continua registrando mudanças futuras, mesmo sem um
  atendente conectado. Há escritas adicionais nesse caso, compensadas pela redução
  das releituras do Desk; o ganho depende da frequência de consultas.

Flow Studio e Flow Desk preservam o cursor entre polls, fazem merge de deltas e
pausam consultas de mensagens com a aba oculta. O Flow Desk não sobrepõe polls nem
reinicia o cursor quando apenas a lista de tickets muda. Trocar contrato/ticket
ou reconectar invalida a cópia local. A lista de tickets continua sendo consultada
separadamente, sem delta nesta versão.

Callbacks repetidos ou regressivos não gravam novamente o histórico nem um resumo
já atualizado. Um resumo desatualizado ainda é reconciliado em uma repetição.
Atualizações de mensagens antigas não tentam sobrescrever a última conversa.

Jobs Meta concluídos removem a cópia de `messages`, preservando estado de conclusão
e checkpoints. O resultado de retry do motor mantém mensagens BUSINESS; DEBUG e
USER não são duplicadas nesse registro interno. Não são removidos dados do
histórico nem variáveis da sessão. O motor reaproveita definição e sessão lidas
na mesma execução; uma condição sobre `updated_at` protege a aquisição de uma
sessão contra uma leitura que ficou desatualizada.

## Medição em produção

`PORTAL_DYNAMODB_METRICS_SAMPLE_RATE` controla amostragem por Store/invocação:
`0` (padrão) desabilita; `0.01` amostra aproximadamente 1%; `1` coleta todas.
Configurar no ambiente usado para publicar as Lambdas; o `serverless.yml` repassa
essa variável. A coleta pede `ReturnConsumedCapacity=TOTAL` e registra um resumo
`dynamodb.usage` no fim da operação, com chamadas, capacidade retornada pela AWS,
tempo acumulado de chamadas e quantidade de falhas. Não registra chaves, telefone,
texto ou credenciais. O teste unitário valida essa ausência de dados pessoais.

Os totais são os campos retornados pelo SDK; erros podem não informar capacidade
consumida e `elapsedMs` soma chamadas, inclusive paralelas. Não tratar esse tempo
como duração faturada de Lambda, nem somar unidades de leitura/escrita como se
tivessem a mesma tarifa. Confrontar com CloudWatch, duração faturada e billing.
Manter a amostragem baixa reduz o custo dos próprios logs.

Memória de Lambda e batch SQS continuam nos valores anteriores. Precisamos de
medições AWS para reduzir memória sem aumentar duração, ou ampliar lotes sem
prejudicar FIFO/retries. Esta versão não afirma um novo custo em dólares por MAU.

## Validação e limites

- `runtime-records.integration.test.mjs`: Scan proibido no processamento de uma
  mensagem e status, concorrência de status, callback antecipado, paginação,
  isolamento, ticket ativo e migração repetida.
- Suíte de integrações existente: MAU, publicação, troca de fluxo, retry e handoff.
- `Store.list()` permanece disponível para administração/manutenção. Esta mudança
  não elimina todos os Scans de todo o produto.
- A nova estrutura adiciona pequenas escritas, armazenamento e um índice de
  resumos em troca de eliminar leituras proporcionais ao histórico global.
- O custo real deve ser medido na AWS após a implantação; testes locais não medem
  preço, latência de rede AWS ou atraso real de propagação dos GSIs.

Para testes locais isolados, definir `APP_DYNAMODB_ENDPOINT` para a base de teste,
executar `npm run init:local` e habilitar `RUN_DYNAMODB_TESTS=1` ao executar
`node --test`. Nenhum desses testes precisa enviar mensagens à Meta real.
