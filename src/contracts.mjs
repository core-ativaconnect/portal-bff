import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from './command.mjs';
import { now, must, required, email, snake, fromItem, pick } from './store.mjs';

export const slugify = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function startId(user, cnpj) {
  const bytes = createHash('md5').update(`start:${user}:${cnpj}`).digest();
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function contractBySlug(store, slug, actor) {
  const contract = must((await store.list('contracts', c => c.slug === slug))[0], 'Contrato não encontrado.');
  if (actor.role !== 'OWNER' && !await store.get('contract_access', { id: `${contract.id}#${actor.id}` })) throw new HttpError(404, 'Contrato não encontrado.');
  return contract;
}
export function writable(contract) { if (contract.deletion_in_progress) throw new HttpError(409, 'O contrato está em exclusão.'); }
export async function available(store, slug, ownId) {
  const reserved = await store.get('contracts', { id: `SLUG#${slug}` });
  return (!reserved || reserved.contract_id === ownId) && !(await store.list('contracts', c => c.slug === slug && c.id !== ownId)).length;
}
export async function suggestSlug(store, value) {
  let slug = slugify(required(value, 'Slug', 180)).slice(0,80).replace(/-$/, '');
  if (slug.length < 3) slug = `empresa${slug ? '-' + slug : ''}`;
  const free = await available(store, slug); let suggestion = slug;
  for (let suffix = 2; !await available(store, suggestion); suffix++) suggestion = `${slug.slice(0,70).replace(/-$/, '')}-${suffix > 100 ? randomUUID().slice(0,8) : suffix}`;
  return { slug, available: free, suggestion };
}
function details(body, onboarding) {
  const item = {};
  for (const [field,max] of Object.entries({companyName:180,address:255,neighborhood:120,city:120,contactPhone:20,state:2,zipCode:9,cnpj:14})) item[snake(field)] = required(body[field], field, max);
  item.contact_email = email(body.contactEmail); item.state = item.state.toUpperCase();
  if (!(onboarding ? /^\d{14}$/ : /^(\d{11}|\d{14})$/).test(item.cnpj)) throw new HttpError(400, 'CPF/CNPJ inválido.');
  if (!/^[A-Z]{2}$/.test(item.state)) throw new HttpError(400, 'Estado inválido.');
  if (onboarding && (!/^\d{10,11}$/.test(item.contact_phone) || !/^\d{8}$/.test(item.zip_code))) throw new HttpError(400, 'Telefone ou CEP inválido.');
  return item;
}
function limits(body) {
  for (const field of ['maxFlowCount','maxChannelCount']) if (!Number.isInteger(body[field]) || body[field] < 0) throw new HttpError(400, `${field} inválido.`);
  for (const field of ['startDate','endDate']) if (typeof body[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body[field]) || !Number.isFinite(Date.parse(body[field])) || new Date(body[field]).toISOString().slice(0,10) !== body[field]) throw new HttpError(400, `${field} inválido.`);
  if (body.endDate < body.startDate) throw new HttpError(400, 'A data final deve ser posterior à inicial.');
  return Object.fromEntries(['startDate','endDate','maxFlowCount','maxChannelCount'].map(k => [snake(k),body[k]]));
}
export function accessItem(contractId, userId) {
  const timestamp = now();
  return { id: `${contractId}#${userId}`, contract_id: contractId, user_id: userId, added_at: timestamp, contract_key: contractId, user_key: userId, added_at_sort: `${timestamp}#${contractId}#${userId}` };
}
export async function saveContract(store, item, previous, userId) {
  item = { ...item, updated_at: now(), all_key: 'ALL', company_name_sort: `${item.company_name.toLowerCase()}#${item.id}`, slug_key: item.slug };
  if (!await available(store,item.slug,item.id)) throw new HttpError(409, 'Este slug já está em uso.');
  const operations = [
    store.putOperation('contracts', item, previous ? 'updated_at = :previous AND (attribute_not_exists(deletion_in_progress) OR deletion_in_progress = :no) AND (attribute_not_exists(portal_revision) OR portal_revision = :revision)' : 'attribute_not_exists(id)', previous ? { ':previous': previous.updated_at, ':no':false, ':revision':previous.portal_revision??0 } : undefined),
    store.putOperation('contracts', { id: `SLUG#${item.slug}`, contract_id: item.id }, 'attribute_not_exists(id) OR contract_id = :id', { ':id': item.id }),
  ];
  if (previous && previous.slug !== item.slug) operations.push(store.deleteOperation('contracts',{id:`SLUG#${previous.slug}`}, 'attribute_not_exists(id) OR contract_id = :id', {':id':item.id}));
  if (userId && !await store.get('contract_access', {id:`${item.id}#${userId}`})) operations.push(store.putOperation('contract_access', accessItem(item.id,userId), 'attribute_not_exists(id)'));
  await store.transaction(operations); return item;
}
export async function onboarding(store, body, actor) {
  const fields = details(body, true); const id = startId(actor.id, fields.cnpj);
  const existing = await store.get('contracts',{id});
  if (existing) { writable(existing); return {id,slug:existing.slug}; }
  const slug = body.slug ?? (await suggestSlug(store, fields.company_name)).suggestion;
  if (typeof slug !== 'string' || slug.length < 3 || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400,'Slug inválido.');
  const start = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const days = Number(process.env.APP_ONBOARDING_DURATION_DAYS || 30);
  const policy = {startDate:start,endDate:new Date(Date.parse(start)+days*86400000).toISOString().slice(0,10),maxFlowCount:Number(process.env.APP_ONBOARDING_MAX_FLOWS ?? 1),maxChannelCount:Number(process.env.APP_ONBOARDING_MAX_CHANNELS ?? 1)};
  if (!Number.isInteger(days) || days < 1) throw new Error('Invalid onboarding duration');
  try { await saveContract(store,{id,...fields,...limits(policy),slug,status:'ACTIVE',registration_source:'ONBOARDING',created_at:now()},null,actor.id); }
  catch(error) { const committed = await store.get('contracts',{id}); if (!committed) throw error; writable(committed); return {id,slug:committed.slug}; }
  return {id,slug};
}
export async function accessUsers(store, contractId) {
  const users = await store.list('users');
  return (await store.list('contract_access', a => a.contract_id === contractId)).sort((a,b)=>a.added_at.localeCompare(b.added_at)).map(a => {
    const u = users.find(u => u.id === a.user_id);
    return u && { userId:u.id, name:u.name, email:u.email, active:u.active, addedAt:a.added_at };
  }).filter(Boolean);
}
export async function contractOperation(store, operation, body, params) {
  if (operation === 'create') {
    const fields = details(body, false); const slug = (await suggestSlug(store, fields.company_name)).suggestion;
    const user = await store.get('users',{email:fields.contact_email});
    return saveContract(store,{id:randomUUID(),...fields,...limits(body),slug,status:'ACTIVE',registration_source:'ADMIN',created_at:now()},null,user?.id);
  }
  const contract = must(await store.get('contracts',{id:params.id}),'Contrato não encontrado.'); writable(contract);
  if (operation === 'listAccessUsers') return accessUsers(store,contract.id);
  if (operation === 'addAccessUser') {
    const user = must(await store.get('users',{email:email(body.email)}),'Usuário não encontrado.');
    await store.put('contract_access',accessItem(contract.id,user.id),{create:true,contractId:contract.id});
    return (await accessUsers(store,contract.id)).find(u => u.userId === user.id);
  }
  if (operation === 'removeAccessUser') { await store.delete('contract_access',{id:`${contract.id}#${params.userId}`},contract.id); return null; }
  let changed = {...contract};
  if (operation === 'update') changed = {...changed,...details(body,false),...limits(body)};
  else if (operation === 'updateSlug') { changed.slug = slugify(required(body.slug,'Slug',80)); if (!changed.slug) throw new HttpError(400,'Slug inválido.'); }
  else if (operation === 'block' || operation === 'unblock') changed.status = operation === 'block' ? 'BLOCKED' : 'ACTIVE';
  else throw new Error(`Unknown contract operation ${operation}`);
  const user = await store.get('users',{email:changed.contact_email});
  return saveContract(store,changed,contract,user?.id);
}

export function contractFields(contract) {
  return { ...pick(fromItem(contract),['id','companyName','slug','cnpj','contactEmail','contactPhone','address','neighborhood','city','state','zipCode','startDate','endDate','maxFlowCount','maxChannelCount','status','createdAt','updatedAt']),registrationSource:contract.registration_source ?? 'UNKNOWN',deletionInProgress:contract.deletion_in_progress ?? false };
}
