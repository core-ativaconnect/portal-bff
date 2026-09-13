import {createHash, randomUUID} from 'node:crypto';
import {HttpError} from './command.mjs';
import {must, now, required} from './store.mjs';

export const billingTimezone = 'America/Sao_Paulo';
export function billingDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:billingTimezone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date(date));
  const part = name => parts.find(p => p.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function packageFields(plan) {
  return {package_id:plan.id, package_name:plan.name, max_mau:plan.maxMau, max_user_count:plan.maxUserCount,
    max_flow_count:plan.maxFlowCount, ...(Number.isSafeInteger(plan.maxChannelCount)?{max_channel_count:plan.maxChannelCount}:{}), monthly_price_cents:plan.monthlyPriceCents, billing_currency:'BRL'};
}
export async function selectPackage(store, id, allowArchived = false) {
  const plan = must(await store.get('packages', {id:required(id, 'Pacote', 100)}), 'Pacote não encontrado.');
  if ((!plan.active && !allowArchived) || !Number.isSafeInteger(plan.maxMau)) throw new HttpError(400, 'Pacote indisponível.');
  if(!allowArchived && !Number.isSafeInteger(plan.maxChannelCount))throw new HttpError(400,'Este pacote antigo não define canais. Cadastre um pacote com a franquia de canais.');
  return plan;
}
export async function defaultPackage(store) {
  const selected = await store.get('packages', {id:'DEFAULT'});
  if (!selected) throw new HttpError(503, 'Configure o pacote padrão para novos contratos.');
  return selectPackage(store, selected.packageId);
}
export async function packageOperation(store, operation, body, params) {
  if(params.id==='DEFAULT')throw new HttpError(400,'Pacote inválido.');
  if (operation === 'list') {
    const selected=await store.get('packages',{id:'DEFAULT'});
    return (await store.list('packages', p => p.id !== 'DEFAULT')).map(p=>({...p,isDefault:p.id===selected?.packageId})).sort((a,b) => a.name.localeCompare(b.name));
  }
  if (operation === 'setDefault') {
    const plan = await selectPackage(store, params.id);
    await store.transaction([{ConditionCheck:{TableName:store.table('packages'),Key:{id:plan.id},ConditionExpression:'attribute_exists(id) AND active = :yes',ExpressionAttributeValues:{':yes':true}}},store.putOperation('packages',{id:'DEFAULT',packageId:plan.id})]);
    return plan;
  }
  if(operation==='delete') {
    if(params.id==='DEFAULT')throw new HttpError(400,'Pacote inválido.');
    const plan=must(await store.get('packages',{id:params.id}),'Pacote não encontrado.');
    if((await store.get('packages',{id:'DEFAULT'}))?.packageId===plan.id)throw new HttpError(409,'Defina outro pacote padrão antes de excluir.');
    if((await store.list('contracts',c=>c.package_id===plan.id)).length)throw new HttpError(409,'Este pacote está vinculado a contratos. Altere os vínculos antes de excluir.');
    await store.transaction([{ConditionCheck:{TableName:store.table('packages'),Key:{id:'DEFAULT'},ConditionExpression:'attribute_not_exists(packageId) OR packageId <> :id',ExpressionAttributeValues:{':id':plan.id}}},
      store.deleteOperation('packages',{id:plan.id},'attribute_exists(id) AND (attribute_not_exists(reference_revision) OR reference_revision = :revision)',{':revision':plan.reference_revision??0})]);
    return null;
  }
  if (operation === 'archive') {
    const plan = must(await store.get('packages', {id:params.id}));
    if ((await store.get('packages', {id:'DEFAULT'}))?.packageId === plan.id) throw new HttpError(409, 'Escolha outro pacote padrão antes de arquivar.');
    await store.transaction([{ConditionCheck:{TableName:store.table('packages'),Key:{id:'DEFAULT'},ConditionExpression:'attribute_not_exists(packageId) OR packageId <> :id',ExpressionAttributeValues:{':id':plan.id}}},store.putOperation('packages',{...plan,active:false,updated_at:now()},'attribute_exists(id) AND (attribute_not_exists(reference_revision) OR reference_revision = :revision) AND (attribute_not_exists(updated_at) OR updated_at = :previous)',{':revision':plan.reference_revision??0,':previous':plan.updated_at??''})]);
    return {...plan, active:false};
  }
  const name = required(body.name, 'Nome', 120);
  for (const key of ['maxMau','maxUserCount','maxFlowCount','maxChannelCount','monthlyPriceCents']) {
    if (!Number.isSafeInteger(body[key]) || body[key] < (key === 'maxUserCount' ? 1 : 0)) throw new HttpError(400, `${key} inválido.`);
  }
  const previous=operation==='update'?must(await store.get('packages',{id:params.id}),'Pacote não encontrado.'):null;
  if(params.id==='DEFAULT')throw new HttpError(400,'Pacote inválido.');
  const plan = {...previous,id:previous?.id??randomUUID(), name, maxMau:body.maxMau, maxUserCount:body.maxUserCount,
    maxFlowCount:body.maxFlowCount, maxChannelCount:body.maxChannelCount, monthlyPriceCents:body.monthlyPriceCents, currency:'BRL', active:true, created_at:now(), updated_at:now()};
  if(previous){plan.active=previous.active;plan.created_at=previous.created_at;await store.transaction([store.putOperation('packages',plan,'attribute_exists(id) AND (attribute_not_exists(reference_revision) OR reference_revision = :revision) AND (attribute_not_exists(updated_at) OR updated_at = :previous)',{':revision':previous.reference_revision??0,':previous':previous.updated_at??''})]);}
  else await store.put('packages', plan, {create:true});
  return plan;
}

export function contactIdentity(channel, contact) {
  // Hash the stable external identity; do not store phone numbers in the billing ledger.
  const identity = channel.type === 'WHATSAPP' ? `wa:${contact.wa_id ?? contact.user_id}` : `web:${contact.contact_id}`;
  return createHash('sha256').update(identity).digest('hex');
}
const monthKey = (contractId, month) => `CONTRACT#${contractId}#${month}`;
const counter = (store, pk, sk, additions, extra = {}) => ({Update:{TableName:store.table('billing_usage'), Key:{pk,sk},
  UpdateExpression:`ADD ${Object.keys(additions).map((k,i) => `${k} :v${i}`).join(', ')}`,
  ExpressionAttributeValues:{...Object.fromEntries(Object.values(additions).map((v,i) => [`:v${i}`,v])), ...extra.values},
  ...(extra.condition ? {ConditionExpression:extra.condition} : {})}});

// One transaction reserves the monthly slot and records daily activity. No scan per message.
export async function admitContact(store, contractId, channel, contact, date = new Date()) {
  const day = billingDay(date), month = day.slice(0,7), pk = monthKey(contractId,month), identity = contactIdentity(channel,contact);
  const memberKey = {pk,sk:`USER#${identity}`}, dayKey = {pk,sk:`ACTIVE#${day}#${identity}`};
  for (let attempt = 0; attempt < 15; attempt++) {
    const [contract, member, active] = await Promise.all([store.get('contracts',{id:contractId}),store.get('billing_usage',memberKey),store.get('billing_usage',dayKey)]);
    if (!contract?.package_id || !Number.isSafeInteger(contract.max_mau)) throw new HttpError(403, 'Contrato sem pacote de consumo configurado.');
    if (contract.deletion_in_progress || contract.status !== 'ACTIVE') throw new HttpError(403, 'Contrato indisponível.');
    if (member && active) return {allowed:true, newMau:false};
    if (!member) {
      const total = await store.get('billing_usage',{pk,sk:'TOTAL'});
      if ((total?.mau ?? 0) >= contract.max_mau) return {allowed:false, newMau:false};
    }
    const guard = store.guard(contractId);
    guard.ConditionCheck.ConditionExpression += ' AND package_id = :package AND max_mau = :limit';
    Object.assign(guard.ConditionCheck.ExpressionAttributeValues, {':package':contract.package_id, ':limit':contract.max_mau});
    const operations = [guard];
    if (!member) {
      operations.push(store.putOperation('billing_usage',{...memberKey,first_day:day},'attribute_not_exists(pk)'));
      operations.push(counter(store,pk,'TOTAL',{mau:1},{condition:'attribute_not_exists(mau) OR mau < :limit',values:{':limit':contract.max_mau}}));
    }
    if (!active) operations.push(store.putOperation('billing_usage',dayKey,'attribute_not_exists(pk)'));
    operations.push(counter(store,pk,`DAY#${day}`,{new_mau:member?0:1,active_users:active?0:1}));
    try { await store.transaction(operations); return {allowed:true,newMau:!member}; }
    catch(error) { if (error.status !== 409 && error.name !== 'TransactionCanceledException') throw error; }
  }
  throw new HttpError(503, 'Consumo em atualização. Tente novamente.');
}
export async function usageReport(store, contract, selectedMonth) {
  const currentMonth = billingDay().slice(0,7), month = selectedMonth || currentMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > currentMonth || month < '2020-01') throw new HttpError(400, 'Mês inválido.');
  const pk = monthKey(contract.id,month);
  const [total, days] = await Promise.all([store.get('billing_usage',{pk,sk:'TOTAL'}),store.queryPartition('billing_usage',pk,'DAY#')]);
  const history = await Promise.all(Array.from({length:12},(_,i) => {
    const d = new Date(`${month}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()-i);
    const m = d.toISOString().slice(0,7);
    return store.get('billing_usage',{pk:monthKey(contract.id,m),sk:'TOTAL'}).then(row => ({month:m,mau:row?.mau??0}));
  }));
  let cumulative = 0;
  const daily = Array.from({length:new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate()},(_,i) => {
    const date = `${month}-${String(i+1).padStart(2,'0')}`, row = days.find(d => d.sk === `DAY#${date}`);
    cumulative += row?.new_mau??0;
    return {date,newMau:row?.new_mau??0,activeUsers:row?.active_users??0,cumulativeMau:cumulative};
  });
  const mau=total?.mau??0;
  return {month,timezone:billingTimezone,mau,limit:contract.max_mau??null,remaining:contract.max_mau==null?null:Math.max(0,contract.max_mau-mau),
    packageId:contract.package_id??null,packageName:contract.package_name??null,monthlyPriceCents:contract.monthly_price_cents??null,
    maxUserCount:contract.max_user_count??null,maxFlowCount:contract.max_flow_count??null,maxChannelCount:contract.max_channel_count??null,
    trackingStartedAt:contract.mau_tracking_started_at??null,daily,history};
}
