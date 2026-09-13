import { readFileSync } from 'node:fs';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
const endpoint=process.env.APP_DYNAMODB_ENDPOINT||'http://localhost:8000';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(endpoint).hostname))throw new Error('init:local accepts only a local DynamoDB endpoint');
const client=new DynamoDBClient({endpoint,region:'us-east-1',credentials:{accessKeyId:'local',secretAccessKey:'local'}});
const tables=JSON.parse(readFileSync(new URL('../src/table-definitions.json',import.meta.url),'utf8'));
for(const definition of tables){
  const TableName=definition.TableName.startsWith('flow_engine_')
    ? process.env[`APP_ENGINE_DYNAMODB_${definition.TableName.slice(12).toUpperCase()}_TABLE`]||definition.TableName
    : (process.env.APP_DYNAMODB_TABLE_PREFIX||'')+definition.TableName;
  try{await client.send(new DescribeTableCommand({TableName}));console.log(`Existing: ${TableName}`);}
  catch(error){if(error.name!=='ResourceNotFoundException')throw error;await client.send(new CreateTableCommand({...definition,TableName}));await waitUntilTableExists({client,maxWaitTime:30,minDelay:1},{TableName});console.log(`Created: ${TableName}`);}
}

// Local development only: production packages must be configured by an administrator.
const {DynamoDBDocumentClient,PutCommand,UpdateCommand}=await import('@aws-sdk/lib-dynamodb');
const document=DynamoDBDocumentClient.from(client);
const packageTable=(process.env.APP_DYNAMODB_TABLE_PREFIX||'')+'flow_bff_packages';
for(const item of [{id:'local-development',name:'Desenvolvimento local',maxMau:1000,maxUserCount:10,maxFlowCount:1,maxChannelCount:1,monthlyPriceCents:0,currency:'BRL',active:true}, {id:'DEFAULT',packageId:'local-development'}]) {
  try {await document.send(new PutCommand({TableName:packageTable,Item:item,ConditionExpression:'attribute_not_exists(id)'}));}
  catch(error){if(error.name!=='ConditionalCheckFailedException')throw error;}
}
try {await document.send(new UpdateCommand({TableName:packageTable,Key:{id:'local-development'},UpdateExpression:'SET maxChannelCount = :limit',ExpressionAttributeValues:{':limit':1},ConditionExpression:'attribute_exists(id) AND attribute_not_exists(maxChannelCount)'}));}
catch(error){if(error.name!=='ConditionalCheckFailedException')throw error;}
