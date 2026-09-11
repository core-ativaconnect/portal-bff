import { HttpError } from './command.mjs';
import { now, must, required, fromItem, pick } from './store.mjs';
import { slugify } from './contracts.mjs';
const postFields=['slug','title','excerpt','content','coverImage','pillar','audience','author','published','review','publishedAt','createdAt','updatedAt'];
const postResponse=(item,summary=false)=>pick(fromItem(item),postFields.filter(k=>!summary||k!=='content'));
const pageResponse=item=>pick(fromItem(item),['path','title','content','createdAt','updatedAt']);
const defaults=[['Essencial','/essencial'],['Flow Studio','/flow-studio'],['Plataforma','/plataforma'],['Preços','/precos'],['Sobre','/sobre'],['Blog','/blog']].map(([label,href])=>({label,href}));
function text(value,max=120000){if(value==null)return '';if(typeof value!=='string'||value.length>max)throw new HttpError(400,'Texto inválido ou muito longo.');return value.trim();}
function path(value){return '/'+required(value,'Path',255).replace(/\\/g,'/').split('/').filter(Boolean).join('/');}
async function savePost(store,body) {
  const slug=slugify(required(body.slug,'Slug',160));if(!slug)throw new HttpError(400,'Slug inválido.');
  const old=await store.get('blog_posts',{slug}),timestamp=now();
  if(!['novidade','mercado','educativo','case'].includes(body.pillar)||!['essencial','flow-studio','ambos'].includes(body.audience))throw new HttpError(400,'Pilar ou audiência inválido.');
  const published=body.published===true;
  if(body.publishedAt&&!Number.isFinite(Date.parse(body.publishedAt)))throw new HttpError(400,'Data de publicação inválida.');
  const item={slug,title:required(body.title,'Título',180),excerpt:text(body.excerpt,320),content:text(body.content),cover_image:text(body.coverImage,512),pillar:body.pillar,audience:body.audience,author:required(body.author,'Autor',120),published,review:body.review===true,published_at:published?(body.publishedAt||old?.published_at||timestamp):null,created_at:old?.created_at??timestamp,updated_at:timestamp,all_key:'ALL',admin_sort:`${timestamp}#${slug}`,status_key:published?'PUBLISHED':'DRAFT'};
  item.public_sort=`${item.published_at??timestamp}#${slug}`;
  await store.put('blog_posts',item,{create:!old,previous:old});return postResponse(item);
}
export async function contentOperation(store,route,command) {
  const {controller,operation,params}=route,body=command.body,publicAccess=controller.startsWith('Public');
  if(controller.includes('StaticPage')) {
    if(operation==='list')return(await store.list('static_pages')).sort((a,b)=>a.path.localeCompare(b.path)).map(pageResponse);
    const normalized=path(operation==='save'?body.path:command.query.get('path'));
    const old=await store.get('static_pages',{path:normalized});
    if(operation==='resolve')return pageResponse(must(old));
    if(operation==='delete'){must(old);await store.delete('static_pages',{path:normalized});return null;}
    if(normalized==='/'||['start','signin','signup','entry','admin','plataform','dashboard','studio','contratos','assets'].includes(normalized.split('/')[1].toLowerCase()))throw new HttpError(400,'Path reservado.');
    const item={path:normalized,title:required(body.title,'Título',255),content:text(body.content),created_at:old?.created_at??now(),updated_at:now(),all_key:'ALL',path_sort:normalized.toLowerCase()};
    await store.put('static_pages',item,{create:!old,previous:old});return pageResponse(item);
  }
  if(operation.endsWith('Settings')) {
    const old=await store.get('blog_settings',{id:'blog'});
    if(operation==='getSettings')return{navigation:old?JSON.parse(old.navigation_json):defaults,createdAt:old?.created_at??null,updatedAt:old?.updated_at??null};
    if(!Array.isArray(body.navigation)||!body.navigation.length)throw new HttpError(400,'Informe a navegação.');
    const navigation=body.navigation.map(item=>{const label=required(item.label,'Label',80),href=required(item.href,'Href',512);if(!/^(\/|https?:\/\/)/.test(href))throw new HttpError(400,'Link inválido.');return{label,href};});
    const item={id:'blog',navigation_json:JSON.stringify(navigation),created_at:old?.created_at??now(),updated_at:now()};
    await store.put('blog_settings',item,{create:!old,previous:old});return{navigation,createdAt:item.created_at,updatedAt:item.updated_at};
  }
  if(operation==='savePost')return savePost(store,body);
  if(operation==='importPosts') {if(!Array.isArray(body.posts)||!body.posts.length)throw new HttpError(400,'Informe os posts.');const slugs=new Set();for(const post of body.posts)slugs.add((await savePost(store,post)).slug);return{importedCount:slugs.size,slugs:[...slugs]};}
  if(operation.startsWith('list'))return(await store.list('blog_posts',p=>!publicAccess||p.published)).sort((a,b)=>(publicAccess?b.published_at:b.updated_at).localeCompare(publicAccess?a.published_at:a.updated_at)).map(p=>postResponse(p,true));
  const slug=slugify(required(params.slug,'Slug',160)),post=must(await store.get('blog_posts',{slug}));
  if(publicAccess&&!post.published)throw new HttpError(404,'Post não encontrado.');
  if(operation==='deletePost'){await store.delete('blog_posts',{slug});return null;}return postResponse(post);
}
