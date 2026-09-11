import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, PutCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { config } from './config.mjs';
import { HttpError } from './command.mjs';

export class Store {
  constructor(client, settings = config()) {
    this.settings = settings;
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({
      region: settings.region, endpoint: settings.endpoint,
      ...(settings.local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    }), { marshallOptions: { removeUndefinedValues: true } });
  }
  table(name) {
    if(name.startsWith('engine_'))return process.env[`APP_ENGINE_DYNAMODB_${name.slice(7).toUpperCase()}_TABLE`]||`flow_${name}`;
    return this.settings.prefix + (name.startsWith('flow_bff_') ? name : `flow_bff_${name}`);
  }
  async get(table, key) { return (await this.client.send(new GetCommand({ TableName: this.table(table), Key: key, ConsistentRead: true }))).Item; }
  async list(table, predicate = () => true) {
    const items = []; let cursor;
    do {
      const page = await this.client.send(new ScanCommand({ TableName: this.table(table), ConsistentRead: true, ExclusiveStartKey: cursor }));
      items.push(...(page.Items ?? []).filter(predicate)); cursor = page.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  putOperation(table, item, condition, values) {
    const stored=Object.fromEntries(Object.entries(item).filter(([,value])=>value!==null&&value!==undefined));
    return { Put: { TableName: this.table(table), Item: stored, ...(condition ? { ConditionExpression: condition } : {}), ...(values ? { ExpressionAttributeValues: values } : {}) } };
  }
  deleteOperation(table, key, condition, values) {
    return { Delete: { TableName: this.table(table), Key: key, ...(condition ? { ConditionExpression: condition } : {}), ...(values ? { ExpressionAttributeValues: values } : {}) } };
  }
  guard(contractId) {
    return { ConditionCheck: { TableName: this.table('contracts'), Key: { id: contractId }, ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(deletion_in_progress) OR deletion_in_progress = :no)', ExpressionAttributeValues: { ':no': false } } };
  }
  advanceContract(contract) {
    return { Update: { TableName: this.table('contracts'), Key: {id:contract.id},
      UpdateExpression: 'SET portal_revision = :next',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(deletion_in_progress) OR deletion_in_progress = :no) AND (attribute_not_exists(portal_revision) OR portal_revision = :previous)',
      ExpressionAttributeValues: { ':no':false, ':previous':contract.portal_revision??0, ':next':(contract.portal_revision??0)+1 },
    } };
  }
  async transaction(operations) {
    try { await this.client.send(new TransactWriteCommand({ TransactItems: operations })); }
    catch (error) {
      if (error.name === 'TransactionCanceledException' && error.CancellationReasons?.some(r => r.Code === 'ConditionalCheckFailed')) throw new HttpError(409, 'O registro foi alterado, está em exclusão ou já existe. Atualize e tente novamente.');
      throw error;
    }
  }
  async put(table, item, { create = false, contractId, previous } = {}) {
    const key = table === 'users' ? 'email' : table === 'static_pages' ? 'path' : table === 'blog_posts' ? 'slug' : 'id';
    const condition = create ? 'attribute_not_exists(#key)' : previous?.updated_at ? 'updated_at = :previous' : undefined;
    const op = this.putOperation(table, item, condition, previous?.updated_at && !create ? { ':previous': previous.updated_at } : undefined);
    if(create)op.Put.ExpressionAttributeNames={'#key':key};
    await this.transaction(contractId ? [this.guard(contractId), op] : [op]); return item;
  }
  async delete(table, key, contractId) {
    const op = this.deleteOperation(table, key);
    await this.transaction(contractId ? [this.guard(contractId), op] : [op]);
  }
}

export const now = () => new Date().toISOString();
export const snake = key => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
export const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export const fromItem = item => item && Object.fromEntries(Object.entries(item).map(([k,v]) => [camel(k),v]));
export const pick = (body, keys) => Object.fromEntries(keys.filter(k => body[k] !== undefined).map(k => [k,body[k]]));
export function required(value, name, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name} inválido.`);
  return value.trim();
}
export function email(value) {
  const normalized = required(value, 'Email', 180).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new HttpError(400, 'Email inválido.');
  return normalized;
}
export function must(item, message = 'Registro não encontrado.') { if (!item) throw new HttpError(404, message); return item; }
