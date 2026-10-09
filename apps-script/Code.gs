/* TaskFlow / Spark-compatible notification worker. No public web endpoint. */
function config_() {
  const p=PropertiesService.getScriptProperties();
  const c={project:p.getProperty('FIREBASE_PROJECT_ID'),token:p.getProperty('CHATWORK_API_TOKEN'),
    staffRoom:p.getProperty('CHATWORK_STAFF_ROOM'),adminRoom:p.getProperty('CHATWORK_ADMIN_ROOM'),
    staffTo:p.getProperty('CHATWORK_STAFF_ACCOUNT')||'',adminTo:p.getProperty('CHATWORK_ADMIN_ACCOUNT')||'',
    url:p.getProperty('TASKFLOW_URL')||'https://hirose-debug.github.io/taskflow/',days:Number(p.getProperty('ARCHIVE_DAYS')||7)};
  if(!/^[a-z0-9-]+$/.test(c.project||'') || !c.token || !/^\d+$/.test(c.staffRoom||'') || !/^\d+$/.test(c.adminRoom||''))
    throw Error('Set FIREBASE_PROJECT_ID, CHATWORK_API_TOKEN, CHATWORK_STAFF_ROOM and CHATWORK_ADMIN_ROOM in Script Properties.');
  if(!Number.isInteger(c.days)||c.days<1)throw Error('ARCHIVE_DAYS must be a positive integer');
  if(!/^https:\/\//.test(c.url))throw Error('TASKFLOW_URL must use HTTPS');
  return c;
}
function firestore_(c,path,method,payload) {
  const response=UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/'+c.project+'/databases/(default)/documents'+path,{
    method:method||'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},
    contentType:'application/json',payload:payload?JSON.stringify(payload):undefined,muteHttpExceptions:true});
  const code=response.getResponseCode();
  if(code===404)return null;
  if(code<200||code>=300)throw Error('Firestore HTTP '+code);
  return JSON.parse(response.getContentText());
}
function decode_(doc) {
  const out={id:doc.name.split('/').pop(),updateTime:doc.updateTime};
  Object.keys(doc.fields||{}).forEach(k=>{
    const v=doc.fields[k];out[k]=v.stringValue!==undefined?v.stringValue:v.booleanValue!==undefined?v.booleanValue:v.timestampValue||null;
  });return out;
}
function query_(c,field,op,value) {
  return (firestore_(c,':runQuery','post',{structuredQuery:{from:[{collectionId:'tasks'}],where:{fieldFilter:{field:{fieldPath:field},op:op,value:value}}}})||[])
    .filter(r=>r.document).map(r=>decode_(r.document));
}
function eventKey_(id,kind,stamp) {
  return 'event_'+Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,id+'|'+kind+'|'+stamp)
    .map(x=>('0'+(x&255).toString(16)).slice(-2)).join('');
}
function eventsFor_(task,start) {
  if(task.archived)return [];
  const events=[];
  if(Date.parse(task.createdAt)>=start && task.assignee && task.assignee!=='管理者' && task.status!=='done')
    events.push({id:task.id,kind:task.urgent?'urgent':'digest',stamp:task.createdAt});
  if(task.status==='done' && Date.parse(task.completedAt)>=start)
    events.push({id:task.id,kind:'completed',stamp:task.completedAt});
  return events;
}
function slot_(now) {
  const date=Utilities.formatDate(now,'Asia/Tokyo','yyyy-MM-dd');
  const hour=Number(Utilities.formatDate(now,'Asia/Tokyo','H'));
  return hour>=17?date+'-17':hour>=9?date+'-09':null;
}
function shouldArchive_(task,now,days) {
  const completed=Date.parse(task.completedAt);
  return task.status==='done' && !task.archived && Number.isFinite(completed) &&
    Math.max(completed,Date.parse(task.archiveRestoredAt)||0)<=now-days*86400000;
}
function message_(tasks,kind,c) {
  const clean=s=>String(s||'').replace(/[\[\]]/g,' ').slice(0,1000);
  const to=kind==='completed'?c.adminTo:c.staffTo;
  const title={digest:'新しい依頼のまとめ',urgent:'急ぎの依頼',completed:'作業完了の報告'}[kind];
  return (/^\d+$/.test(to)?'[To:'+to+']\n':'')+'【TaskFlow：'+title+'】\n'+tasks.map(t=>
    clean(t.content)+'\n担当：'+clean(t.assignee)+'　期限：'+(clean(t.deadline)||'指定なし')+'\n'+c.url+'#task='+encodeURIComponent(t.id)).join('\n\n');
}

