import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError } from './command.mjs';
import { now, required, email, must } from './store.mjs';

export function profile(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.created_at };
}
function signingKey(settings) {
  const secret = settings.secret;
  const key = /^[A-Za-z0-9+/]*={0,2}$/.test(secret) ? Buffer.from(secret, 'base64') : Buffer.from(secret);
  if (key.length < 32) throw new Error('APP_JWT_SECRET must contain at least 32 decoded bytes');
  return key;
}
async function session(store, user) {
  const key = signingKey(store.settings);
  const algorithm = key.length >= 64 ? 'HS512' : key.length >= 48 ? 'HS384' : 'HS256';
  const accessToken = await new SignJWT({ role: user.role, name: user.name }).setProtectedHeader({ alg: algorithm })
    .setSubject(user.email).setIssuedAt().setExpirationTime(Math.floor((Date.now() + store.settings.expiration) / 1000)).sign(key);
  return { accessToken, tokenType: 'Bearer', subject: user.email, user: profile(user) };
}
export async function authenticate(store, headers = {}) {
  const header = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (!/^Bearer \S+$/i.test(header ?? '')) throw new HttpError(401, 'Autenticação necessária.');
  let subject;
  try { subject = (await jwtVerify(header.split(' ')[1], signingKey(store.settings), { algorithms: ['HS256', 'HS384', 'HS512'], requiredClaims: ['exp', 'sub'] })).payload.sub; }
  catch { throw new HttpError(401, 'Token inválido ou expirado.'); }
  const user = await store.get('users', { email: subject.toLowerCase() });
  if (!user?.active) throw new HttpError(401, 'Usuário inexistente ou inativo.');
  return user;
}
export async function authOperation(store, operation, body, actor) {
  if (operation === 'currentUser') return profile(actor);
  const address = email(body.email);
  if (operation === 'login') {
    const password = required(body.password, 'Senha', 120);
    const user = await store.get('users', { email: address });
    if (!user?.active || !await bcrypt.compare(password, user.password_hash)) throw new HttpError(401, 'Email ou senha inválidos.');
    return session(store, user);
  }
  const name = required(body.name, 'Nome', 120);
  const password = required(body.password, 'Senha', 120);
  if (password.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (await store.get('users', { email: address })) throw new HttpError(409, 'Email já cadastrado.');
  const id = randomUUID(); const timestamp = now();
  // Public signup cannot choose a role. Initial ownership must be configured by the operator.
  const role = 'USER';
  const user = { id, id_key: id, email: address, name, password_hash: await bcrypt.hash(password, 10), role, active: true,
    created_at: timestamp, updated_at: timestamp, active_key: 'ACTIVE', role_key: role, name_sort: `${name.toLowerCase()}#${id}`, all_users_key: 'ALL' };
  await store.put('users', user, { create: true }); return session(store, user);
}

export async function userOperation(store, operation, body, params, actor) {
  if (['list', 'active', 'pending'].includes(operation)) {
    return (await store.list('users', u => !!u.id && (operation === 'list' || u.active === (operation === 'active')))).sort((a,b) => a.name.localeCompare(b.name)).map(profile);
  }
  const user = must((await store.list('users', u => u.id === params.id))[0], 'Usuário não encontrado.');
  if (['delete','updateRole','updateStatus'].includes(operation) && user.id === actor.id) throw new HttpError(400, 'Você não pode alterar ou excluir o próprio usuário.');
  if (operation === 'updateRole' && !['OWNER', 'USER'].includes(body.role)) throw new HttpError(400, 'Perfil inválido.');
  if (operation === 'updateStatus' && typeof body.active !== 'boolean') throw new HttpError(400, 'Status inválido.');
  const removesOwner = user.role === 'OWNER' && (operation === 'delete' || operation === 'updateRole' && body.role !== 'OWNER' || operation === 'updateStatus' && !body.active);
  if (removesOwner && (await store.list('users', u => u.role === 'OWNER' && u.active)).length <= 1) throw new HttpError(400, 'Não é possível remover o último administrador ativo.');
  if (operation === 'delete') { await store.delete('users', { email: user.email }); return null; }
  const updated = { ...user, updated_at: now() };
  if (operation === 'updateRole') updated.role = updated.role_key = body.role;
  else { updated.active = operation === 'activate' ? true : body.active; updated.active_key = updated.active ? 'ACTIVE' : 'INACTIVE'; }
  await store.put('users', updated, { previous: user }); return profile(updated);
}
