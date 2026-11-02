// Synthetic agent over real stdio. Never calls a provider or touches project data.
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {join} from 'node:path';
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const scenario = process.argv[2] ?? process.env.BRIGADIR_FIXTURE_SCENARIO;
const log = process.argv[3] ?? process.env.BRIGADIR_FIXTURE_LOG;
const record = (event, params) => { if (log) appendFileSync(log, JSON.stringify({ event, params }) + '\n'); };
let connection;
let release;
let quotaRejected=false;let autoAccept=false;
// spec/agents-and-providers#sign-in-recovery: signed out while BRIGADIR_TEST_AUTH_FILE does not exist — a prompt starting with `auth` (or `auth-startup`, the session itself) answers `authRequired` after the CLI's own text.
const signedOut=()=>Boolean(process.env.BRIGADIR_TEST_AUTH_FILE)&&!existsSync(process.env.BRIGADIR_TEST_AUTH_FILE);if(process.env.BRIGADIR_TEST_AUTH_FILE)record('process',{pid:process.pid});
// spec/composer-steering-queue-and-ghost#steering steering: `steering` injects into a running `steer-wait`; `steering-late` answers promptRequired as if the turn just
// ended; `steering-codex` ends the running turn and starts its own, reported by codex-shaped `threadStatus`.
const steering=scenario==='steering'||scenario==='steering-late'||scenario==='steering-codex';let steerWaiter;
const threadStatus=(client,type)=>update(client,{sessionUpdate:'session_info_update',_meta:{codex:{threadStatus:{type,...(type==='active'?{activeFlags:[]}:{})}}}});
// spec/chat-turns-plans-and-questions#agent-started-turns `agent-turn`: Claude Code begins a turn on its own after a background task — the wire of a live
// run (claude-agent-turn.jsonl). `agent-turn-codex`: the same shape told by codex `threadStatus`.
// `agent-turn-quick`: the agent's turn begins 50 ms after the `idle` that ended ours (and, with
// BRIGADIR_FIXTURE_AGENT_TURN_TWICE=1, once more 50 ms after its own `idle`) — while the client may still settle the turn before.
const agentTurns=scenario==='agent-turn'||scenario==='agent-turn-codex'||scenario==='agent-turn-quick';let agentHold=null;
const recorded=()=>readFileSync(new URL('./claude-agent-turn.jsonl',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.from==='agent');
let mcpServers = [];
let options = [
 { id:'model', name:'Model', type:'select', currentValue:'fixture', options:[{value:'fixture',name:'Fixture'},{value:'other',name:'Other'}] },
 { id:'fast', name:'Fast', type:'boolean', currentValue:false },
];
if(scenario==='catalog')options=[options[1],{id:'approval',category:'mode',name:'Mode',type:'select',currentValue:'manual',options:[{value:'manual',name:'Manual'},{value:'edits',name:'Accept edits'},{value:'auto',name:'Auto approve'}]},{id:'thinking',category:'thought_level',name:'Effort',type:'select',currentValue:'high',options:[{value:'low',name:'low'},{value:'medium',name:'medium'},{value:'high',name:'high'}]},options[0],{id:'trace',name:'Trace output',type:'boolean',currentValue:false}];
if(scenario==='ghost-model'||scenario==='ghost-option-fail')options[0].options.push({value:'advertised-haiku',name:'Claude Haiku'});
// spec/agents-and-providers#catalog: effort levels depend on the model, as the real adapters answer — `lite` has none, `other` stops at medium.
const effortFor=model=>model==='lite'?null:{id:'effort',category:'thought_level',name:'Effort',type:'select',currentValue:model==='other'?'medium':'high',options:(model==='other'?['low','medium']:['low','medium','high']).map(value=>({value,name:value[0].toUpperCase()+value.slice(1)}))};
const withEffort=model=>[{...options[0],currentValue:model},...(effortFor(model)?[effortFor(model)]:[]),...options.filter(option=>option.id!=='model'&&option.id!=='effort')];
// `ghost-notice`: the model-effort catalog, and a model change answered with assistant text, as claude-agent-acp does (spec/composer-steering-queue-and-ghost#ghost-headless).
const perModel=scenario==='model-effort'||scenario==='ghost-notice';
if(perModel){options[0].options.push({value:'lite',name:'Lite'});
 options.push({id:'mode',category:'mode',name:'Mode',type:'select',currentValue:'default',options:[['default','Manual'],['acceptEdits','Accept edits'],['plan','Plan'],['auto','Auto'],['bypassPermissions','Bypass permissions']].map(([value,name])=>({value,name}))},
  {id:'collaboration_mode',category:'collaboration_mode',name:'Collaboration mode',type:'select',currentValue:'default',options:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}]},
  {id:'fast-mode',category:'model_config',name:'Fast mode',type:'select',currentValue:'off',options:[{value:'off',name:'Off'},{value:'on',name:'On'}]});
 options=withEffort('fixture');}
