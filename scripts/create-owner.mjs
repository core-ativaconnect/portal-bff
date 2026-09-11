import { Store, email, now } from '../src/store.mjs';
const address=email(process.argv[2]);
const store=new Store();
const user=await store.get('users',{email:address});
if(!user)throw new Error('Register the user before promoting it.');
await store.put('users',{...user,role:'OWNER',role_key:'OWNER',active:true,active_key:'ACTIVE',updated_at:now()},{previous:user});
console.log(`Administrator configured: ${address}`);
