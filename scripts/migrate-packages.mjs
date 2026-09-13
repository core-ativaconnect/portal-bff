import {Store, now} from '../src/store.mjs';
import {packageFields} from '../src/billing.mjs';

// Dry run unless --apply. Execute with the target table prefix and AWS credentials.
const args=process.argv.slice(2), value=name=>args[args.indexOf(name)+1];
for(const flag of ['--max-mau','--max-users','--price-cents'])if(!args.includes(flag))throw new Error(`Informe ${flag}; nenhum valor comercial é presumido.`);
const maxMau=Number(value('--max-mau')),maxUserCount=Number(value('--max-users')),monthlyPriceCents=Number(value('--price-cents'));
if(![maxMau,maxUserCount,monthlyPriceCents].every(Number.isSafeInteger)||maxMau<0||maxUserCount<1||monthlyPriceCents<0)throw new Error('Limites ou preço inválidos.');
const store=new Store(),apply=args.includes('--apply');
const selectedId=args.includes('--contract-id')?value('--contract-id'):null;
if(args.includes('--contract-id')&&(!selectedId||selectedId.startsWith('--')))throw new Error('Informe o ID do contrato.');
const contracts=await store.list('contracts',c=>c.company_name&&!c.package_id&&!c.deletion_in_progress&&(!selectedId||c.id===selectedId));
// Validate every contract before writing anything. Re-running safely skips migrated contracts.
for(const c of contracts){
  if(!Number.isSafeInteger(c.max_channel_count)||c.max_channel_count<0)throw new Error(`Contrato ${c.id}: defina um limite de canais antes de migrar.`);
  if(!Number.isSafeInteger(c.max_flow_count)||c.max_flow_count<0)throw new Error(`Contrato ${c.id}: defina um limite de fluxos antes de migrar.`);
  if((await store.list('contract_access',a=>a.contract_id===c.id)).length>maxUserCount)throw new Error(`Contrato ${c.id}: limite de usuários menor que a quantidade vinculada.`);
}
for(const c of contracts){
  const id=`legacy-${maxMau}-${maxUserCount}-${c.max_flow_count}-${c.max_channel_count}-${monthlyPriceCents}`;
  const plan={id,name:`Migrado: ${maxMau} MAU / ${maxUserCount} usuários / ${c.max_flow_count} fluxos / ${c.max_channel_count} canais`,maxMau,maxUserCount,maxFlowCount:c.max_flow_count,maxChannelCount:c.max_channel_count,monthlyPriceCents,currency:'BRL',active:true,created_at:now()};
  console.log(JSON.stringify({apply,contractId:c.id,packageId:id,maxMau,maxUserCount,maxFlowCount:c.max_flow_count,maxChannelCount:c.max_channel_count,monthlyPriceCents}));
  if(!apply)continue;
  if(!await store.get('packages',{id}))await store.put('packages',plan,{create:true});
  await store.transaction([{Update:{TableName:store.table('packages'),Key:{id},UpdateExpression:'ADD reference_revision :one',ConditionExpression:'attribute_exists(id)',ExpressionAttributeValues:{':one':1}}},store.putOperation('contracts',{...c,...packageFields(plan),mau_tracking_started_at:now(),updated_at:now()},
    'attribute_exists(id) AND attribute_not_exists(package_id) AND updated_at = :previous AND (attribute_not_exists(portal_revision) OR portal_revision = :revision) AND (attribute_not_exists(deletion_in_progress) OR deletion_in_progress = :no)',
    {':previous':c.updated_at,':revision':c.portal_revision??0,':no':false})]);
}
console.log(`${contracts.length} contratos ${apply?'migrados':'previstos; use --apply para aplicar'}.`);
