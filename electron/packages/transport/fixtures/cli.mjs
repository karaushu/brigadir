import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const relay=process.argv[2],args=process.argv.slice(3);
const resume=args.indexOf('--resume')>=0?args[args.indexOf('--resume')+1]:args.includes('resume')?args.at(-1):null;
const session=resume||'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';let turn=0;let tail=Promise.resolve();
function hook(name,fields={}){return new Promise((resolve,reject)=>{const child=relay.endsWith('.zsh')?spawn('/bin/zsh',['-f',relay],{env:process.env,stdio:['pipe','pipe','pipe']}):spawn(process.execPath,[relay],{env:process.env,stdio:['pipe','pipe','pipe']});let error='',output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('exit',code=>{if(code!==0){reject(new Error(error));return;}if(output)void writeFile('hook-context.json',output).then(resolve,reject);else resolve();});child.stdin.end(JSON.stringify({session_id:session,hook_event_name:name,...fields}));});}
async function prompt(finish){
  await hook('UserPromptSubmit',{prompt:`Fixture turn ${++turn}\nSecond line must stay out of journal`,turn_id:`${resume?'resume':'first'}-${turn}`});
  await hook('PreToolUse',{tool_name:'Write',tool_use_id:`tool-${turn}`});await writeFile('cli.txt',`CLI turn ${turn}\n`);await hook('PostToolUse',{tool_name:'Write',tool_use_id:`tool-${turn}`,tool_response:'Private tool output'});
  if(finish)await hook('Stop');
}
process.stdin.setRawMode?.(true);process.stdin.resume();
process.stdin.on('data',data=>{tail=tail.then(async()=>{for(const c of data.toString()){if(c==='n')await prompt(false);if(c==='\x03'&&!args.includes('--settings'))await hook('Interrupt');if(c==='q'){await hook('SessionEnd');process.exit(0);}}}).catch(error=>{process.stderr.write(String(error));process.exit(1);});});
await hook('SessionStart');if(!resume)await prompt(true);process.stdout.write(`CLI_READY ${resume?'resumed':'new'}\r\n`);
