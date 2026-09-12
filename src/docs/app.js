/* global SwaggerUIBundle */
const root = new URL('./', globalThis.location.href);
const select = document.getElementById('command');
const search = document.getElementById('search');
const selection = document.getElementById('selection');
let catalog = [];
let ui;
function load(command = '') {
  const url = new URL('openapi.json', root);
  if (command) url.searchParams.set('command', command);
  const entry = catalog.find(item => item.id === command);
  selection.textContent = entry
    ? entry.method+' '+entry.path+' · '+(entry.public?'Público':entry.access)+' · Transporte: POST /commands'+(entry.asynchronous?' · Pode retornar job 202':'')
    : catalog.length+' comandos documentados, além dos endpoints REST do Desk e webhooks da Meta.';
  if (ui) { ui.specActions.updateUrl(url.href); ui.specActions.download(url.href); return; }
  ui = SwaggerUIBundle({url:url.href,dom_id:'#swagger-ui',deepLinking:true,filter:true,
    docExpansion:'list',defaultModelsExpandDepth:-1,persistAuthorization:false,validatorUrl:null,
    syntaxHighlight:false,tryItOutEnabled:false,displayRequestDuration:true});
}
function options() {
  const chosen = select.value;
  select.replaceChildren(new Option('API HTTP completa', ''));
  const term = search.value.toLocaleLowerCase('pt-BR');
  const groups = new Map();
  for (const entry of catalog.filter(item => (item.group+' '+item.id+' '+item.method+' '+item.path).toLocaleLowerCase('pt-BR').includes(term))) {
    if (!groups.has(entry.group)) { const group = document.createElement('optgroup');group.label = entry.group;groups.set(entry.group,group);select.append(group); }
    groups.get(entry.group).append(new Option(entry.method+' '+entry.path, entry.id));
  }
  if ([...select.options].some(option => option.value === chosen)) select.value = chosen;
}
select.addEventListener('change', () => load(select.value));
search.addEventListener('input', options);
fetch(new URL('docs/commands.json',root)).then(response => {
  if (!response.ok) throw new Error('Falha ao carregar catálogo.');
  return response.json();
}).then(result => {catalog = result;options();load();}).catch(error => {selection.textContent = error.message;});
