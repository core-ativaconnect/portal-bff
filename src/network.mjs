import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { HttpError } from './command.mjs';

export function publicAddress(address) {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));}
  // Only global unicast IPv6; excludes mapped IPv4, link-local and private ranges.
  return isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address);
}
export async function externalRequest(value,{method='GET',headers={},body,timeout=18000}={}) {
  let url;try{url=new URL(value);}catch{throw new HttpError(400,'URL inválida.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new HttpError(400,'URL inválida.');
  const hostname=url.hostname.replace(/^\[|\]$/g,''),resolved=await lookup(hostname,{all:true});
  if(!resolved.length||resolved.some(r=>!publicAddress(r.address)))throw new HttpError(400,'O destino precisa ser um endereço público.');
  const chosen=resolved[0];
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers,lookup:(_host,options,callback)=>options.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)},response=>{
      const parts=[];let size=0;
      response.on('data',part=>{size+=part.length;if(size>2000000){request.destroy(new HttpError(502,'Resposta externa muito grande.'));return;}parts.push(part);});
      response.on('end',()=>{const text=Buffer.concat(parts).toString('utf8');let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:response.statusCode,data});});
      response.on('error',reject);
    });
    const timer=setTimeout(()=>request.destroy(new HttpError(504,'Tempo esgotado na integração externa.')),timeout);
    request.on('close',()=>clearTimeout(timer));request.on('error',reject);if(body!=null)request.write(typeof body==='string'?body:JSON.stringify(body));request.end();
  });
}
