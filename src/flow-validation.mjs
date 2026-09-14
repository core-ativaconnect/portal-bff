import { HttpError } from './command.mjs';
import { supportedMessageTypes } from './flow-content.mjs';

const types = new Set(['interaction', 'input', 'router', 'http', 'typescript', 'email', 'flow_swap', 'ai_agent', 'atendimento']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const present = value => typeof value === 'string' && value.trim().length > 0;
const templated = value => typeof value === 'string' && value.includes('{{');

export function validateFlow(document, {channelTypes = []} = {}) {
  const issues = [];
  const issue = (action, field, message) => issues.push({actionId: action?.id ?? null, actionName: action?.name ?? action?.id ?? 'Fluxo', field, message});
  if (!object(document) || !Array.isArray(document.actions) || !document.actions.length) {
    issue(null, 'actions', 'Adicione ao menos uma ação.'); return issues;
  }
  const actions = document.actions, ids = new Set(), graph = new Map();
  const requireField = (action, field, value) => { if (!present(value)) issue(action, field, 'Campo obrigatório.'); };
  const limit = (a, field, value, max) => { if (typeof value === 'string' && !templated(value) && value.length > max) issue(a, field, `Use no máximo ${max} caracteres.`); };
  const url = (a, field, value) => {
    requireField(a, field, value);
    if (present(value) && !templated(value)) {
      try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(); }
      catch { issue(a, field, 'Informe uma URL HTTP ou HTTPS válida.'); }
    }
  };
  for (const a of actions) {
    if (!object(a)) { issue(null, 'actions', 'Ação inválida.'); continue; }
    if (!present(a.id) || ids.has(a.id)) issue(a, 'id', 'Identificador ausente ou duplicado.');
    ids.add(a.id);
  }
  for (const a of actions.filter(object)) {
    const c = object(a.config) ? a.config : {};
    if (!types.has(a.type)) issue(a, 'type', 'Tipo de ação inválido.');
    if (!object(a.config)) issue(a, 'config', 'Configuração inválida.');
    const edges = [];
    const edge = (field, id) => { if (id != null && id !== '') { if (!ids.has(id)) issue(a, field, 'A ação de destino não existe.'); else edges.push(id); } };
    edge('nextActionId', a.nextActionId);
    if (a.type === 'router') {
      if (!Array.isArray(c.routes)) issue(a, 'routes', 'Informe uma lista de rotas.');
      for (const r of Array.isArray(c.routes) ? c.routes : []) {
        if (!object(r)) { issue(a, 'routes', 'Rota inválida.'); continue; }
        edge('routes', r.nextActionId);
        requireField(a, 'routes.userVariable', r.condition?.userVariable);
        if (!['equals', 'notEquals', 'contains', 'notContains', 'regex'].includes(r.condition?.operator)) issue(a, 'routes.operator', 'Operador inválido.');
        if (r.condition?.operator === 'regex') {
          for (const pattern of r.condition.values?.length ? r.condition.values : [r.condition.value ?? '']) {
            try { new RegExp(pattern); } catch { issue(a, 'routes.regex', 'Expressão regular inválida.'); }
          }
        }
      }
    }
    if (a.type === 'ai_agent' && c.directHandoffEnabled) { requireField(a, 'handoffTargetActionId', c.handoffTargetActionId); edge('handoffTargetActionId', c.handoffTargetActionId); }
    if (a.type === 'atendimento') edge('attendantFinishActionId', c.attendantFinishActionId);
    graph.set(a.id, edges);
    if (['interaction', 'input'].includes(a.type)) {
      const t = c.messageType ?? 'text';
      if (!supportedMessageTypes.includes(t)) issue(a, 'messageType', `Formato ${t} ainda indisponível. Escolha um formato suportado.`);
      if (channelTypes.includes('WEBCHAT') && !['text', 'button', 'list'].includes(t)) issue(a, 'messageType', 'Este formato exige WhatsApp; o fluxo está vinculado a um Webchat.');
      if (['text', 'button', 'list', 'cta_url'].includes(t)) requireField(a, 'message', c.message);
      limit(a, 'message', c.message, t === 'text' ? 4096 : 1024);
      limit(a, 'footerText', c.footerText, 60);
      if (t === 'button') {
        const buttons = c.buttonsDynamicSource ? [c.buttonTemplate] : c.buttons;
        if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) issue(a, 'buttons', 'Configure de 1 a 3 botões.');
        for (const b of Array.isArray(buttons) ? buttons : []) { requireField(a, 'buttons.title', b?.title); limit(a, 'buttons.title', b?.title, 20); }
      }
      if (t === 'list') {
        requireField(a, 'listButtonText', c.listButtonText); limit(a, 'listButtonText', c.listButtonText, 20);
        if (!Array.isArray(c.listSections) || !c.listSections.length) issue(a, 'listSections', 'Adicione uma seção à lista.');
        let total = 0;
        for (const s of Array.isArray(c.listSections) ? c.listSections : []) {
          const rows = s?.dynamicSource ? [s.rowTemplate] : s?.rows;
          if (!Array.isArray(rows) || !rows.length) issue(a, 'listSections.rows', 'Adicione uma opção ou configure uma fonte dinâmica.');
          total += Array.isArray(rows) ? rows.length : 0;
          limit(a, 'listSections.title', s?.title, 24);
          for (const r of Array.isArray(rows) ? rows : []) { requireField(a, 'listSections.rows.title', r?.title); limit(a, 'listSections.rows.title', r?.title, 24); limit(a, 'listSections.rows.description', r?.description, 72); }
        }
        if (total > 10) issue(a, 'listSections', 'Uma lista pode ter no máximo 10 opções.');
      }
      if (t === 'cta_url') { requireField(a, 'ctaLabel', c.ctaLabel); limit(a, 'ctaLabel', c.ctaLabel, 20); url(a, 'ctaUrl', c.ctaUrl); }
      if (['image', 'document', 'audio'].includes(t)) {
        if (c.mediaSource === 'id') requireField(a, 'mediaId', c.mediaId); else url(a, 'mediaLink', c.mediaLink);
        limit(a, 'mediaCaption', c.mediaCaption, 1024);
      }
      if (t === 'contacts') {
        if (!Array.isArray(c.contacts) || !c.contacts.length) issue(a, 'contacts', 'Adicione ao menos um contato.');
        for (const contact of Array.isArray(c.contacts) ? c.contacts : []) requireField(a, 'contacts.formattedName', contact?.formattedName);
      }
      if (['button', 'list', 'cta_url'].includes(t) && c.header?.type && c.header.type !== 'none') {
        if (c.header.type === 'text') { requireField(a, 'header.text', c.header.text); limit(a, 'header.text', c.header.text, 60); }
        else if (['image', 'video', 'document'].includes(c.header.type) && t !== 'list') {
          if (c.header.mediaSource === 'id') requireField(a, 'header.mediaId', c.header.mediaId); else url(a, 'header.mediaLink', c.header.mediaLink);
        } else issue(a, 'header', 'Cabeçalho incompatível com este formato.');
      }
      if (a.type === 'input') requireField(a, 'userVariable', c.userVariable);
    }
    if (a.type === 'http') { url(a, 'url', c.url); if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(c.method)) issue(a, 'method', 'Método HTTP inválido.'); }
    if (a.type === 'typescript') requireField(a, 'script', c.script);
    if (a.type === 'email') { for (const key of ['connectionId', 'to', 'subject', 'body']) requireField(a, key, c[key]); }
    if (a.type === 'flow_swap') { requireField(a, 'targetFlowId', c.targetFlowId); requireField(a, 'targetActionId', c.targetActionId); }
    if (a.type === 'ai_agent') requireField(a, 'providerConfigId', c.providerConfigId);
  }
  const roots = actions.filter(object).filter(a => a.systemRole === 'global_router');
  const configuredEntry = actions.find(a => a.id === document.entryActionId && a.systemRole !== 'global_router');
  if (!configuredEntry) issue(null, 'entryActionId', 'Configure o ponto de entrada global com uma ação válida.');
  if (document.testScenarios != null && !Array.isArray(document.testScenarios)) issue(null, 'testScenarios', 'Cenários de teste inválidos.');
  for (const scenario of Array.isArray(document.testScenarios) ? document.testScenarios : []) {
    if (!object(scenario) || !present(scenario.name)) { issue(null, 'testScenarios', 'Cenário de teste sem nome.'); continue; }
    if (!Array.isArray(scenario.inputs) || !scenario.inputs.every(value => typeof value === 'string')) issue(null, 'testScenarios.inputs', `Entradas inválidas no cenário ${scenario.name}.`);
    if (!Array.isArray(scenario.expectedActionIds) || !scenario.expectedActionIds.every(id => ids.has(id))) issue(null, 'testScenarios.expectedActionIds', `Actions esperadas inválidas no cenário ${scenario.name}.`);
    if (scenario.required === true && scenario.lastResult !== 'PASSED') issue(null, 'testScenarios', `Execute e aprove o cenário obrigatório "${scenario.name}" antes de publicar.`);
  }
  const entry = configuredEntry ?? actions.find(a => object(a) && a.systemRole !== 'global_router');
  if (!entry) issue(null, 'actions', 'Adicione uma ação inicial além do roteador global.');
  const seen = new Set(), pending = [...roots.map(a => a.id), ...(entry ? [entry.id] : [])];
  while (pending.length) { const id = pending.pop(); if (seen.has(id)) continue; seen.add(id); pending.push(...(graph.get(id) ?? [])); }
  for (const a of actions.filter(object)) if (!seen.has(a.id)) issue(a, 'connections', 'Esta ação não é alcançável a partir do início ou roteador global.');
  return issues;
}

