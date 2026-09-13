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
Não há TTL nessas referências: devem acompanhar a retenção do histórico.

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
continuam compatíveis; não percorrem a tabela global de mensagens, mas ainda podem
ler a conversa inteira. Paginação incremental desses protocolos é trabalho futuro.

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
