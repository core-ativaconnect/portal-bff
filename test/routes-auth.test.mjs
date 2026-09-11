import test from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../src/router.mjs';
import { handler } from '../src/handler.mjs';
test('every protected operation rejects anonymous requests at the command boundary',async()=>{
  for(const route of routes.filter(r=>r.access!=='PUBLIC')){
    const result=await handler({requestContext:{http:{method:'POST'}},body:JSON.stringify({path:route.path.replace(/\{\w+\}/g,'00000000-0000-4000-8000-000000000001'),method:route.method,'body-data':{}})});
    assert.equal(result.statusCode,401,`${route.method} ${route.path}`);
  }
});
