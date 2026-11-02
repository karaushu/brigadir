// spec/pull-requests-and-ci#ci: GitHub Actions in GitHub's own REST shapes for the `gh` fixture (`state.actions`).
// A typical case: Staging Pipeline on the merge commit of a PR — build, test, deploy-staging.
const minute=60_000;
const at=offset=>new Date(Date.now()+offset).toISOString();
const steps=['Set up job','Checkout','Configure AWS credentials','Build image','Push to ECR','Deploy to ECS','Wait for service stability','Complete job'];

/** kind: `run` — step 5 is going; `pass` — all done and deployed; `fail` — step 6 failed. */
export function stagingActions(sha,{kind='run',runId=1068,jobId=9003,repo,actor='me'}={}){
  const done=kind!=='run',link=`https://github.com/fixture/repo/actions/runs/${runId}`;
  const step=(name,index)=>{const number=index+1;
    if(kind==='run'&&number===5)return {name,number,status:'in_progress',conclusion:null,started_at:at(-24_000),completed_at:null};
    if(kind==='run'&&number>5)return {name,number,status:'queued',conclusion:null,started_at:null,completed_at:null};
    if(kind==='fail'&&number===6)return {name,number,status:'completed',conclusion:'failure',started_at:at(-60_000),completed_at:at(-12_000)};
    if(kind==='fail'&&number===7)return {name,number,status:'completed',conclusion:'skipped',started_at:null,completed_at:null};
    return {name,number,status:'completed',conclusion:'success',started_at:at(-3*minute),completed_at:at(-3*minute+2_000)};};
  const job=(id,name,status,conclusion,list=[])=>({id,name,status,conclusion,started_at:at(-6*minute),completed_at:status==='completed'?at(-minute):null,html_url:`${link}/job/${id}`,steps:list});
  const deployConclusion=kind==='pass'?'success':kind==='fail'?'failure':null;
  return {
    runs:[{id:runId,name:'Staging Pipeline',run_number:runId,display_title:'Merge pull request #421 from fixture/feat/loyalty-admin',head_branch:'staging',head_sha:sha,actor:{login:actor},status:done?'completed':'in_progress',conclusion:kind==='pass'?'success':kind==='fail'?'failure':null,created_at:at(-7*minute),run_started_at:at(-7*minute),updated_at:at(-minute),html_url:link,...(repo?{repo}:{})},
      {id:runId-2,name:'CI/CD Pipeline',run_number:2210,display_title:'feat(orders): export to CSV',head_branch:'feat/orders-csv',head_sha:'c'.repeat(40),actor:{login:'mkovalenko'},status:'completed',conclusion:'success',created_at:at(-90*minute),run_started_at:at(-90*minute),updated_at:at(-84*minute),html_url:`https://github.com/fixture/repo/actions/runs/${runId-2}`,...(repo?{repo}:{})}],
    jobs:{[runId]:[job(jobId-2,'build','completed','success'),job(jobId-1,'test','completed','success'),job(jobId,'deploy-staging',done?'completed':'in_progress',deployConclusion,steps.map(step))]},
    deployments:[{id:77,sha,environment:'staging',created_at:at(-2*minute)}],
    statuses:{77:[{state:kind==='pass'?'success':kind==='fail'?'failure':'in_progress',environment:'staging',environment_url:kind==='pass'?'https://admin.staging.example.com':'',log_url:`${link}/job/${jobId}`}]},
    annotations:{[jobId]:kind==='fail'?[{annotation_level:'failure',message:'ECS service choice-admin-staging did not stabilize: 0/2 tasks running'}]:[]},
  };
}
