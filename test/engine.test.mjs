import test from 'node:test';
import assert from 'node:assert/strict';
import { executeScript } from '../src/scripts.mjs';
import { setVariable, variable, interpolate } from '../src/engine.mjs';
import { publicAddress } from '../src/network.mjs';
test('scripts are isolated and bounded',async()=>{
  const result=await executeScript('const name: string = user.name; user.greeting = "Olá " + name; console.log(user.greeting);',{name:'Maria'});
  assert.equal(result.ok,true);assert.equal(result.user.greeting,'Olá Maria');
  const escape=await executeScript('user.secret = typeof process; user.fs = typeof require;',{});assert.equal(escape.user.secret,'undefined');assert.equal(escape.user.fs,'undefined');
  assert.equal((await executeScript('while(true) {}',{})).ok,false);
});
test('variables cannot mutate prototypes',()=>{
  const state={};setVariable(state,'user.person.name','Maria');assert.equal(variable(state,'user.person.name'),'Maria');assert.equal(interpolate('Olá {{ user.person.name }}',state),'Olá Maria');
  assert.throws(()=>setVariable(state,'__proto__.polluted',true));assert.equal({}.polluted,undefined);
});
test('external integrations reject internal addresses',()=>{
  for(const address of ['127.0.0.1','169.254.169.254','10.0.0.1','172.16.0.1','192.168.0.1','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(address),false);
  assert.equal(publicAddress('8.8.8.8'),true);
});
