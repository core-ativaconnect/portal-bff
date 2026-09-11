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
