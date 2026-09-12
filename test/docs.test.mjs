import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {Parser} from '@asyncapi/parser';
import {routes} from '../src/router.mjs';
import {isDeskRoute} from '../src/desk-routes.mjs';
import {buildOpenApi,commandCatalog} from '../src/docs/openapi.mjs';
import {buildAsyncApi} from '../src/docs/asyncapi.mjs';
import {handler} from '../src/docs/handler.mjs';

test('OpenAPI covers every command and every real Desk route without fictional REST paths',async()=>{
  const spec=buildOpenApi();
  await SwaggerParser.validate(structuredClone(spec));
  const catalog=spec.paths['/commands'].post['x-command-catalog'];
  for(const route of routes){
    assert.ok(catalog.some(c=>c.method===route.method&&c.path===route.path),route.path);
    assert.equal(!!spec.paths['/flow-desk'+route.path]?.[route.method.toLowerCase()],isDeskRoute(route),route.path);
    assert.equal(spec.paths[route.path],undefined,'logical routes are not published REST routes');
  }
  assert.ok(catalog.some(c=>c.path==='/actuator/health'));
  assert.ok(catalog.some(c=>c.path==='/api/v1/jobs/{jobId}'));
  assert.equal(catalog.find(c=>c.id==='FlowProcessingController.process').access,'AUTHENTICATED');
  assert.equal(catalog.find(c=>c.id==='PlatformChannelController.deleteChannel').access,'OWNER');
  assert.ok(spec.paths['/v1/webhook/meta'].get);
  assert.ok(spec.paths['/v1/webhook/meta'].post);
  assert.equal(spec.servers[1].url,'https://api.tiudi.com.br/portal');
});

test('Each command has a valid focused specification and an example matching its request schema',async()=>{
  const ajv=new Ajv({strict:false,validateFormats:false});
  addFormats(ajv);
  for(const entry of commandCatalog){
    const spec=buildOpenApi(entry.id);
    await SwaggerParser.validate(structuredClone(spec));
    const expanded=await SwaggerParser.dereference(spec);
    const body=expanded.paths['/commands'].post.requestBody.content['application/json'];
    const validate=ajv.compile(body.schema);
    assert.ok(validate(entry.example),entry.id+': '+JSON.stringify(validate.errors));
    assert.ok(new RegExp(entry.pattern).test(entry.example.path));
    assert.ok(expanded.paths['/commands'].post.responses[entry.responseSchema?'200':'204']);
  }
});

test('AsyncAPI describes both directions of the actual WebSocket protocol',async()=>{
  const parsed=await new Parser().parse(JSON.stringify(buildAsyncApi()));
  assert.ok(parsed.document,JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter(d=>d.severity===0),[]);
  const spec=buildAsyncApi();
  for(const command of ['connect','message','ping'])assert.equal(spec.operations[command].action,'receive');
  for(const response of ['connected','messages','pong','error'])assert.equal(spec.operations[response].action,'send');
  assert.equal(spec.operations.poll,undefined);
});

test('Docs serve local assets, retain /portal links, and reject unknown documents',async()=>{
  const get=(rawPath,queryStringParameters)=>handler({rawPath,queryStringParameters,requestContext:{http:{method:'GET'}}});
  for(const prefix of ['', '/portal']){
    const html=await get(prefix+'/docs');assert.equal(html.statusCode,200);
    assert.match(html.headers['content-security-policy'],/script-src 'self'/);
    const page=new URL(prefix+'/docs','https://api.tiudi.com.br');
    for(const match of html.body.matchAll(/(?:src|href)="([^"]+)"/g)){
      const url=new URL(match[1],page);
      assert.ok(url.pathname.startsWith(prefix+'/'));
      assert.equal((await get(url.pathname)).statusCode,200,url.pathname);
    }
    assert.equal((await get(prefix+'/docs/')).headers.location,'../docs');
  }
  const focused=await get('/openapi.json',{command:'AuthController.login'});
  assert.equal(JSON.parse(focused.body).paths['/commands'].post.security.length,1);
  assert.equal((await get('/openapi.json',{command:'unknown'})).statusCode,404);
  assert.equal((await get('/docs/../../.env')).statusCode,404);
  assert.equal((await handler({rawPath:'/docs',httpMethod:'POST'})).statusCode,405);
  assert.doesNotThrow(()=>new Function(readFileSync(new URL('../src/docs/app.js',import.meta.url),'utf8')));
});
