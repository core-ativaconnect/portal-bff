import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';

test('sampled capacity metrics contain operation totals without item keys or content',async()=>{
  const commands=[];
  const client={send:async command=>{commands.push(command);return {Item:{id:'private-id',text:'private-text'},ConsumedCapacity:{CapacityUnits:1,ReadCapacityUnits:1}};}};
  const store=new Store(client,{prefix:'',collectMetrics:true});
  await store.get('jobs',{id:'private-id'});
  assert.equal(commands[0].input.ReturnConsumedCapacity,'TOTAL');
  assert.equal(store.metrics.readUnits,1);
  const info=console.info;let output;
  try{console.info=value=>{output=value;};store.reportMetrics('meta.status');}finally{console.info=info;}
  assert.equal(JSON.parse(output).calls.GetCommand,1);
  assert.equal(output.includes('private-id'),false);assert.equal(output.includes('private-text'),false);
  const disabled=new Store(client,{prefix:'',collectMetrics:false});
  await disabled.get('jobs',{id:'other'});
  assert.equal(commands[1].input.ReturnConsumedCapacity,undefined);
});
