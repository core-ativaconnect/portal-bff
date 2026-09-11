import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, now } from '../src/store.mjs';
import { authOperation } from '../src/auth.mjs';
import { onboarding } from '../src/contracts.mjs';
import { deleteContract } from '../src/deletion.mjs';
import { enqueue, jobStatus, runJob } from '../src/jobs.mjs';
import { parseCommand } from '../src/command.mjs';
import { resolveRoute } from '../src/router.mjs';
test('background deletion is private, durable and claimed once', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'},async()=>{
  const store=new Store();assert.equal(store.settings.local,true);const email=`job-${randomUUID()}@example.com`;let user,contract,jobId;
  try{
    const auth=await authOperation(store,'register',{name:'Jobs test',email,password:'password-123'});user=await store.get('users',{email});user={...user,role:'OWNER',role_key:'OWNER',updated_at:now()};await store.put('users',user);
    const headers={authorization:`Bearer ${auth.accessToken}`};
    contract=await onboarding(store,{companyName:'Jobs test',cnpj:'40432544000147',contactEmail:email,contactPhone:'1143134620',zipCode:'04709110',address:'Rua 1',neighborhood:'Centro',city:'São Paulo',state:'SP',slug:`job-${randomUUID()}`},user);
    const command=parseCommand({path:`/api/v1/contracts/${contract.id}?confirmation=${contract.slug}`,method:'DELETE'});let payload;
    const queued=await enqueue(resolveRoute(command),command,headers,store,async event=>{payload=event;});jobId=JSON.parse(queued.body).jobId;
    assert.equal(queued.statusCode,202);assert.equal((await jobStatus(jobId,headers,store)).statusCode,202);
    await assert.rejects(jobStatus(jobId,{},store),e=>e.status===401);
    await Promise.all([runJob(payload,store),runJob(payload,store)]);
    assert.equal((await jobStatus(jobId,headers,store)).statusCode,204);assert.equal(await store.get('contracts',{id:contract.id}),undefined);
  }finally{if(contract)await deleteContract(store,contract.id,contract.slug);if(jobId)await store.delete('jobs',{id:jobId});if(user)await store.delete('users',{email});}
});
