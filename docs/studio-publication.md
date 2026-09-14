# Publicação e execução dos blocos do Studio

Implementação local de 14/09/2026. Não implica implantação em produção.

## Publicação

Os comandos `FlowController.publish` e `PlatformController.publishFlow` aceitam `definitionJson` opcional no corpo. Quando informado, o backend valida e publica esse conteúdo em uma transação. Quando omitido, valida e publica a definição salva. O Studio envia uma cópia do conteúdo atual do editor; alterações feitas enquanto a solicitação está em andamento continuam marcadas como não salvas.

Falhas de validação retornam HTTP 422 com `message` e `issues`, uma lista de `{actionId, actionName, field, message}`. O Studio apresenta os problemas em um painel, com acesso ao bloco correspondente. A API verifica estrutura, conexões, ações inalcançáveis, campos principais, formatos de mensagem e referências a recursos ativos do contrato. Não executa scripts, APIs ou IA para verificar seu resultado durante a publicação.

O vínculo a Webchat rejeita formatos avançados exclusivos de WhatsApp na definição publicada. O limite de tamanho e as transações já existentes continuam aplicáveis. Validar referências na publicação não impede que um recurso seja desativado posteriormente; as verificações de execução continuam necessárias.

## Mensagens

Além de texto, botões e listas, o motor gera payloads de imagem, documento, áudio, contatos e CTA URL para WhatsApp. Mídias podem usar URL ou ID da Meta. O histórico conserva o conteúdo estruturado e o tipo de mensagem. Cabeçalhos e rodapés de mensagens interativas passam a integrar o payload correspondente.

Carrossel e solicitação de endereço permanecem indisponíveis: a seleção é desabilitada e fluxos existentes com esses formatos são rejeitados na publicação. Novos formatos de WhatsApp ainda não são renderizados como mídia no simulador/Webchat; o simulador apresenta representação textual. Aprovação e disponibilidade efetiva do conteúdo também dependem da Meta. Valores de variáveis só são conhecidos na execução; a validação de publicação não garante que toda interpolação futura satisfaça os limites do canal.

## E-mail

O bloco usa `connectionId`, referenciando uma conexão ativa cadastrada no mesmo contrato. A interface passa a selecionar essa conexão; ao selecioná-la, remove as antigas credenciais inline da configuração atual do bloco. Versões históricas e arquivos exportados anteriormente não são alterados.

Execução pelo canal envia e-mail por SMTP. Execução pelo simulador registra simulação sem enviar. O servidor SMTP precisa resolver para endereços públicos; a conexão fixa o IP validado e mantém a validação TLS do hostname. A mensagem usa o remetente da conexão, destinatários e conteúdo interpolados do bloco. Acesso a arquivos/URLs por Nodemailer é desabilitado.

Não existe garantia de envio exatamente uma vez: se o SMTP aceitar a mensagem e ocorrer falha antes de persistir o resultado do motor, uma repetição pode reenviar o e-mail. Não foram enviados e-mails reais nem mensagens reais à Meta durante esta validação.

## Desfazer e refazer

O Studio mantém até 50 estados anteriores em memória. Inclusão, exclusão, configuração, conexões, movimentação, importação e exemplos passam pelo histórico. Nova edição descarta a possibilidade de refazer; carregar um fluxo remoto limpa o histórico. Salvar não elimina o histórico.

Atalhos: Ctrl/Cmd+Z para desfazer; Ctrl/Cmd+Shift+Z ou Ctrl/Cmd+Y para refazer. Campos de texto e Monaco preservam seus atalhos próprios. Há botões na barra de ferramentas. Seleções removidas e o caminho da simulação são limpos ao restaurar o estado.

## Validação realizada

- Backend: 41 testes aprovados e um teste Offline ignorado; integração com DynamoDB Local isolado.
- Histórico do editor: três testes aprovados, incluindo restauração de conexões, importação e estado salvo.
- Build de produção do Studio aprovado, com avisos de tamanho e CommonJS já presentes no projeto.
- OpenAPI regenerado e seus quatro testes aprovados.

Base técnica externa: [mensagens WhatsApp, coleção oficial da Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [SMTP no Nodemailer](https://nodemailer.com/smtp).