export async function assertPublishable(store, flow, contractId, {channelTypes} = {}) {
  let document;
  try { document = JSON.parse(flow.definition_json); } catch { document = null; }
  if (!channelTypes) {
    const links = await store.list('contract_channel_flows', link => link.flow_id === flow.id);
    const channels = await Promise.all(links.map(link => store.get('contract_channels', {id: link.channel_id})));
    channelTypes = channels.filter(c => c?.contract_id === contractId).map(c => c.type);
  }
  const issues = validateFlow(document, {channelTypes});
  const add = (a, field, message) => issues.push({actionId: a.id, actionName: a.name ?? a.id, field, message});
  for (const a of Array.isArray(document?.actions) ? document.actions.filter(object) : []) {
    const c = object(a.config) ? a.config : {};
    const check = async (table, id, field) => {
      const item = present(id) ? await store.get(table, {id}) : null;
      if (!item || item.contract_id !== contractId || item.enabled === false) { add(a, field, 'Selecione um recurso ativo deste contrato.'); return null; }
      return item;
    };
    if (a.type === 'ai_agent') await check('contract_ai_provider_configs', c.providerConfigId, 'providerConfigId');
    if (a.type === 'email') await check('contract_email_connections', c.connectionId, 'connectionId');
    if (a.type === 'atendimento') {
      if (c.queueId) await check('contract_help_desk_queues', c.queueId, 'queueId');
      else {
        const queues = await store.query('contract_help_desk_queues', 'contract_key', contractId, {index: 'contract_name-index'});
        if (queues.filter(q => q.enabled).length !== 1) add(a, 'queueId', 'Selecione a fila de atendimento.');
      }
    }
    if (a.type === 'flow_swap') {
      const target = c.targetFlowId === flow.id ? flow : await check('flows', c.targetFlowId, 'targetFlowId');
      let targetDocument;
      if (target === flow) targetDocument = document;
      else if (target?.published_version_id) {
        const version = await store.get('flow_versions', {id: target.published_version_id});
        if (version?.flow_id === target.id && version.is_current && version.status === 'PUBLISHED') { try { targetDocument = JSON.parse(version.definition_json); } catch {} }
      }
      if (!targetDocument?.actions?.some(action => action.id === c.targetActionId)) add(a, 'targetActionId', 'A ação de destino precisa existir na versão publicada do fluxo de destino.');
    }
  }
  if (issues.length) {
    const error = new HttpError(422, `Não foi possível publicar: ${issues.length} problema(s) no fluxo.`);
    error.issues = issues; throw error;
  }
  return document;
}
