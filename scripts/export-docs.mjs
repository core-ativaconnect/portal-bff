import {mkdir,writeFile} from 'node:fs/promises';
import {buildOpenApi,commandCatalog} from '../src/docs/openapi.mjs';
import {buildAsyncApi} from '../src/docs/asyncapi.mjs';

const directory=new URL('../docs/generated/',import.meta.url);
await mkdir(directory,{recursive:true});
for(const [name,value] of [['openapi.json',buildOpenApi()],['asyncapi.json',buildAsyncApi()],['commands.json',commandCatalog]]){
  await writeFile(new URL(name,directory),JSON.stringify(value,null,2)+'\n');
  console.log('Exportado docs/generated/'+name);
}
