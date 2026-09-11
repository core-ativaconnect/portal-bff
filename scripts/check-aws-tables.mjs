import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { readFile } from 'node:fs/promises';

const region = process.env.AWS_REGION || 'us-east-1';
const prefix = process.env.APP_DYNAMODB_TABLE_PREFIX || '';
const definitions = JSON.parse(
  await readFile(new URL('../src/table-definitions.json', import.meta.url), 'utf8'),
);

const engineOverrides = {
  flow_engine_sessions: process.env.APP_ENGINE_DYNAMODB_SESSIONS_TABLE,
  flow_engine_contacts: process.env.APP_ENGINE_DYNAMODB_CONTACTS_TABLE,
  flow_engine_messages: process.env.APP_ENGINE_DYNAMODB_MESSAGES_TABLE,
};

function deployedTableName(name) {
  if (name.startsWith('flow_engine_')) return engineOverrides[name] || name;
  return `${prefix}${name}`;
}

const tableNames = [...new Set(definitions.map(({ TableName }) => deployedTableName(TableName)))];
const client = new DynamoDBClient({ region });
const found = [];
const missing = [];
const errors = [];

for (const TableName of tableNames) {
  try {
    const result = await client.send(new DescribeTableCommand({ TableName }));
    found.push({ name: TableName, status: result.Table?.TableStatus || 'UNKNOWN' });
  } catch (error) {
    if (error?.name === 'ResourceNotFoundException') {
      missing.push(TableName);
    } else {
      errors.push({ name: TableName, error: `${error?.name || 'Error'}: ${error?.message || error}` });
    }
  }
}

console.log(`Regiao: ${region}`);
console.log(`Tabelas esperadas: ${tableNames.length}`);
console.log(`Tabelas encontradas: ${found.length}`);
for (const table of found) console.log(`  OK      ${table.name} (${table.status})`);

if (missing.length) {
  console.error(`\nTabelas ausentes: ${missing.length}`);
  for (const name of missing) console.error(`  MISSING ${name}`);
}

if (errors.length) {
  console.error(`\nErros ao consultar DynamoDB: ${errors.length}`);
  for (const item of errors) console.error(`  ERROR   ${item.name} - ${item.error}`);
}

if (missing.length || errors.length) process.exitCode = 1;
