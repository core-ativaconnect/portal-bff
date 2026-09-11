import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { authOperation, authenticate } from '../src/auth.mjs';
import { onboarding, suggestSlug } from '../src/contracts.mjs';

test('DynamoDB local: signup, login, duplicate email, token and atomic onboarding', {skip:process.env.RUN_DYNAMODB_TESTS!=='1'}, async()=>{
  const store=new Store();assert.equal(store.settings.local,true);assert.match(store.settings.endpoint,/localhost|127\.0\.0\.1/);
  const suffix=randomUUID(),email=`portal-test-${suffix}@example.com`;
  const payload={name:'Portal integration test',email,password:'test-password-123'};
  let user,company;
  try{
    const session=await authOperation(store,'register',payload);user=session.user;
    assert.equal(user.role,'USER');assert.equal(user.passwordHash,undefined);
    assert.equal((await authOperation(store,'login',payload)).user.id,user.id);
    await assert.rejects(authOperation(store,'register',payload),e=>e.status===409);
    await assert.rejects(authOperation(store,'login',{...payload,password:'incorrect'}),e=>e.status===401);
    const actor=await authenticate(store,{Authorization:`Bearer ${session.accessToken}`});assert.equal(actor.id,user.id);
    await assert.rejects(authenticate(store,{Authorization:`Bearer ${session.accessToken}invalid`}),e=>e.status===401);
    const data={companyName:'Portal Test',cnpj:'40432544000147',contactEmail:email,contactPhone:'1143134620',zipCode:'04709110',address:'Rua teste, 1',neighborhood:'Centro',city:'São Paulo',state:'SP',slug:`portal-test-${suffix}`};
    company=await onboarding(store,data,actor);
    assert.deepEqual(await onboarding(store,data,actor),company);
    assert.ok(await store.get('contract_access',{id:`${company.id}#${user.id}`}));
    const stored=await store.get('contracts',{id:company.id});assert.equal(stored.registration_source,'ONBOARDING');assert.equal(stored.max_flow_count,1);
    assert.equal((await suggestSlug(store,company.slug)).available,false);
  }finally{
    if(company){await store.delete('contract_access',{id:`${company.id}#${user.id}`});await store.delete('contracts',{id:`SLUG#${company.slug}`});await store.delete('contracts',{id:company.id});}
    if(user)await store.delete('users',{email});
  }
});