// Run once manually after entering configuration. Existing tasks are not announced.
function installTaskFlow() {
  const c=config_(),p=PropertiesService.getScriptProperties();
  query_(c,'updatedAt','GREATER_THAN_OR_EQUAL',{timestampValue:new Date().toISOString()});
  if(!p.getProperty('START_AT'))p.setProperties({START_AT:new Date().toISOString(),CURSOR:new Date().toISOString(),LAST_SLOT:slot_(new Date())||''});
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='taskFlowTick').forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('taskFlowTick').timeBased().everyMinutes(1).create();
  console.log('Installed. No Chatwork messages sent during installation.');
}
function stopTaskFlow() {
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='taskFlowTick').forEach(t=>ScriptApp.deleteTrigger(t));
}
function taskFlowTick() {
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    const c=config_(),p=PropertiesService.getScriptProperties(),now=new Date(),start=Date.parse(p.getProperty('START_AT'));
    if(!Number.isFinite(start))throw Error('Run installTaskFlow first');
    const cursor=Date.parse(p.getProperty('CURSOR'))||start;
    const changed=query_(c,'updatedAt','GREATER_THAN_OR_EQUAL',{timestampValue:new Date(Math.max(start,cursor-120000)).toISOString()});
    changed.forEach(task=>eventsFor_(task,Math.max(start,cursor-120000)).forEach(event=>{
      const key=eventKey_(event.id,event.kind,event.stamp);
      if(!p.getProperty(key))p.setProperty(key,JSON.stringify(Object.assign(event,{state:event.kind==='digest'?'waiting':'ready',at:now.getTime()})));
    }));
    // Advance only after all events have been durably queued. Overlap handles late writes.
    p.setProperty('CURSOR',now.toISOString());
    const slot=slot_(now),props=p.getProperties();
    if(slot && slot!==p.getProperty('LAST_SLOT')) {
      Object.keys(props).filter(k=>k.startsWith('event_')).forEach(k=>{
        const e=JSON.parse(props[k]);if(e.state==='waiting'){e.state='ready';p.setProperty(k,JSON.stringify(e));}
      });p.setProperty('LAST_SLOT',slot);
    }
    sendReady_(c,p,now);
    archiveDaily_(c,p,now);
    p.setProperty('LAST_SUCCESS',now.toISOString());
    p.deleteProperty('LAST_ERROR');
  } catch(error) {
    PropertiesService.getScriptProperties().setProperty('LAST_ERROR',new Date().toISOString()+' '+error.message);
    throw error;
  } finally {lock.releaseLock();}
}
function sendReady_(c,p,now) {
  const props=p.getProperties(),ready=[];
  Object.keys(props).filter(k=>k.startsWith('event_')).forEach(k=>{
    const e=JSON.parse(props[k]);
    if(e.state==='sending'){e.state='unknown';p.setProperty(k,JSON.stringify(e));}
    if(e.state==='ready')ready.push({key:k,event:e});
    if(['sent','skipped'].includes(e.state)&&e.at<now.getTime()-30*86400000)p.deleteProperty(k);
  });
  // Keep each execution bounded; digest backlog continues on the following minute.
  for(const kind of ['completed','urgent','digest']) {
    const selected=ready.filter(e=>e.event.kind===kind).slice(0,10),valid=[],tasks=[];
    selected.forEach(item=>{
      const doc=firestore_(c,'/tasks/'+encodeURIComponent(item.event.id));
      const t=doc?decode_(doc):null;
      if(!t||t.archived||(kind==='completed'?(t.status!=='done'||t.completedAt!==item.event.stamp):t.status==='done')) {
        item.event.state='skipped';p.setProperty(item.key,JSON.stringify(item.event));return;
      }
      valid.push(item);tasks.push(t);
    });
    if(!valid.length)continue;
    const state=s=>valid.forEach(item=>{item.event.state=s;p.setProperty(item.key,JSON.stringify(item.event));});
    state('sending');
    try {
      const room=kind==='completed'?c.adminRoom:c.staffRoom;
      const response=UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/'+room+'/messages',{
        method:'post',headers:{'x-chatworktoken':c.token},payload:{body:message_(tasks,kind,c)},muteHttpExceptions:true});
      const code=response.getResponseCode();
      if(code>=200&&code<300)state('sent');
      else if(code===429)state('ready');
      else {state(code>=500?'unknown':'failed');throw Error('Chatwork HTTP '+code+'; check delivery in inspectTaskFlow');}
    } catch(error) {
      valid.forEach(item=>{if(item.event.state==='sending'){item.event.state='unknown';p.setProperty(item.key,JSON.stringify(item.event));}});
      throw error;
    }
  }
}
function archiveDaily_(c,p,now) {
  const date=Utilities.formatDate(now,'Asia/Tokyo','yyyy-MM-dd');
  if(p.getProperty('ARCHIVE_DATE')===date)return;
  query_(c,'status','EQUAL',{stringValue:'done'}).forEach(t=>{
    if(!shouldArchive_(t,now.getTime(),c.days))return;
    const path='/tasks/'+encodeURIComponent(t.id)+'?updateMask.fieldPaths=archived&updateMask.fieldPaths=archivedAt&currentDocument.updateTime='+encodeURIComponent(t.updateTime);
    // Precondition prevents archiving a task reopened while this job was running.
    firestore_(c,path,'patch',{fields:{archived:{booleanValue:true},archivedAt:{timestampValue:now.toISOString()}}});
  });p.setProperty('ARCHIVE_DATE',date);
}
function inspectTaskFlow() {
  const props=PropertiesService.getScriptProperties().getProperties(),counts={},attention=[];
  Object.keys(props).filter(k=>k.startsWith('event_')).forEach(k=>{
    const e=JSON.parse(props[k]);counts[e.state]=(counts[e.state]||0)+1;
    if(['unknown','failed'].includes(e.state))attention.push({key:k,task:e.id,state:e.state});
  });
  console.log(JSON.stringify({lastSuccess:props.LAST_SUCCESS,lastError:props.LAST_ERROR,counts:counts,attention:attention}));
}