// spec/chat-turns-plans-and-questions#plan-approval `plan-modes`: the modes of claude-agent-acp (legacy modes and the `mode` option), the session starts in `auto`.
const planModes=scenario==='plan-modes',claudeModes=[['default','Manual'],['acceptEdits','Accept edits'],['plan','Plan'],['auto','Auto'],['bypassPermissions','Bypass permissions']];
let currentMode=planModes?'auto':'manual';
if(planModes)options.push({id:'mode',category:'mode',name:'Mode',type:'select',currentValue:currentMode,options:claudeModes.map(([value,name])=>({value,name}))});
const syncMode=mode=>{currentMode=mode;options=options.map(option=>option.id==='mode'?{...option,currentValue:mode}:option);};
const session = () => ({ sessionId:'fixture-session', configOptions:options, modes:planModes?{currentModeId:currentMode,availableModes:claudeModes.map(([id,name])=>({id,name}))}:{currentModeId:'manual',availableModes:[{id:'manual',name:'Manual'}]} });
const update = (client, payload) => client.notify(methods.client.session.update, {sessionId:'fixture-session',update:payload});
// spec/chat#subagents: the SDK schema here drops capabilities it does not know; the raw `initialize` line shows what the client sent.
let rawIn='';if(scenario==='subagents')process.stdin.on('data',chunk=>{rawIn+=chunk.toString();let index;while((index=rawIn.indexOf('\n'))>=0){const line=rawIn.slice(0,index);rawIn=rawIn.slice(index+1);if(line.includes('"initialize"'))try{record('raw-initialize',JSON.parse(line).params);}catch{}}});
connection = agent({name:'fixture'})
 .onRequest(methods.agent.initialize, async ({params}) => {
  record('initialize',params);
  if (process.env.CODEX_CONFIG) record('codex-config',JSON.parse(process.env.CODEX_CONFIG));
  if (process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS !== undefined) record('todo-tools',process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS);
  if (process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT !== undefined) record('mcp-idle-timeout',process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT);
  if(scenario === 'hang-init') await new Promise(() => {});
  if(scenario === 'slow-init') await new Promise(resolve => setTimeout(resolve, 800));
  // spec/composer-steering-queue-and-ghost#quick-question: fork and resume as claude-agent-acp advertises them; `no-fork` leaves them out.
  return {protocolVersion:PROTOCOL_VERSION,agentCapabilities:{loadSession:scenario !== 'no-load',promptCapabilities:{image:scenario!=='no-image'},sessionCapabilities:{...(['directories','fs-policy'].includes(scenario)?{additionalDirectories:{}}:{}),...(scenario==='no-fork'?{}:{fork:{},resume:{}}),...(scenario==='no-delete'?{}:{delete:{}})}},authMethods:[],...(steering||agentTurns?{_meta:{steering:{supported:true}}}:{})};
 })
 .onRequest(methods.agent.session.new, ({params,client}) => {if(scenario==='auth-startup'&&signedOut())throw RequestError.authRequired();record('new',params); mcpServers = params.mcpServers; if(scenario==='steering-codex')setTimeout(()=>{void threadStatus(client,'idle');},20); return session();})
 // spec/composer-steering-queue-and-ghost#quick-question: like claude-agent-acp, the fork answers with the id only; the client opens it with `session/resume`.
 .onRequest(methods.agent.session.fork, async ({params}) => {record('fork',params); mcpServers = params.mcpServers; return {sessionId:'fixture-session'};})
 // spec/agents-and-providers#one-shot: one-shot calls delete their session; claude-agent-acp and codex-acp advertise `delete`.
 .onRequest(methods.agent.session.delete, async ({params}) => {record('delete',params); return {};})
 .onRequest(methods.agent.session.resume, async ({params}) => {record('resume',params); mcpServers = params.mcpServers; return session();})
 .onRequest(methods.agent.session.load, async ({params,client}) => {if(scenario==='auth-startup'&&signedOut())throw RequestError.authRequired();record('load',params); mcpServers = params.mcpServers; await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Historical replay'}}); return session();})
 .onRequest(methods.agent.session.setMode, async ({params,client}) => {record('mode',params);if(planModes)syncMode(params.modeId); if(quotaRejected&&params.modeId==='manual'){quotaRejected=false;await update(client,{sessionUpdate:'usage_update',used:1,size:100,_meta:{'_claude/rateLimit':{status:'allowed',rateLimitType:'five_hour'}}});}return {};})
 .onRequest(methods.agent.session.setConfigOption, async ({params,client}) => {
  record('option',params);if(scenario==='ghost-option-fail')throw new Error('Option unavailable');
  if(scenario==='ghost-notice'&&params.configId==='model')await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'**Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.'}});
  if(perModel&&params.configId==='effort'&&!options.find(option=>option.id==='effort')?.options.some(choice=>choice.value===params.value))throw new Error('Effort is not available for this model');
  options=perModel&&params.configId==='model'?withEffort(params.value):options.map(option=>option.id===params.configId?{...option,currentValue:params.value}:option);
  if(planModes&&params.configId==='mode')syncMode(params.value);
  return {configOptions:options};
 })
 .onNotification(methods.agent.session.cancel, () => {record('cancel',{}); release?.();})
 .onRequest('_session/steering',params=>params,async({params,client})=>{
  const text=params.prompt.map(item=>item.type==='text'?item.text:'').join('');record('steer',{text,meta:params._meta});
  // codex-acp with no running turn starts its own; Claude answers promptRequired.
  if(scenario==='steering-late'||!steerWaiter&&scenario!=='steering-codex')return {outcome:'promptRequired',reason:'noRunningTurn'};
  const waiter=steerWaiter;steerWaiter=undefined;
  if(scenario==='steering')return waiter(text),{outcome:'injected'};
  // The old turn's flags change once more before it ends: its active and idle must not close the adopted turn.
  if(waiter){await threadStatus(client,'active');waiter(null);await new Promise(resolve=>setTimeout(resolve,50));}
  const silent=process.env.BRIGADIR_FIXTURE_ADOPTED_SILENT==='1';
  if(!silent)await threadStatus(client,'active');
  const finish=async()=>{
   // `BURST`: a flag change, the output and the end in one write, so one stdout chunk carries them all.
   if(process.env.BRIGADIR_FIXTURE_ADOPTED_BURST==='1'){const status=type=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'session_info_update',_meta:{codex:{threadStatus:{type,...(type==='active'?{activeFlags:['waitingOnApproval']}:{})}}}}}});
    process.stdout.write([status('active'),{jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`adopted: ${text}`}}}},status('idle')].map(item=>JSON.stringify(item)).join('\n')+'\n');return;}
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`adopted: ${text}`}});await threadStatus(client,'idle');};
  // `FAST`: the new turn ends before the steer's own answer, as a turn that fails at once does. `SILENT`: it never reports.
  if(silent){}else if(process.env.BRIGADIR_FIXTURE_ADOPTED_FAST==='1')await finish();else if(process.env.BRIGADIR_FIXTURE_ADOPTED_GATE){const gate=process.env.BRIGADIR_FIXTURE_ADOPTED_GATE,poll=setInterval(()=>{if(!existsSync(gate))return;clearInterval(poll);void finish();},20);}
  // `ADOPTED_GATE`: the output waits for that file, which a test writes once the host journaled the turn, instead of guessing a delay.
  else setTimeout(()=>{void finish();},Number(process.env.BRIGADIR_FIXTURE_ADOPTED_MS||100));
  return {outcome:'startedNewTurn'};
 })
 .onRequest(methods.agent.session.prompt, async ({params,client}) => {
  // The brief every session carries (spec/chat-turns-plans-and-questions#checklist-tools) is context, not the prompt the scenarios match on; `prompt-blocks` keeps it.
  const text=params.prompt.filter(item=>!(item.type==='text'&&item.text.startsWith('<attached_context name="Brigadir brief"'))).map(item=>item.type==='text'?item.text:'').join(''); record('prompt',text); record('prompt-blocks',params.prompt);
  if(text.startsWith('Quick question'))return quickQuestion(text,client);
  // spec/chat-turns-plans-and-questions#agent-started-turns: a prompt while the agent's own turn runs joins that turn; the turn answers it at its end.
  if(agentHold){const hold=agentHold;agentHold=null;return new Promise(answer=>hold({text,answer}));}
  if(agentTurns&&text==='background')return backgroundTurn(client);
  if(scenario?.startsWith('background-'))return backgroundScenario(client);
  if(scenario==='fs-policy'&&text.startsWith('test files')){
   const read=await client.request(methods.client.fs.readTextFile,{sessionId:'fixture-session',path:join(process.cwd(),'read.txt'),line:2,limit:1});record('fs-read',read);
   try{await client.request(methods.client.fs.writeTextFile,{sessionId:'fixture-session',path:join(process.cwd(),'read.txt'),content:'forbidden'});record('fs-denied',false);}catch(error){record('fs-denied',String(error));}
   await client.request(methods.client.fs.writeTextFile,{sessionId:'fixture-session',path:join(process.cwd(),'child/new/deep.txt'),content:'agent file\n'});
  }
  if(scenario==='ghost-warning')await update(client,{sessionUpdate:'usage_update',used:1,size:100,_meta:{'_claude/rateLimit':{status:'allowed_warning',rateLimitType:'five_hour'}}});
  if(scenario==='catalog')await update(client,{sessionUpdate:'usage_update',used:42,size:100});
  // spec/composer#agent-capsule: the agent announces /compact, so the context popover offers Compact.
  if(scenario==='catalog')await update(client,{sessionUpdate:'available_commands_update',availableCommands:[{name:'compact',description:'Summarise and free context',input:null}]});
  if(scenario==='crew'&&text.startsWith('Write only a commit message')){
   // spec/crew#accept: the one-shot commit message generator of crew acceptance. The answer takes `<type>: [<Area>]` from the repo's
   // recent commits, so a test sees the log reached the call; a part titled «no message» fails it to show the fallback.
   const material=JSON.parse(text.slice(text.indexOf('\n')+1)),changes=Array.isArray(material)?material:material.changes;
   if(/no message/.test(material.task??''))throw new Error('Fixture generator failure');
   const style=/^(\w+): \[([^\]]+)\]/m.exec(changes[0]?.recentCommitMessages??''),files=changes.flatMap(item=>[...item.stat.matchAll(/^\s*(\S+)\s+\|/gm)].map(match=>match[1]));
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`${style?.[1]??'feat'}: [${style?.[2]??'Fixture'}] ${material.task??'change'}\n\nFiles: ${files.join(', ')}`}});
   return {stopReason:'end_turn'};
  }
  if(scenario==='crew'){
   // Scripted crew agent: `@call <tool> <json>` calls a brigadir MCP tool, `@write <path> <text>` writes inside cwd. Never a provider.
   const config=mcpServers.find(s=>s.name==='brigadir');let out='';
   let script=params.prompt.filter(item=>item.type==='text'&&!item.text.startsWith('<attached_context')).map(item=>item.text).join('\n');
   // Scripted reviewer: round 1 comments on the first changed file, round 2 approves unless the part is titled «dispute».
   if(/^@on-report accept/m.test(script))autoAccept=true;
   const incoming=/^Report from `[^`]*` · [^\n]* \(task ([^,\s)]+)[^)]*\)/.exec(script);if(autoAccept&&incoming)script=`@call accept_task {"taskId":"${incoming[1]}"}`;
   const check=/^Check task (\S+) of `[^`]*` \(reviewId (\S+), round (\d) of \d\)/.exec(script);
   if(check&&/hold the verdict/.test(script.split('\n')[1]??'')){await new Promise(resolve=>{release=resolve;});release=undefined;return {stopReason:'cancelled'};}
   if(check){const file=/^- (\S+) [A-Z]/m.exec(script)?.[1];const dispute=/dispute/i.test(script.split('\n')[1]??'');const comment=file&&(check[3]==='1'||dispute);
    script=comment?`@call submit_review {"taskId":"${check[1]}","reviewId":"${check[2]}","comments":[{"path":"${file}","start":1,"end":1,"text":"Round ${check[3]}: say hello instead"}]}`:`@call approve {"taskId":"${check[1]}","reviewId":"${check[2]}"}`;}
   for(const line of script.split('\n')){
    if(line.startsWith('@write ')){const rest=line.slice(7);const space=rest.indexOf(' ');const path=space<0?rest:rest.slice(0,space);const full=join(process.cwd(),path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,(space<0?'':rest.slice(space+1))+'\n');out+=`wrote ${path}\n`;}
    else if(line.startsWith('@call ')){
     const rest=line.slice(6);const space=rest.indexOf(' ');const name=space<0?rest:rest.slice(0,space);const args=space<0?{}:JSON.parse(rest.slice(space+1));
     const mcp=new Client({name:'fixture',version:'1.0.0'});const stdio=new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...Object.fromEntries(config.env.map(e=>[e.name,e.value]))}});
     const controller=new AbortController();release=()=>controller.abort();
     try{await mcp.connect(stdio);const result=await mcp.callTool({name,arguments:args},undefined,{signal:controller.signal,timeout:600000});out+=`${name}: ${result.content.map(item=>item.text??'').join('')}${result.isError?' [error]':''}\n`;record('crew-call',{name,args,result});}
     catch(error){if(controller.signal.aborted)return {stopReason:'cancelled'};out+=`${name} failed: ${error.message}\n`;record('crew-call',{name,args,error:error.message});}
     finally{await mcp.close();release=undefined;}
    }
   }
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:out||'ok'}});
   return {stopReason:'end_turn'};
  }
  // spec/notifications-slack-notes-and-schedules#notes: a note's chat — the message after «The person writes:»; `edit` asks to edit the note's file and adds a line.
  if(text.includes('\n<note>\n'))return noteChat(text,client);
  if(text.startsWith('auth')){record('auth-prompt',{text,signedOut:signedOut()});if(signedOut()){await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Failed to authenticate: OAuth session expired and could not be refreshed'}});throw RequestError.authRequired();}await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`Signed in: ${text}`}});return {stopReason:'end_turn'};}
  if(text==='quota'){
   // The same rate-limit payload twice: the adapter's usage_update meta and the raw SDK event (spec/agents-and-providers#quota-sources).
   const info={status:'allowed',resetsAt:1790252400,rateLimitType:'five_hour',overageStatus:'rejected',isUsingOverage:false,unifiedWindows:{five_hour:{utilization:0.62,resetsAt:1790252400},seven_day:{utilization:0.26,resetsAt:1790690400}}};
   await update(client,{sessionUpdate:'usage_update',used:1,size:100,_meta:{'_claude/rateLimit':info}});
   await client.notify('_claude/sdkMessage',{sessionId:'fixture-session',message:{type:'rate_limit_event',rate_limit_info:info}});
   return {stopReason:'end_turn'};
  }
  // spec/pull-requests-and-ci#pr-overview, spec/editor#editor-principles: one-shot PR prompts answer with the JSON the app asks for.
  // spec/pull-requests-and-ci#review-with-agent: the review agent leaves a finding through pr_comment and says so.
  if(text.startsWith('Review pull request #')){
   const config=mcpServers.find(s=>s.name==='brigadir'),mcp=new Client({name:'fixture',version:'1.0.0'}),stdio=new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...Object.fromEntries(config.env.map(e=>[e.name,e.value]))}});
   try{await mcp.connect(stdio);const result=await mcp.callTool({name:'pr_comment',arguments:{path:'src/loyalty/LoyaltyRule.tsx',line:6,body:'The free count ignores prices.'}});await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(result.content?.[0]?.text??'')}});}
   finally{await mcp.close();}
   return {stopReason:'end_turn'};
  }
  // spec/pull-requests-and-ci#review-with-agent: the person answers a draft in its thread; the fixture agrees and rewrites it.
  if(text.startsWith('The person answers your draft review comment ')){
   const id=text.slice('The person answers your draft review comment '.length).split(' ')[0];
   const config=mcpServers.find(s=>s.name==='brigadir'),mcp=new Client({name:'fixture',version:'1.0.0'}),stdio=new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...Object.fromEntries(config.env.map(e=>[e.name,e.value]))}});
   try{await mcp.connect(stdio);const result=await mcp.callTool({name:'pr_comment_reply',arguments:{id,body:'Agreed, the order is intended. I rewrote the comment to ask for the test.',text:'Please add a test with 3 items so the rule stays pinned.'}});await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(result.content?.[0]?.text??'')}});}
   finally{await mcp.close();}
   return {stopReason:'end_turn'};
  }
  // spec/git#agent-branch-names: the branch-name one-shot; a task titled «no branch name» gets an empty answer, so the derived name stays.
  if(text.startsWith('Pick an icon for a software project')){const name=(text.match(/"name":"([^"]*)"/)||[])[1]||'';await new Promise(resolve=>setTimeout(resolve,name.includes('slow')?1500:0));await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:name.includes('unknown')?'{"icon":"not-a-lucide-icon","color":"red"}':JSON.stringify({icon:'truck',color:'orange',reason:'Courier app: name and package.json description',suggested:['bike','package','route','not-an-icon']})}});return {stopReason:'end_turn'};}
  // spec/git#commit-dialog: «Split with the agent» — one commit per file, in the order listed; a repo named «split-fail» gets prose.
  if(text.startsWith('Split these changes into commits')){const material=JSON.parse(text.slice(text.indexOf('\n')+1));const commits=material.flatMap(repo=>repo.files.map(file=>({repo:repo.repo,message:`Update ${file.path}`,reason:`Only ${file.path} changes here.`,files:[file.path]})));await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:material.some(repo=>repo.repo.includes('split-fail'))?'I could not split these.':JSON.stringify({commits})}});return {stopReason:'end_turn'};}
  if(text.startsWith('Name a git branch')){await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.includes('no branch name')?'':'Agent named branch'}});return {stopReason:'end_turn'};}
  // spec/appearance#evolution-redesign: the reviewer's word from the drafts, and the hint on step 3.
  if(text.startsWith('Write the summary of a code review')){await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Two things before merge: the free item and the badge.'}});return {stopReason:'end_turn'};}
  if(text.startsWith('A reviewer is about to send a review')){await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({event:'REQUEST_CHANGES',reason:'the badge comment points to a bug.'})}});return {stopReason:'end_turn'};}
  if(text.startsWith('Summarize this pull request for its reviewer')){await new Promise(resolve=>setTimeout(resolve,Number(process.env.BRIGADIR_FIXTURE_SUMMARY_MS||0)));await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({headline:'Loyalty 1+1: every second item is free',check:[{path:'src/loyalty/rules.ts',start:1,text:'Three items: one free, the cheapest is not chosen.'},'A cart of one item stays paid.'],minutes:6,done:[{path:'src/loyalty/LoyaltyRule.tsx',start:4,end:6,text:'adds the 1+1 rule: every second item is free, the total counts only paid items.'},{path:'src/loyalty/rules.ts',text:'exports the rule flag.'}],watch:[{path:'src/loyalty/LoyaltyRule.tsx',start:6,end:6,text:'the free item is the second by order, not the cheapest one.'}]})}});return {stopReason:'end_turn'};}
  if(text.startsWith('You help ')){await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({kind:text.includes('Look at the review thread')?'explanation':'reply',text:'The brief says every second item, so 3 items give 1 free: the code matches. The real gap is price.'})}});return {stopReason:'end_turn'};}
  // spec/composer-steering-queue-and-ghost#steering-hold: a subagent's tool finishes first (no boundary), then the top-level tool (the boundary); a steer is heard after it.
  if(text==='tool-steer'){
   const ms=Number(process.env.BRIGADIR_FIXTURE_TOOL_MS||800);
   await update(client,{sessionUpdate:'tool_call',toolCallId:'top',title:'Run tests',kind:'execute',status:'in_progress',_meta:{claudeCode:{toolName:'Agent'}}});
   await update(client,{sessionUpdate:'tool_call',toolCallId:'child',title:'Read file',kind:'read',status:'in_progress',_meta:{claudeCode:{toolName:'Read',parentToolUseId:'top'}}});
   await new Promise(resolve=>setTimeout(resolve,ms/2));
   await update(client,{sessionUpdate:'tool_call_update',toolCallId:'child',status:'completed'});
   await new Promise(resolve=>setTimeout(resolve,ms/2));
   const heard=new Promise(resolve=>{steerWaiter=resolve;setTimeout(()=>resolve(null),Number(process.env.BRIGADIR_FIXTURE_STEER_WAIT_MS||3000));});
   await update(client,{sessionUpdate:'tool_call_update',toolCallId:'top',status:'completed'});
   const said=await heard;steerWaiter=undefined;
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:said===null?'no steer':`heard: ${said}`}});
   return {stopReason:'end_turn'};
  }
  // spec/chat#tool-states: a steer cuts off a tool call Claude is still writing; claude-agent-acp then fails the turn with
  // `incomplete_tool_call`. `orphan-fail` is the same refusal without a steer.
  if(text==='steer-orphan'||text==='orphan-fail'){
   await update(client,{sessionUpdate:'tool_call',toolCallId:'toolu_orphan',title:'Terminal',kind:'execute',status:'pending',rawInput:{},_meta:{claudeCode:{toolName:'Bash'}}});
   if(text==='steer-orphan'){const heard=await new Promise(resolve=>{steerWaiter=resolve;release=()=>resolve(null);});release=undefined;
    await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`heard: ${heard}`}});}
   await update(client,{sessionUpdate:'tool_call_update',toolCallId:'toolu_orphan',status:'failed',content:[{type:'content',content:{type:'text',text:'Claude ended the turn without returning a result for this tool.'}}]});
   throw RequestError.internalError({errorKind:'incomplete_tool_call'},'Claude ended the turn without returning results for tool calls: toolu_orphan');
  }
  if(text==='steer-wait'){
   if(scenario==='steering-codex')await threadStatus(client,'active');
   const heard=await new Promise(resolve=>{steerWaiter=resolve;release=()=>resolve(null);});release=undefined;
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:heard===null?'done':`heard: ${heard}`}});
   if(scenario==='steering-codex')await threadStatus(client,'idle');
   return {stopReason:'end_turn'};
  }
  if(text==='fail') throw new Error('Synthetic prompt failure');
  if(text==='exit') process.exit(7);
  if(text==='limit-known'||text==='limit-unknown'||text==='limit-warning') {
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Quota fixture ready'}});
   await new Promise(resolve=>{release=resolve;});release=undefined;
   await update(client,{sessionUpdate:'usage_update',used:1,size:100,_meta:{'_claude/rateLimit':{status:text==='limit-warning'?'allowed_warning':'rejected',rateLimitType:'five_hour',...(text==='limit-unknown'?{}:{resetsAt:(Date.now()+Number(process.env.BRIGADIR_FIXTURE_RESET_MS||1500))/1000})}}});
   if(text!=='limit-warning'){quotaRejected=true;throw new Error('Fixture quota rejection');}
   return {stopReason:'end_turn'};
  }
  // spec/tasks#agent-worktrees: `worktree-add <branch> <path>` — the agent makes a worktree of its own with a shell tool, as Claude's Bash does.
  if(text.startsWith('worktree-add ')){const [,branch,path]=text.split(' ');const command=`git worktree add -q -b ${branch} ${path}`;await update(client,{sessionUpdate:'tool_call',toolCallId:'worktree-add',title:command,kind:'execute',status:'in_progress',rawInput:{command},_meta:{claudeCode:{toolName:'Bash'}}});execFileSync('git',['worktree','add','-q','-b',branch,path],{cwd:process.cwd()});await update(client,{sessionUpdate:'tool_call_update',toolCallId:'worktree-add',status:'completed'});return {stopReason:'end_turn'};}
  if(text==='tool-hold'){await update(client,{sessionUpdate:'tool_call',toolCallId:'edit-live',title:'Edit',kind:'edit',status:'in_progress',locations:[{path:join(process.cwd(),'file.txt')}]});await new Promise(resolve=>{release=resolve;});release=undefined;return {stopReason:'cancelled'};}
  if(text==='hold') { await new Promise(resolve=>{release=resolve;}); return {stopReason:'cancelled'}; }
  // spec/chat-turns-plans-and-questions#question-card: `question markdown` asks in Markdown — emphasis, code and a list, as Claude writes its questions.
  if(text==='question'||text==='question markdown') {
   const config=mcpServers.find(s=>s.name==='brigadir');
   const mcp=new Client({name:'fixture',version:'1.0.0'});
   const stdio=new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...Object.fromEntries(config.env.map(e=>[e.name,e.value]))}});
   const controller=new AbortController(); release=()=>controller.abort();
   try {
    await mcp.connect(stdio);
    const result=await mcp.callTool({name:'ask_user',arguments:{question:text==='question markdown'?'Which **color**? The `providers/Printers/**` zone:\n\n1. Blue\n2. Green':'Which color?',header:'Color',options:[{label:'Blue',description:'Ocean'},{label:'Green',description:'Forest'}],allowsMultiple:true,allowsFreeText:true}},undefined,{signal:controller.signal,timeout:600000});
    await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(result)}});
    return {stopReason:controller.signal.aborted?'cancelled':'end_turn'};
   } catch(e) { if(controller.signal.aborted) return {stopReason:'cancelled'}; throw e; }
   finally { await mcp.close(); release=undefined; }
  }
  await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello '}});
  // spec/chat-turns-plans-and-questions#plan-approval: as claude-agent-acp — EnterPlanMode moves the session to `plan`, ExitPlanMode offers the modes as options and
  // publishes the chosen one. `plan accept-edits` first moves to `acceptEdits`, which has no option while `auto` exists.
  if(planModes&&(text==='plan'||text==='plan accept-edits')){
   const toMode=async mode=>{syncMode(mode);await update(client,{sessionUpdate:'current_mode_update',currentModeId:mode});await update(client,{sessionUpdate:'config_option_update',configOptions:options});};
   if(text==='plan accept-edits')await toMode('acceptEdits');
   await toMode('plan');
   const plan='# Keep the focus ring in Safari\n\n1. Add the `--focus-ring` token.';
   await update(client,{sessionUpdate:'tool_call',toolCallId:'plan-tool',title:'Approve Plan',kind:'switch_mode',status:'pending',content:[{type:'content',content:{type:'text',text:plan}}]});
   const exits={'exit-plan-clear-auto':'auto','exit-plan-auto':'auto','exit-plan-bypass':'bypassPermissions','exit-plan-default':'default'};
   const result=await client.request(methods.client.session.requestPermission,{sessionId:'fixture-session',toolCall:{toolCallId:'plan-tool',title:'Approve Plan',kind:'switch_mode',content:[{type:'content',content:{type:'text',text:plan}}]},
    options:[{optionId:'exit-plan-clear-auto',kind:'allow_always',name:'Yes, clear context (12% used) and use auto mode'},{optionId:'exit-plan-auto',kind:'allow_always',name:'Yes, and use auto mode'},{optionId:'exit-plan-bypass',kind:'allow_always',name:'Yes, and bypass permissions'},{optionId:'exit-plan-default',kind:'allow_once',name:'Yes, manually approve edits'},{optionId:'reject',kind:'reject_once',name:'No, keep planning'}]});
   record('plan-result',result);
   if(result.outcome.outcome==='selected'&&exits[result.outcome.optionId]){await toMode(exits[result.outcome.optionId]);await new Promise(resolve=>setTimeout(resolve,400));await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working on the plan.'}});}
   return {stopReason:'end_turn'};
  }
  // spec/chat-turns-plans-and-questions#plan-approval: a plan for approval, Claude-shaped (plan in the tool content) or Codex-shaped (plan_update, then a request without text).
  if(text==='plan'||text==='plan-codex'||text.startsWith('I did not approve the plan.')||text.startsWith('I edited your plan.')) {
   record('plan-prompt',text);
   const plan='# Keep the focus ring in Safari\n\n## Context\n`Button.module.css` sets `outline: none`.\n\n## Changes\n1. Add the `--focus-ring` token.\n2. Use `:focus-visible` in `Button.module.css`.\n3. Test that Tab keeps the ring.\n\n## Checks\n- `pnpm --filter kit test`\n- Safari: Tab through the story.\n- Firefox: the ring stays.\n- Chrome: the ring stays.';
   const codex=text==='plan-codex';
   if(codex)await update(client,{sessionUpdate:'plan_update',plan:{type:'markdown',planId:'plan-1',content:plan}});
   else await update(client,{sessionUpdate:'tool_call',toolCallId:'plan-tool',title:'Approve Plan',kind:'switch_mode',status:'pending',content:[{type:'content',content:{type:'text',text:plan}}]});
   const result=await client.request(methods.client.session.requestPermission,{sessionId:'fixture-session',toolCall:codex?{toolCallId:'plan-review:plan-1',title:'Implement this plan?',kind:'switch_mode',status:'pending'}:{toolCallId:'plan-tool',title:'Approve Plan',kind:'switch_mode',content:[{type:'content',content:{type:'text',text:plan}}]},
    options:codex?[{optionId:'implement',kind:'allow_once',name:'Yes, implement this plan'},{optionId:'revise',kind:'reject_once',name:'No, and tell Codex what to do differently'}]:[{optionId:'exit-plan-default',kind:'allow_once',name:'Yes, manually approve edits'},{optionId:'exit-plan-auto',kind:'allow_always',name:'Yes, and use auto mode'},{optionId:'reject',kind:'reject_once',name:'No, keep planning'}]});
   record('plan-result',result);
   if(result.outcome.outcome==='selected'&&result.outcome.optionId!=='reject'&&result.outcome.optionId!=='revise'){if(result.outcome.optionId==='exit-plan-auto')await update(client,{sessionUpdate:'current_mode_update',currentModeId:'manual'});await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working on the plan.'}});await update(client,{sessionUpdate:'plan',entries:[{content:'Add the --focus-ring token',priority:'medium',status:'completed'},{content:'Use :focus-visible',priority:'medium',status:'in_progress'}]});}
   return {stopReason:'end_turn'};
  }
  if(text==='permission') {
   await update(client,{sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Write example',kind:'edit',status:'pending'});
   const result=await client.request(methods.client.session.requestPermission,{sessionId:'fixture-session',toolCall:{toolCallId:'tool-1',title:'Write example'},options:[{optionId:'deny',kind:'reject_once',name:'Deny'},{optionId:'allow',kind:'allow_once',name:'Allow'}]});
   record('permission-result',result);
   if(result.outcome.outcome==='cancelled'||result.outcome.optionId==='deny') return {stopReason:'cancelled'};
   await update(client,{sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});
  }
  // spec/chat#subagents: a subagent in its own session, as claude-agent-acp sends it to a client with the `subagents` capability: the SDK
  // schema does not know `subagent_spawned` yet, so those lines go out raw; the child's updates carry its session id.
  if(text==='subagent'){
   const raw=payload=>new Promise(done=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:payload}})+'\n',done));
   const child=(payload)=>client.notify(methods.client.session.update,{sessionId:'child-1',update:{...payload,_meta:{claudeCode:{parentToolUseId:'launch-1'}}}});
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Starting.'}});
   await raw({sessionUpdate:'subagent_spawned',subagentSessionId:'child-1',name:'List files',task:'Run ls',prompt:'Run ls and answer with the list.',capabilities:{}});
   await child({sessionUpdate:'tool_call',toolCallId:'child-tool',title:'ls',kind:'execute',status:'pending'});
   const permission=await client.request(methods.client.session.requestPermission,{sessionId:'child-1',toolCall:{toolCallId:'child-tool',title:'ls'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]});record('child-permission',permission);
   await child({sessionUpdate:'tool_call_update',toolCallId:'child-tool',status:'completed'});
   await child({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'README.md'}});
   await client.notify(methods.client.session.update,{sessionId:'unknown-child',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'stray'}}});
   await raw({sessionUpdate:'subagent_state_update',subagentSessionId:'child-1',state:'completed'});
   await update(client,{sessionUpdate:'tool_call_update',toolCallId:'launch-1',_meta:{claudeCode:{toolName:'Agent',toolResponse:{status:'completed',agentId:'child-1',agentType:'general-purpose',resolvedModel:'claude-opus-5-5',totalDurationMs:10556,totalTokens:34269}}}});
  }
  await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'world'}});
  return {stopReason:'end_turn'};
 })
 .connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
