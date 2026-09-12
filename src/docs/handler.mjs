import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {buildOpenApi,commandCatalog} from './openapi.mjs';
import {buildAsyncApi} from './asyncapi.mjs';

const require=createRequire(import.meta.url);
const swaggerRoot=require('swagger-ui-dist').getAbsoluteFSPath();
const cache=new Map();
const files={
  'index.html':[new URL('./index.html',import.meta.url),'text/html; charset=utf-8'],
  'app.js':[new URL('./app.js',import.meta.url),'application/javascript; charset=utf-8'],
  'style.css':[new URL('./style.css',import.meta.url),'text/css; charset=utf-8'],
  'websocket.html':[new URL('./websocket.html',import.meta.url),'text/html; charset=utf-8'],
  'swagger-ui-bundle.js':[join(swaggerRoot,'swagger-ui-bundle.js'),'application/javascript; charset=utf-8'],
  'swagger-ui.css':[join(swaggerRoot,'swagger-ui.css'),'text/css; charset=utf-8'],
};
const response=(statusCode,body,type='application/json; charset=utf-8')=>({statusCode,headers:{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'},body});
export async function handler(event){
  const method=event.requestContext?.http?.method??event.httpMethod;
  if(method!=='GET')return response(405,JSON.stringify({message:'Use GET.'}));
  const path=event.rawPath??event.path??'';
  if(path.endsWith('/docs/')||path.endsWith('/docs/index.html'))return{statusCode:302,headers:{location:'../docs','cache-control':'no-store'},body:''};
  if(path.endsWith('/swagger'))return{statusCode:302,headers:{location:'./docs','cache-control':'no-store'},body:''};
  if(path.endsWith('/openapi.json')){
    const query=event.queryStringParameters??Object.fromEntries(new URLSearchParams(event.rawQueryString));
    if(query.command&&!commandCatalog.some(c=>c.id===query.command))return response(404,JSON.stringify({message:'Comando não encontrado no catálogo.'}));
    return response(200,JSON.stringify(buildOpenApi(query.command),null,2));
  }
  if(path.endsWith('/asyncapi.json'))return response(200,JSON.stringify(buildAsyncApi(),null,2));
  if(path.endsWith('/docs/commands.json'))return response(200,JSON.stringify(commandCatalog));
  const name=path.endsWith('/docs')?'index.html':path.slice(path.lastIndexOf('/docs/')+6);
  if(!files[name])return response(404,JSON.stringify({message:'Documento não encontrado.'}));
  if(!cache.has(name))cache.set(name,readFileSync(files[name][0],'utf8'));
  const result=response(200,cache.get(name),files[name][1]);
  if(name.endsWith('.html'))result.headers['content-security-policy']="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.tiudi.com.br http://localhost:3001; frame-ancestors 'none'; base-uri 'self'";
  return result;
}
