import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, QueryCommand, PutCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { config } from './config.mjs';
import { HttpError } from './command.mjs';

export class Store {
  constructor(client, settings = config()) {
    this.settings = settings;
    this.metrics={calls:{},readUnits:0,writeUnits:0,capacityUnits:0,elapsedMs:0,failures:0};
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({
      region: settings.region, endpoint: settings.endpoint,
      ...(settings.local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    }), { marshallOptions: { removeUndefinedValues: true } });
  }
  async send(command){
    if(!this.settings.collectMetrics)return this.client.send(command);
    command.input.ReturnConsumedCapacity='TOTAL';
    const start=Date.now(),operation=command.constructor.name;
    this.metrics.calls[operation]=(this.metrics.calls[operation]??0)+1;
    try{
      const result=await this.client.send(command);
      const values=Array.isArray(result.ConsumedCapacity)?result.ConsumedCapacity:[result.ConsumedCapacity];
      for(const value of values){this.metrics.readUnits+=value?.ReadCapacityUnits??0;this.metrics.writeUnits+=value?.WriteCapacityUnits??0;this.metrics.capacityUnits+=value?.CapacityUnits??0;}
      return result;
    }catch(error){this.metrics.failures++;throw error;}
    finally{this.metrics.elapsedMs+=Date.now()-start;}
  }
  reportMetrics(operation){
    if(this.settings.collectMetrics)console.info(JSON.stringify({event:'dynamodb.usage',operation,...this.metrics}));
  }
  table(name) {
    if(name.startsWith('engine_'))return process.env[`APP_ENGINE_DYNAMODB_${name.slice(7).toUpperCase()}_TABLE`]||`flow_${name}`;
    return this.settings.prefix + (name.startsWith('flow_bff_') ? name : `flow_bff_${name}`);
  }
  async get(table, key) { return (await this.send(new GetCommand({ TableName: this.table(table), Key: key, ConsistentRead: true }))).Item; }
  async queryPage(table, partition, value, {index, sort, prefix, from, to, after, limit=50, forward=true} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400,'Invalid page size.');
    const names={'#pk':partition}, values={':pk':value};
    let expression='#pk = :pk';
    if(sort && prefix !== undefined){names['#sk']=sort;values[':prefix']=prefix;expression+=' AND begins_with(#sk, :prefix)';}
    if(sort&&from!==undefined&&to!==undefined){names['#sk']=sort;values[':from']=from;values[':to']=to;expression+=' AND #sk BETWEEN :from AND :to';}
    const page=await this.send(new QueryCommand({TableName:this.table(table),IndexName:index,
      ConsistentRead:!index,KeyConditionExpression:expression,ExpressionAttributeNames:names,ExpressionAttributeValues:values,
      ExclusiveStartKey:after,Limit:limit,ScanIndexForward:forward}));
    return {items:page.Items??[],nextKey:page.LastEvaluatedKey};
  }
  async query(table, partition, value, options={}) {
    const items=[];let after;
    do{const page=await this.queryPage(table,partition,value,{...options,after});items.push(...page.items);after=page.nextKey;}while(after);
    return items;
  }
  async queryPartition(table, pk, prefix) {
    const items=[];let cursor;
    do {
      const page=await this.send(new QueryCommand({TableName:this.table(table),ConsistentRead:true,
        KeyConditionExpression:'pk = :pk AND begins_with(sk, :prefix)',ExpressionAttributeValues:{':pk':pk,':prefix':prefix},ExclusiveStartKey:cursor}));
      items.push(...(page.Items??[]));cursor=page.LastEvaluatedKey;
    } while(cursor);
    return items;
  }
  async list(table, predicate = () => true) {
    const items = []; let cursor;
    do {
      const page = await this.send(new ScanCommand({ TableName: this.table(table), ConsistentRead: true, ExclusiveStartKey: cursor }));
      items.push(...(page.Items ?? []).filter(predicate)); cursor = page.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async *scanPages(table){
    let cursor;
    do{const page=await this.send(new ScanCommand({TableName:this.table(table),ConsistentRead:true,ExclusiveStartKey:cursor}));yield page.Items??[];cursor=page.LastEvaluatedKey;}while(cursor);
  }
  putOperation(table, item, condition, values) {
    item=indexedItem(table,item);
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
    try { await this.send(new TransactWriteCommand({ TransactItems: operations })); }
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

// Keep the attributes used by runtime queries populated on every new write.
// The migration applies the same rules to records written by older versions.
export function indexedItem(table,item){
  const row={...item};
  if(table==='whatsapp_wabas'&&row.waba_id)row.waba_id_key=row.waba_id.toLowerCase();
  if(table==='whatsapp_apps'&&row.verify_token)row.verify_token_key=row.verify_token.toLowerCase();
  if(table==='whatsapp_phone_numbers'&&row.meta_phone_number_id)row.meta_phone_key=row.meta_phone_number_id;
  if(table==='contract_channels'){
    if(row.whatsapp_phone_number_id)row.phone_key=row.whatsapp_phone_number_id;else delete row.phone_key;
    if(row.contract_id){row.contract_key=row.contract_id;row.name_sort=`${(row.name??'').toLowerCase()}#${row.id}`;}
    if(row.webchat_agent_name)row.webchat_agent_key=row.webchat_agent_name.toLowerCase();
  }
  if(table==='contract_channel_flows'&&row.channel_id){row.channel_key=row.channel_id;row.created_at_sort=`${row.created_at??''}#${row.id}`;}
  if(table==='contract_help_desk_queues'&&row.contract_id){row.contract_key=row.contract_id;row.name_sort=`${(row.name??'').toLowerCase()}#${row.id}`;}
  if(table==='flow_versions'&&row.flow_id){row.flow_key=row.flow_id;row.version_sort=String(row.version_number??0).padStart(9,'0');}
  return row;
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
