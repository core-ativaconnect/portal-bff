import { getQuickJS } from 'quickjs-emscripten';
import ts from 'typescript';
export async function executeScript(script,state) {
  const QuickJS=await getQuickJS();
  const source=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None}}).outputText;
  const wrapper=`const logs=[]; const console={log:(...args)=>logs.push(args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ')),warn:(...args)=>logs.push(args.join(' ')),error:(...args)=>logs.push(args.join(' '))};let user=JSON.parse(${JSON.stringify(JSON.stringify(state))});\n${source}\nJSON.stringify({user,logs});`;
  const deadline=Date.now()+1000;
  try{return{ok:true,...JSON.parse(QuickJS.evalCode(wrapper,{shouldInterrupt:()=>Date.now()>deadline,memoryLimitBytes:16*1024*1024}))};}
  catch(error){return{ok:false,user:state,logs:[],error:String(error.message||error)};}
}
