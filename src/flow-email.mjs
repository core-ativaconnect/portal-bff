import nodemailer from 'nodemailer';
import { lookup } from 'node:dns/promises';
import { publicAddress } from './network.mjs';
import { HttpError } from './command.mjs';

export async function sendFlowEmail(store, contractId, config, render, {createTransport = nodemailer.createTransport, resolve = lookup} = {}) {
  const connection = config.connectionId ? await store.get('contract_email_connections', {id: config.connectionId}) : null;
  if (!connection || connection.contract_id !== contractId || !connection.enabled) throw new HttpError(400, 'Selecione uma conexão de e-mail ativa deste contrato.');
  const addresses = await resolve(connection.host, {all: true});
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new HttpError(400, 'O servidor de e-mail precisa ter endereço público.');
  // Pin the validated address; TLS still verifies the configured hostname.
  const transport = createTransport({host: addresses[0].address, port: connection.port,
    secure: connection.security === 'SSL_TLS', requireTLS: connection.security === 'STARTTLS',
    ignoreTLS: connection.security === 'NONE', tls: {servername: connection.host},
    auth: {user: connection.username, pass: connection.secret},
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 50,
  });
  try {
    const result = await transport.sendMail({from: connection.from_email, to: render(config.to),
      cc: render(config.cc || ''), bcc: render(config.bcc || ''), subject: render(config.subject), text: render(config.body)});
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Recipients rejected');
    return result.messageId;
  } catch { throw new HttpError(502, 'Não foi possível concluir o envio do e-mail. Verifique a conexão e os destinatários.'); }
  finally { transport.close(); }
}
