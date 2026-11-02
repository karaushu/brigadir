import {readFile,writeFile,appendFile} from 'node:fs/promises';
const file=process.env.BRIGADIR_TEST_GH_STATE,args=process.argv.slice(2),state=JSON.parse(await readFile(file,'utf8'));
await appendFile(`${file}.log`,JSON.stringify(args)+'\n');
const output=(value,code=0,stderr='')=>{if(value!==undefined)process.stdout.write(typeof value==='string'?value:JSON.stringify(value));if(stderr)process.stderr.write(stderr);process.exitCode=code;};
const option=name=>args[args.indexOf(name)+1];
// spec/pull-requests-and-ci#pr-panel: compact PR fixtures expand to the GraphQL shape the app reads.
const person=name=>({login:name});
const node=pr=>({id:`PR_${pr.number}`,number:pr.number,title:pr.title,url:`https://github.com/fixture/repo/pull/${pr.number}`,state:pr.state??'OPEN',isDraft:pr.isDraft===true,author:person(pr.author??'octo'),headRefName:pr.head??`feature-${pr.number}`,baseRefName:pr.base??'main',updatedAt:pr.updatedAt??new Date().toISOString(),closedAt:pr.closedAt??null,mergedAt:pr.state==='MERGED'?pr.closedAt??null:null,reviewDecision:pr.reviewDecision??null,totalCommentsCount:pr.comments??0,
 reviewRequests:{nodes:(pr.requested??[]).map(name=>({requestedReviewer:person(name)}))},latestReviews:{nodes:(pr.reviews??[]).map(review=>({author:person(review.author),state:review.state}))},commits:{nodes:[{commit:{statusCheckRollup:pr.checks?{state:pr.checks}:null}}]},
 body:pr.body??'',createdAt:pr.createdAt??pr.updatedAt??new Date().toISOString(),headRefOid:pr.headSha??'0'.repeat(40),mergeCommit:pr.mergeSha?{oid:pr.mergeSha}:null,additions:pr.additions??0,deletions:pr.deletions??0,mergeStateStatus:pr.mergeState??'BLOCKED',mergeable:pr.mergeable??'MERGEABLE',maintainerCanModify:pr.maintainerCanModify!==false,isCrossRepository:pr.cross===true,baseRef:{branchProtectionRule:pr.approvals===undefined?null:{requiredApprovingReviewCount:pr.approvals}},
 reviewThreads:{nodes:(pr.threads??[]).map((thread,index)=>({id:thread.id??`T${pr.number}-${index}`,path:thread.path,line:thread.line??null,startLine:thread.startLine??null,diffSide:thread.side??'RIGHT',isResolved:thread.resolved===true,isOutdated:thread.outdated===true,comments:{nodes:thread.comments.map((comment,at)=>({diffHunk:thread.hunk??null,id:`C${pr.number}-${index}-${at}`,databaseId:1000*pr.number+10*index+at,author:person(comment.author),body:comment.body,createdAt:comment.at??new Date().toISOString(),url:`https://github.com/fixture/repo/pull/${pr.number}#discussion_r${1000*pr.number+10*index+at}`}))}}))},
 comments:{nodes:(pr.issueComments??[]).map((comment,index)=>({id:`IC${pr.number}-${index}`,author:person(comment.author),body:comment.body,createdAt:comment.at??new Date().toISOString(),url:`https://github.com/fixture/repo/pull/${pr.number}#issuecomment-${index+1}`}))},
 reviews:{nodes:(pr.reviews??[]).map((review,index)=>({id:`R${pr.number}-${index}`,author:person(review.author),state:review.state,body:review.body??'',submittedAt:review.at??new Date().toISOString()}))},
 files:{nodes:(pr.files??[]).map(file=>({path:file.path,additions:file.additions??0,deletions:file.deletions??0,changeType:file.change??'MODIFIED',viewerViewedState:file.viewed?'VIEWED':'UNVIEWED'}))},
 allCommits:{nodes:(pr.commitList??[]).map(commit=>({commit:{oid:commit.sha,messageHeadline:commit.subject,authoredDate:commit.at??new Date().toISOString(),author:{name:commit.author??'octo',user:person(commit.author??'octo')}}}))},
 lastCommit:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:(pr.checkRuns??[]).map(run=>({__typename:'CheckRun',name:run.name,status:run.status??'COMPLETED',conclusion:run.conclusion??'SUCCESS',detailsUrl:run.link??'https://github.com/fixture/repo/actions/runs/1',startedAt:run.startedAt??null,completedAt:run.completedAt??null,checkSuite:{workflowRun:{workflow:{name:run.workflow??'CI'}}}}))}}}}]}});