await connection.closed;

// spec/chat-turns-plans-and-questions#agent-started-turns: our turn starts a background command and ends; the agent's own turn follows once the command is done.
// `BRIGADIR_FIXTURE_AGENT_TURN_GATE`: that turn waits for the file, which a test writes once it is ready, instead of a delay.
// `BRIGADIR_FIXTURE_AGENT_TURN_HOLD=1`: the turn waits before its end for a prompt (joins the turn) or Stop.
async function backgroundTurn(client){
 const send=message=>client.notify(message.method,message.params);
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const codex=scenario==='agent-turn-codex';
 if(codex){
  await threadStatus(client,'active');await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'STARTED'}});await threadStatus(client,'idle');
 }else{
  const items=recorded(),answer=items.findIndex(item=>'id' in item.message);
  for(const item of items.slice(0,answer))await send(item.message);
 }
 void (async()=>{
  await pause(10);
  const items=recorded(),answer=items.findIndex(item=>'id' in item.message);
  if(!codex)for(const item of items.slice(answer+1).filter(item=>item.t<10))await send(item.message);
  const gate=process.env.BRIGADIR_FIXTURE_AGENT_TURN_GATE;
  const quick=scenario==='agent-turn-quick';
  if(gate)await new Promise(resolve=>{const poll=setInterval(()=>{if(existsSync(gate)){clearInterval(poll);resolve();}},20);});else await pause(quick?50:150);
  record('agent-turn',{});
  const own=items.filter(item=>item.t>=10),end=own.findIndex(item=>item.message.params?.message?.type==='result');
  if(codex){await threadStatus(client,'active');await update(client,{sessionUpdate:'tool_call',toolCallId:'codex-own',title:'echo FOLLOWUP-ONE',kind:'execute',status:'completed'});await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Codex followup.'}});}
  else for(const item of own.slice(0,end))await send(item.message);
  const idle={jsonrpc:'2.0',method:'_claude/sdkMessage',params:{sessionId:'fixture-session',message:{type:'system',subtype:'session_state_changed',state:'idle'}}};
  const result=(subtype,extra={})=>send({jsonrpc:'2.0',method:'_claude/sdkMessage',params:{sessionId:'fixture-session',message:{type:'result',subtype,origin:{kind:'task-notification'},num_turns:3,...extra}}});
  const close=()=>codex?threadStatus(client,'idle'):send(idle);
  if(process.env.BRIGADIR_FIXTURE_AGENT_TURN_HOLD==='1'){
   // `DEAF=1`: Stop never reaches the turn, so only the transport's own timer can end it.
   const next=await new Promise(resolve=>{agentHold=resolve;release=()=>{if(process.env.BRIGADIR_FIXTURE_AGENT_TURN_DEAF!=='1')resolve(null);};});agentHold=null;release=undefined;
   if(next===null){record('agent-turn-cancel',{});await result('error_during_execution');await close();return;}
   record('agent-turn-fold',{text:next.text});
   await update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`heard: ${next.text}`}});
   await result('success',{user_message_uuids:['fold']});next.answer({stopReason:'end_turn'});await pause(10);await close();return;
  }
  if(codex){await close();return;}
  for(const item of own.slice(end))await send(item.message);
  if(quick&&process.env.BRIGADIR_FIXTURE_AGENT_TURN_TWICE==='1'){await pause(50);record('agent-turn',{});for(const item of own)await send(item.message);}
 })();
 return {stopReason:'end_turn'};
}
// spec/composer-steering-queue-and-ghost#quick-question: a quick question. The last `Question:` line picks the behaviour: `hold` streams and waits for Stop, `permission`
// asks before an edit, `edit` changes the first selected line, `suggest` answers with a ```replace block, else a streamed answer.
async function quickQuestion(text,client){
 const question=(/(?:^|\n)Question: (.*)$/.exec(text)??/\): (.*)$/.exec(text))?.[1]??'';
 const where=/File: (\S+?)(?: \(|, selected lines )[^\n]*?(\d+)-(\d+)/.exec(text)??/same lines (\S+):(\d+)-(\d+)/.exec(text);
 const path=where?.[1]??'',start=Number(where?.[2]??1),full=join(process.cwd(),path);
 record('quick',{question,path,start,cwd:process.cwd(),readOnly:/Do not change any files/.test(text),context:/The task's first request/.test(text)});
 if(question==='quota retry' && options.find(option=>option.id==='model')?.currentValue!=='other'){await update(client,{sessionUpdate:'usage_update',used:1,size:100,_meta:{'_claude/rateLimit':{status:'rejected',rateLimitType:'five_hour',resetsAt:Math.round(Date.now()/1000)+48*60}}});throw new Error('Fixture subscription limit');}
 const say=chunk=>update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:chunk}});
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 if(/hold/.test(question)){await say('Thinking about ');await new Promise(resolve=>{release=resolve;});release=undefined;return {stopReason:'cancelled'};}
 if(/edit|permission/.test(question)){
  await update(client,{sessionUpdate:'tool_call',toolCallId:'quick-edit',title:`Edit ${path}`,kind:'edit',status:'pending',locations:[{path:full}]});
  if(/permission/.test(question)){
   const answer=await client.request(methods.client.session.requestPermission,{sessionId:'fixture-session',toolCall:{toolCallId:'quick-edit',title:`Edit ${path}`,kind:'edit',status:'pending',locations:[{path:full}]},options:[{optionId:'deny',kind:'reject_once',name:'Deny'},{optionId:'allow',kind:'allow_once',name:'Allow'}]});
   record('permission-result',answer);
   if(answer.outcome?.outcome!=='selected'||answer.outcome.optionId!=='allow'){await update(client,{sessionUpdate:'tool_call_update',toolCallId:'quick-edit',status:'failed'});await say('Not changed.');return {stopReason:'end_turn'};}
  }
  const {readFileSync}=await import('node:fs');const lines=readFileSync(full,'utf8').split('\n');lines[start-1]=`${lines[start-1]} // quick`;writeFileSync(full,lines.join('\n'));
  await update(client,{sessionUpdate:'tool_call_update',toolCallId:'quick-edit',status:'completed',content:[{type:'diff',path:full,oldText:null,newText:''}]});
  await say(`Changed line ${start} of ${path}.`);return {stopReason:'end_turn'};
 }
 if(/suggest/.test(question)){await say('Shorter:\n\n```replace '+start+'-'+start+'\nconst quick = true;\n```\n');return {stopReason:'end_turn'};}
 await say('Quick ');await pause(700);await say('answer ');await pause(400);await say(`about ${path}:${start}.`);return {stopReason:'end_turn'};
}
// spec/chat-turns-plans-and-questions#background-commands: background commands on the wire of a raw SDK run (claude-background.jsonl):
// the prompt's part, its answer, then the command's end and the turn Claude begins on its own. `background-live` runs a real
// command in its own process group writing its output file, as Claude Code does, so Stop has a process to stop.
async function backgroundScenario(client){
 const notify=message=>client.notify(message.method,message.params);
 if(scenario==='background-live'){
  const {spawn}=await import('node:child_process');const {mkdirSync:mkdir}=await import('node:fs');
  const dir=join(process.cwd(),'tasks');mkdir(dir,{recursive:true});const path=join(dir,'blive.output');
  const sdk=message=>notify({method:'_claude/sdkMessage',params:{sessionId:'fixture-session',message}});
  await sdk({type:'system',subtype:'task_started',task_id:'blive',tool_use_id:'toolu_live',description:'Wait five minutes',is_backgrounded:true,task_type:'local_bash'});
  const child=spawn('/bin/sh',['-c',`exec >${JSON.stringify(path)} 2>&1; echo begin; sleep 300; echo end`],{detached:true,stdio:'ignore'});record('background-pid',{pid:child.pid});
  child.once('exit',()=>{void sdk({type:'system',subtype:'task_notification',task_id:'blive',tool_use_id:'toolu_live',status:'failed',output_file:path});});
  await update(client,{sessionUpdate:'tool_call',toolCallId:'toolu_live',title:'sleep 300',kind:'execute',status:'pending',_meta:{claudeCode:{toolName:'Bash'}}});
  await update(client,{sessionUpdate:'tool_call_update',toolCallId:'toolu_live',status:'completed',rawOutput:`Command running in background with ID: blive. Output is being written to: ${path}. You will be notified when it completes.`,content:[{type:'content',content:{type:'text',text:`Command running in background with ID: blive. Output is being written to: ${path}.`}}]});
  return {stopReason:'end_turn'};
 }
 const items=readFileSync(new URL('./claude-background.jsonl',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.scenario===scenario);
 const answer=items.findIndex(item=>item.message.id==='PROMPT');
 for(const item of items.slice(0,answer))await notify(item.message);
 // The rest after the turn, with the recorded gaps capped at 150 ms: the command's end, then the turn Claude begins itself.
 setTimeout(()=>{void (async()=>{let at=items[answer].t;for(const item of items.slice(answer+1)){await new Promise(resolve=>setTimeout(resolve,Math.min(150,Math.max(0,(item.t-at)*1000))));at=item.t;await notify(item.message);}})();},300);
 return items[answer].message.result;
}
// spec/notifications-slack-notes-and-schedules#notes: the note chat's agent. The file comes from the prompt; `edit` asks permission, then appends a line to the note.
async function noteChat(text,client){
 const message=text.split('\nThe person writes:\n').at(-1)??'',file=(/the file (\S+)\. /.exec(text)??/The same note, (\S+)\./.exec(text))?.[1]??'';
 record('note-chat',{message,file,cwd:process.cwd(),first:text.startsWith('You are chatting')});
 const say=chunk=>update(client,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:chunk}});
 if(/edit/.test(message)&&file){
  const tool={toolCallId:'note-edit',title:`Edit ${file.split('/').at(-1)}`,kind:'edit',status:'pending',locations:[{path:file}]};
  await update(client,{sessionUpdate:'tool_call',...tool});
  const answer=await client.request(methods.client.session.requestPermission,{sessionId:'fixture-session',toolCall:tool,options:[{optionId:'deny',kind:'reject_once',name:'Deny'},{optionId:'allow',kind:'allow_once',name:'Allow'}]});
  if(answer.outcome?.outcome!=='selected'||answer.outcome.optionId!=='allow'){await update(client,{sessionUpdate:'tool_call_update',toolCallId:'note-edit',status:'failed'});await say('Not changed.');return {stopReason:'end_turn'};}
  const {readFileSync:read}=await import('node:fs');writeFileSync(file,read(file,'utf8').replace(/\n?$/,'\n- Перевірити ще на Android\n'));
  await update(client,{sessionUpdate:'tool_call_update',toolCallId:'note-edit',status:'completed',content:[{type:'diff',path:file,oldText:null,newText:''}]});
  await say('Дописав у нотатку, що перевірити ще на Android.');return {stopReason:'end_turn'};
 }
 await say('Два місця незрозумілі: ');await new Promise(resolve=>setTimeout(resolve,200));await say('L5 не каже, на якому екрані кнопка «Далі»; L6-7 — чи пробіл ламає лише email.');
 return {stopReason:'end_turn'};
}
