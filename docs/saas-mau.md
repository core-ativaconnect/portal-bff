# Pacotes e consumo de MAU

Cada contrato tem um pacote com `maxMau`, `maxUserCount`, `maxFlowCount` e
`maxChannelCount` e `monthlyPriceCents` (BRL). A vigência permanece no contrato.
O limite de canais também é definido pelo pacote e aparece no painel de consumo.
Pacotes antigos sem esse campo mantêm os limites dos contratos já vinculados,
mas não podem ser atribuídos a novos contratos nem definidos como padrão.
Cadastre um pacote com a franquia de canais e reassocie os contratos desejados.
Os usuários da plataforma são vínculos de acesso ao contrato, inclusive vínculos
inativos; não são os contatos finais contabilizados como MAU. Um OWNER global
sem vínculo não ocupa uma vaga no contrato.

## Regra de consumo

- Período: mês calendário em `America/Sao_Paulo`; reinício no primeiro dia às 00h.
- WhatsApp: primeiro recebimento de mensagem do telefone no contrato naquele mês.
  O mesmo telefone em dois canais do mesmo contrato ocupa uma única vaga.
- Webchat: abertura de conversa (`connect`) ou mensagem com a identidade
  persistida. Reconexões com o mesmo token não duplicam MAU. Limpar a sessão ou
  trocar de navegador pode gerar outro contato; não existe identificação global
  da pessoa entre WhatsApp e chat web.
- Uma resposta manual do Desk ou retomada do fluxo por encerramento também
  ativa o contato no mês. Isso impede tickets de meses anteriores de contornarem
  o limite. Requisições inválidas, status da Meta, ping, poll e simulador não
  consomem MAU.
- Contatos já admitidos no mês continuam atendidos mesmo quando a franquia
  termina ou um downgrade reduz o limite abaixo do consumo atual.
- Novos contatos no limite: Meta confirma/processa o evento sem executar o
  fluxo e sem enviar resposta; registra `blocked_reason=MAU_LIMIT` no job. Chat
  retorna um envelope sem mensagens, com `unavailable=true`. O Desk retorna 403.
- Erros de infraestrutura não são tratados como autorização para ultrapassar
  a franquia. Retries de uma entrega Meta usam a data de criação de seu job.
- A medição começa na ativação do pacote. Não é inventado histórico anterior.
  A exclusão definitiva do contrato também exclui seus registros de consumo.

`billing_usage` usa uma partição por contrato/mês, com registro único de contato,
contador mensal e registros diários. Uma transação DynamoDB reserva a vaga com
condição de limite e atualiza os contadores de forma indivisível. O dashboard
consulta apenas os agregados, sem varrer o histórico de contatos.

O painel diferencia **novos MAUs por dia**, **contatos ativos no dia** e **MAU
acumulado**. Somar os ativos diários não equivale ao MAU mensal. O histórico
mostra 12 meses anteriores ao mês selecionado; a seleção permite consultar
outros meses. Os limites/preço exibidos são os do pacote atual, não uma fatura
histórica. Ainda não há cobrança automática, impostos, pró-rata ou excedentes.

## Administração e navegação

- Flow Studio: `/admin/packages` cria pacotes, define o padrão de onboarding e
  arquiva ofertas. A edição atualiza a oferta para novos vínculos; os contratos existentes
  preservam as condições contratadas, inclusive ao editar outros dados do contrato.
  A exclusão exige que o pacote não seja padrão e não tenha contratos vinculados. Arquivar não altera contratos existentes.
- Cadastro/edição de contrato: selecione o pacote. O backend deriva os limites;
  `maxFlowCount` enviado diretamente pelo cliente não altera a franquia.
- Dashboard do contrato: cartão **MAU e pacote** → `/plataform/:slug/consumo`.
  Disponível somente para OWNER ou usuário com acesso ao contrato.
- Uma troca de pacote preserva o MAU consumido. Não é permitido escolher um
  pacote menor que os fluxos, canais ou vínculos de usuários já existentes.
- Novos contratos do onboarding recebem o pacote padrão. Sem padrão configurado,
  o cadastro retorna 503 com instrução de configuração.

Operações lógicas pelo transporte `POST /commands`, também documentadas no Swagger:

| Método lógico | Caminho | Acesso |
| --- | --- | --- |
| GET / POST | `/api/v1/packages` | OWNER |
| PUT / DELETE | `/api/v1/packages/{id}` | OWNER |
| POST | `/api/v1/packages/{id}/default` | OWNER |
| POST | `/api/v1/packages/{id}/archive` | OWNER |
| GET | `/api/v1/platform/contracts/{contractSlug}/usage?month=YYYY-MM` | Acesso ao contrato |

## Ativação em produção

**Não publique o backend com os contratos antigos sem pacote:** seus canais
ficarão indisponíveis até a configuração. Prepare os dados primeiro.

1. Atualize a stack de dados com `infra/dynamodb-data.yml`. Ela adiciona
   `${TablePrefix}flow_bff_packages` e `${TablePrefix}flow_bff_billing_usage`,
   com retenção e recuperação pontual. A role de runtime já cobre o prefixo.
2. Configure o ambiente do operador para as tabelas corretas, incluindo
   `APP_STAGE=prd`, `APP_DYNAMODB_TABLE_PREFIX=prd_`, `AWS_REGION=us-east-1` e
   `APP_JWT_SECRET`; não configure endpoint local em produção. Use credenciais
   com acesso às tabelas. Nenhuma credencial deve ser salva no repositório.
3. Defina comercialmente a franquia de MAU, usuários e preço dos contratos
   legados. Execute a previsão (os números abaixo são só exemplo):

   ```sh
   node scripts/migrate-packages.mjs --max-mau 1000 --max-users 10 --price-cents 19900
   ```

4. Revise os contratos e execute o mesmo comando com `--apply` para aplicar.
   O script preserva os limites de fluxos e canais existentes, mantém a vigência e
   associa pacotes por combinação de limites. Recusa limites menores que os
   usuários vinculados e contratos com limite de fluxos indefinido. Ele aplica
   a mesma franquia de MAU/usuários/preço aos contratos ainda não migrados;
   para condições comerciais distintas, use o seletor `--contract-id ID`.
   Reexecutar não altera os contratos já migrados.
5. Publique o backend e o Flow Studio. Crie/defina em `/admin/packages` o pacote
   padrão desejado para onboarding antes de liberar novos cadastros.
6. Valide um contrato de teste com franquia pequena: contatos distintos até o
   limite, contato excedente sem resposta, recorrente ainda atendido, painel
   diário/mensal e isolamento entre contratos. Publique primeiro em homologação.

`npm run init:local` cria somente no DynamoDB local o pacote de desenvolvimento
com 1.000 MAUs, 10 usuários, 1 fluxo, 1 canal e preço zero. Não use isso como oferta comercial.
