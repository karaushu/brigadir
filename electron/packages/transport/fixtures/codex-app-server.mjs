// Synthetic `codex app-server`: newline JSON-RPC without `jsonrpc`. Never calls a backend.
import {createInterface} from 'node:readline';
const mode=process.env.BRIGADIR_CODEX_FIXTURE??'chatgpt';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize'){send({method:'remoteControl/status/changed',params:{}});send({id:message.id,result:{codexHome:'/tmp/codex'}});return;}
 if(message.method==='account/read'){send({id:message.id,result:{account:mode==='api-key'?{type:'apiKey'}:{type:'chatgpt',email:'someone@example.com',planType:'self_serve_business_prolite'},requiresOpenaiAuth:true}});return;}
 if(message.method==='account/rateLimits/read'){
  if(message.params?.excludeResetCreditDetails!==true){send({id:message.id,error:{code:-32602,message:'expected a background read'}});return;}
  send({id:message.id,result:{ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',limitName:null,normalModelSlug:null,primary:{usedPercent:45,windowDurationMins:10080,resetsAt:1790580258},secondary:mode==='two'?{usedPercent:91,windowDurationMins:300,resetsAt:1790260000}:null,credits:null,individualLimit:null,spendControlReached:null,planType:'self_serve_business_prolite',rateLimitReachedType:null},rateLimitsByLimitId:null,rateLimitResetCredits:null,accountId:null,rateLimitUpsell:null}});return;}
 send({id:message.id,error:{code:-32601,message:'unknown'}});
});
