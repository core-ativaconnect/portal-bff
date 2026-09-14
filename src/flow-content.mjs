import { HttpError } from './command.mjs';

export const supportedMessageTypes = ['text', 'button', 'list', 'cta_url', 'image', 'document', 'audio', 'contacts'];

// Only server-rendered flow configuration reaches this function, never a raw
// Graph payload supplied by a transport caller.
export function richMessage(config, render) {
  const type = config.messageType ?? 'text';
  if (!supportedMessageTypes.includes(type)) throw new HttpError(400, `Formato ${type} ainda indisponível para envio.`);
  const media = (source, link, id) => source === 'id' ? {id: render(id)} : {link: render(link)};
  if (['image', 'document', 'audio'].includes(type)) {
    const content = media(config.mediaSource, config.mediaLink, config.mediaId);
    if (type !== 'audio' && config.mediaCaption) content.caption = render(config.mediaCaption);
    if (type === 'document' && config.documentFilename) content.filename = render(config.documentFilename);
    if (type === 'audio' && config.audioIsVoice) content.voice = true;
    return {type, [type]: content};
  }
  if (type === 'contacts') return {type, contacts: (config.contacts ?? []).map(contact => ({
    name: {formatted_name: render(contact.formattedName), first_name: render(contact.firstName || contact.formattedName), ...(contact.lastName ? {last_name: render(contact.lastName)} : {})},
    ...(contact.phone ? {phones: [{phone: render(contact.phone), type: 'CELL'}]} : {}),
    ...(contact.email ? {emails: [{email: render(contact.email), type: 'WORK'}]} : {}),
    ...(contact.company ? {org: {company: render(contact.company)}} : {}),
  }))};
  if (type === 'cta_url') return {type: 'interactive', interactive: {
    type: 'cta_url', body: {text: render(config.message)},
    action: {name: 'cta_url', parameters: {display_text: render(config.ctaLabel), url: render(config.ctaUrl)}},
  }};
  return null;
}

export function decorateInteractive(payload, config, render) {
  if (payload?.type !== 'interactive') return payload;
  const header = config.header;
  if (header?.type === 'text') payload.interactive.header = {type: 'text', text: render(header.text)};
  else if (['image', 'video', 'document'].includes(header?.type)) payload.interactive.header = {
    type: header.type, [header.type]: header.mediaSource === 'id' ? {id: render(header.mediaId)} : {link: render(header.mediaLink)},
  };
  if (config.footerText) payload.interactive.footer = {text: render(config.footerText)};
  return payload;
}
