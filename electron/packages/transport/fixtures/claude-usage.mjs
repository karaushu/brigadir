// spec/agents-and-providers#quota-sources: the unmodified `claude -p /usage` and `claude auth status --json`,
// reduced from a live run (CLI 2.1.310). The first argument is the scenario.
const scenario=process.argv[2],args=process.argv.slice(3);
const line=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(args.join(' ')==='auth status --json'){line({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'someone@example.com',subscriptionType:'team'});process.exit(0);}
if(args.join(' ')!=='-p /usage --output-format stream-json --verbose --no-session-persistence')process.exit(2);
if(scenario==='hang')setInterval(()=>{},1000);
else{
 line({type:'system',subtype:'init',apiKeySource:scenario==='api-key'?'ANTHROPIC_API_KEY':'none',claude_code_version:'2.1.310'});
 line({type:'assistant',message:{model:'<synthetic>',role:'assistant',content:[{type:'text',text:'## Usage'}]},usage_report:scenario==='usage-null'?null:{session:{},rate_limits:{limits:[
  {kind:'session',group:'session',percent:13,resets_at:'2026-09-24T12:19:59.734075+00:00',scope:null,severity:'normal',is_active:false},
  {kind:'weekly_all',group:'weekly',percent:28,resets_at:'2026-09-29T13:59:59.734101+00:00',scope:null,severity:'normal',is_active:true},
  {kind:'weekly_scoped',group:'weekly',percent:0,resets_at:'2026-09-29T13:59:59.734307+00:00',scope:{model:{display_name:'Fable'},surface:null},severity:'normal',is_active:false}]}}});
 line({type:'result',subtype:'success',num_turns:0,total_cost_usd:0});
}
