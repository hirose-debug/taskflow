const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/Code.gs','utf8');
function worker(){const w={console,Utilities:{formatDate:(date,tz,format)=>format==='H'?String((date.getUTCHours()+9)%24):new Date(+date+9*3600000).toISOString().slice(0,10)}};vm.createContext(w);vm.runInContext(source,w);return w;}
test('normal/urgent/completed routing, legacy and archived suppression',()=>{
 const w=worker(),start=Date.parse('2026-10-09T00:00:00Z'),t={id:'a',assignee:'田中',status:'todo',createdAt:'2026-10-09T00:01:00Z'};
 assert.equal(w.eventsFor_(t,start)[0].kind,'digest');
 assert.equal(w.eventsFor_({...t,urgent:true},start)[0].kind,'urgent');
 assert.equal(w.eventsFor_({...t,status:'done',completedAt:'2026-10-09T00:02:00Z'},start)[0].kind,'completed');
 assert.equal(w.eventsFor_({...t,archived:true},start).length,0);
 assert.equal(w.eventsFor_(t,start+3600000).length,0);
});
test('JST digest boundaries',()=>{const w=worker();assert.equal(w.slot_(new Date('2026-10-08T23:59:00Z')),null);assert.equal(w.slot_(new Date('2026-10-09T00:00:00Z')),'2026-10-09-09');assert.equal(w.slot_(new Date('2026-10-09T08:00:00Z')),'2026-10-09-17');});
test('archive cutoff, reopened task, legacy completed date, restore grace',()=>{
 const w=worker(),now=Date.parse('2026-10-09T00:00:00Z'),t={status:'done',completedAt:'2026-10-02T00:00:00Z'};
 assert.equal(w.shouldArchive_(t,now,7),true);assert.equal(w.shouldArchive_(t,now-1,7),false);
 assert.equal(w.shouldArchive_({...t,status:'todo'},now,7),false);
 assert.equal(w.shouldArchive_({status:'done'},now,7),false);
 assert.equal(w.shouldArchive_({...t,archiveRestoredAt:'2026-10-08T00:00:00Z'},now,7),false);
});
test('send success, rate limit, ambiguous failure, explicit failure',()=>{
 for(const [code,expected] of [[200,'sent'],[429,'ready'],[500,'unknown'],[401,'failed']]){
  const w=worker(),data={event_a:JSON.stringify({id:'a',kind:'urgent',stamp:'today',state:'ready',at:Date.now()})};
  const p={getProperties:()=>({...data}),setProperty:(k,v)=>data[k]=v,deleteProperty:k=>delete data[k]};
  w.firestore_=()=>({name:'tasks/a',fields:{status:{stringValue:'todo'},content:{stringValue:'画像修正'}}});
  let sent=0;w.UrlFetchApp={fetch:()=>{sent++;return {getResponseCode:()=>code}}};
  try{w.sendReady_({staffRoom:'123',token:'fake',url:'https://example.com/'},p,new Date());}catch{}
  assert.equal(JSON.parse(data.event_a).state,expected);assert.equal(sent,1);
  if(code!==429){try{w.sendReady_({},p,new Date());}catch{}assert.equal(sent,1,'must not automatically resend uncertain messages');}
 }
});
test('messages include deep links and escape Chatwork formatting',()=>{
 const w=worker(),m=w.message_([{id:'a b',content:'[toall] 内容',assignee:'田中'}],'digest',{staffTo:'123',url:'https://example.com/'});
 assert.match(m,/\[To:123\]/);assert.doesNotMatch(m,/\[toall\]/);assert.match(m,/#task=a%20b/);
});