// spec/pull-requests-and-ci#review-modal: writes are recorded in the state file; `writeError` fails them the way GitHub does.
const write=async()=>{let body='';if(args.includes('--input'))for await(const chunk of process.stdin)body+=chunk.toString();const method=option('--method'),path=args[3];
 if(state.writeError)return output('',1,state.writeError);
 state.writes=[...(state.writes??[]),{method,path,body:body?JSON.parse(body):null}];
 const merge=/pulls\/(\d+)\/merge$/.exec(path);if(merge){const pr=(state.pullRequests??[]).find(item=>item.number===Number(merge[1]));if(pr){pr.state='MERGED';pr.closedAt=new Date().toISOString();}}
 await writeFile(file,JSON.stringify(state));output({});};
const mutation=async()=>{const query=args[args.indexOf('-f')+1]??'',thread=args.find(arg=>arg.startsWith('thread='))?.slice(7);
 // spec/pull-requests-and-ci#pr-files: «Viewed» can be slow (`viewedDelay` ms) or fail (`viewedError`); a saved mark stays in the PR files.
 const viewed=/(un)?markFileAsViewed\(/.exec(query);if(viewed&&state.viewedDelay){await new Promise(resolve=>setTimeout(resolve,state.viewedDelay));Object.assign(state,JSON.parse(await readFile(file,'utf8')));}
 if(viewed&&state.viewedError)return output('',1,state.viewedError);
 if(state.writeError)return output('',1,state.writeError);
 if(viewed){const id=args.find(arg=>arg.startsWith('pr='))?.slice(3),path=args.find(arg=>arg.startsWith('path='))?.slice(5);for(const pr of state.pullRequests??[])if(`PR_${pr.number}`===id)for(const file of pr.files??[])if(file.path===path)file.viewed=!viewed[1];}
 // spec/pull-requests-and-ci#merge-card: «Ready for review» takes the PR out of draft.
 if(/markPullRequestReadyForReview\(/.test(query)){const id=args.find(arg=>arg.startsWith('pr='))?.slice(3);for(const pr of state.pullRequests??[])if(`PR_${pr.number}`===id)pr.isDraft=false;}
 for(const pr of state.pullRequests??[])(pr.threads??[]).forEach((item,index)=>{if((item.id??`T${pr.number}-${index}`)===thread)item.resolved=query.includes('resolveReviewThread(')&&!query.includes('unresolve');});
 state.writes=[...(state.writes??[]),{mutation:query.slice(0,200),args:args.slice(4)}];await writeFile(file,JSON.stringify(state));output({data:{}});};
// spec/pull-requests-and-ci#reading-and-refresh: reads can be slow (`graphqlDelay` ms), so a test sees the refresh glyph turn while it reads.
const graphql=async()=>{if(state.graphqlDelay)await new Promise(resolve=>setTimeout(resolve,state.graphqlDelay));const query=args[args.indexOf('-f')+1]??'',name=args.find(arg=>arg.startsWith('name='))?.slice(5),prs=(state.pullRequests??[]).filter(pr=>!pr.repo||pr.repo===name),repo={viewerPermission:state.permission??'WRITE',mergeCommitAllowed:true,squashMergeAllowed:true,rebaseMergeAllowed:false,viewerDefaultMergeMethod:'SQUASH'};
 if(state.graphqlError)return output('',1,'Fixture GitHub network error');
 if(query.includes('query=query($owner:String!,$name:String!,$number:Int!)')){const number=Number(args.find(arg=>arg.startsWith('number='))?.slice(7)),pr=prs.find(item=>item.number===number);return output({data:{viewer:person(state.viewer??'me'),repository:{...repo,pullRequest:pr?node(pr):null}}});}
 output({data:{viewer:person(state.viewer??'me'),repository:{open:{nodes:prs.filter(pr=>(pr.state??'OPEN')==='OPEN').map(node)},closed:{nodes:prs.filter(pr=>pr.state==='CLOSED'||pr.state==='MERGED').map(node)}}}});};

// spec/pull-requests-and-ci#ci: REST reads of GitHub Actions; `state.actions` holds GitHub's own shapes ({runs, jobs:{id}, deployments, statuses:{id}, annotations:{id}}).
const rest=()=>{const [path,query='']=args[1].split('?'),params=new URLSearchParams(query),actions=state.actions??{};let match;
 if(state.actionsError)return output('',1,'Fixture GitHub network error');
 if(path==='user')return output(person(state.viewer??'me'));
 if((match=/^repos\/[^/]+\/([^/]+)\/actions\/runs$/.exec(path))){if(actions.disabled)return output({message:'Not Found'},1,'gh: Not Found (HTTP 404)');const runs=(actions.runs??[]).filter(run=>(!run.repo||run.repo===match[1])&&(!params.get('head_sha')||run.head_sha===params.get('head_sha'))&&(!params.get('branch')||run.head_branch===params.get('branch')));return output({total_count:runs.length,workflow_runs:runs});}
 if((match=/actions\/runs\/(\d+)\/jobs$/.exec(path)))return output({jobs:actions.jobs?.[match[1]]??[]});
 if((match=/actions\/runs\/(\d+)$/.exec(path))){const run=(actions.runs??[]).find(item=>String(item.id)===match[1]);return run?output(run):output({message:'Not Found'},1,'gh: Not Found (HTTP 404)');}
 if((match=/deployments\/(\d+)\/statuses$/.exec(path)))return output(actions.statuses?.[match[1]]??[]);
 if(/deployments$/.test(path))return output((actions.deployments??[]).filter(item=>!params.get('sha')||item.sha===params.get('sha')));
 if((match=/check-runs\/(\d+)\/annotations$/.exec(path)))return output(actions.annotations?.[match[1]]??[]);
 output({message:'Not Found'},1,'gh: Not Found (HTTP 404)');};

if(args[0]==='auth')output('',state.auth==='login'?1:0,state.auth==='login'?'You are not logged into any GitHub hosts.':'');
else if(args[0]==='api'&&args[1]==='graphql'&&(args[args.indexOf('-f')+1]??'').startsWith('query=mutation'))await mutation();
else if(args[0]==='api'&&args[1]==='graphql')await graphql();
else if(args[0]==='api'&&args[1]==='--method')await write();
else if(args[0]==='api'&&args.length===2)rest();
else if(args[0]==='repo'){const name=state.repoNames?process.cwd().split('/').at(-1):'repo';output({nameWithOwner:`fixture/${name}`,url:`https://github.com/fixture/${name}`,defaultBranchRef:{name:'main'}});}
else if(args[1]==='list')output((state.prs??[]).filter(pr=>pr.headRefName===option('--head')));
else if(args[1]==='view')output({...state.prs.find(pr=>String(pr.number)===args[2]),mergeable:state.mergeable??'MERGEABLE'});
else if(args[1]==='checks'){if(state.checksError)output('',1,'Fixture GitHub network error');else if(state.noChecks)output('',1,'no checks reported on this branch');else output(state.checks??[],(state.checks??[]).some(check=>check.bucket==='pending')?8:0);}
else if(args[1]==='create'){let body='';for await(const chunk of process.stdin)body+=chunk.toString();if(state.createError)output('',1,'Fixture PR creation failed');else{const pr={number:(state.prs?.length??0)+12,url:`${option('--repo')??'https://github.com/fixture/repo'}/pull/${(state.prs?.length??0)+12}`,title:option('--title'),headRefName:option('--head'),baseRefName:option('--base'),state:'OPEN'};state.prs=[...(state.prs??[]),pr];state.body=body;await writeFile(file,JSON.stringify(state));output(args.includes('--web')?'':pr.url);}}
else output('',1,'Unexpected fixture command');
