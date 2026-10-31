import { lanes } from './model.js';
import { boardIcon, boardTouchIcon, boardStyles, boardWordmark } from './appearance.js';

const short = ['Q', 'L', 'W', 'T', 'I', 'R', 'B', 'PR', 'CI', 'M'];

/** One document, no framework or build step. The server pushes snapshots; the browser counts time in stage between them. */
export const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sawmill Board</title><meta name="theme-color" content="#214538"><link rel="icon" href="${boardIcon}"><link rel="apple-touch-icon" href="${boardTouchIcon}">
<style>${boardStyles}</style></head><body>
<a class="skip" href="#main">Skip to runs</a>
<header class="topbar"><div class="topbar-inner wrap">
<a class="brand" href="#main" aria-label="Sawmill Board home"><img src="${boardWordmark}" width="174" height="53" alt="Sawmill"></a>
<div class="connection" role="status"><span class="live" id="live" aria-hidden="true"></span><span id="connection">Connecting</span></div>
</div></header>
<div class="connection-note" id="connection-note" role="status" hidden><div class="wrap" id="connection-message"></div></div>
<noscript><div class="connection-note"><div class="wrap">Enable JavaScript to see live runs and use the Board's controls.</div></div></noscript>
<main class="board wrap" id="main" tabindex="-1">
<div class="intro"><div><p class="eyebrow">A view of the workshop</p><h1>The Board</h1><p class="lede">Runs, tickets, and the work that needs you.</p></div><p class="updated">Last update<time class="at" id="at">Waiting for a snapshot</time></p></div>
<p id="sum" class="sr-only" role="status">Connecting to your workshop.</p>
<dl class="metrics" aria-label="Current run totals">
<div class="metric"><dt>Projects</dt><dd id="metric-projects">—</dd><svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 18 20 7l15 11v17H5Z" fill="#e7ead9"/><path d="M2 18 20 4l18 14M10 24h7v11h-7ZM23 23h7v6h-7ZM27 10V4h5v10"/><path d="M18 14h4v5h-4Z" fill="#fa7844"/></svg></div>
<div class="metric working-count"><dt>Working</dt><dd id="metric-working">—</dd><svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="7" y="7" width="26" height="22" rx="4" fill="#fa7844"/><path d="M13 15v3m14-3v3m-11 4q4 4 8 0M20 7V3M9 29v5m22-5v5M4 35h32M3 16h4m26 0h4"/><circle cx="20" cy="3" r="2" fill="#f5f0df"/></svg></div>
<div class="metric"><dt>Queued</dt><dd id="metric-queued">—</dd><svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 10h28v7H5Zm3 7h28v7H8ZM4 24h28v7H4Z" fill="#efc46d"/><path d="M10 13h8m5 0h5M13 20h14M9 27h16M8 34h27"/></svg></div>
<div class="metric jam-count" id="jam-count"><dt>Logjams</dt><dd id="metric-jam">—</dd><svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m20 5 17 29H3Z" fill="#efc46d"/><path d="M20 15v9" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="28" r="1.5" fill="currentColor"/></svg></div>
</dl>
<section id="active-section" aria-labelledby="act"><div class="section-heading"><h2 class="sec" id="act">Active runs</h2></div>
<div id="root"><div class="empty">Connecting to your workshop…</div></div></section>
<footer class="board-footer"><span>Sawmill · Good work needs good machinery.</span><span>Updates automatically from this machine.</span></footer>
</main>
<dialog id="dlg" aria-labelledby="dt"><form id="dform"><h3 id="dt"></h3><div class="dq" id="dq"></div>
<label for="dm" class="sec">Answer and guidance for the agent</label><textarea id="dm" spellcheck="true"></textarea><div class="fb" id="ds" role="status"></div>
<div class="db"><button type="button" class="ac" id="dcancel">Cancel</button><button type="submit" class="ac" id="dsend">Answer and resume</button></div></form></dialog>
<script>
const LANES=${JSON.stringify(lanes)},SHORT=${JSON.stringify(short)};
const root=document.getElementById('root'),sum=document.getElementById('sum'),at=document.getElementById('at'),live=document.getElementById('live');
let view=null,got=0;const rows=new Map(),prevBounces=new Map(),opened=new Set();
const ACTIONS=[['pick','Pick next'],['clear-pick','Clear pick'],['stop','Stop'],['answer','Answer and resume'],['reset','Reset'],['close','Close']];
const unavailable={available:false,reason:'This action is unavailable in this snapshot. Wait for the Board to refresh.'};
/** Each project's run and each ticket has one request line: pending, ok or failed. A pending request blocks repeats. */
const notes=new Map();
function controls(box,key,rule){const pending=notes.get(key)?.state==='pending';
  box.querySelectorAll('button').forEach(b=>{const r=rule(b.dataset.a)||unavailable;b.setAttribute('aria-disabled',String(pending||!r.available));b.title=r.available?'':r.reason||''})}
function feedback(box,key){const n=notes.get(key);box.className='fb'+(n?' '+n.state:'');box.textContent=n?n.message:''}
function note(key,state,message){clearTimeout(notes.get(key)?.timer);const n={state,message};
  if(state==='ok'||state==='info')n.timer=setTimeout(()=>{if(notes.get(key)===n){notes.delete(key);render()}},8000);notes.set(key,n);render()}
const CONFIRM={reset:t=>'Reset #'+t.number+'? This deletes its worktree, branches, logs and agent comments, and queues it to start fresh.',close:t=>'Close #'+t.number+'? This marks it done and closes its tracker issue without merging.'};
function act(key,p,t,a){if(!p||notes.get(key)?.state==='pending')return;
  const r=(t?t.actions[a]:p.runActions[a==='start-run'?'start':'stop'])||unavailable;
  if(!r.available){note(key,'info',r.reason);return}
  if(a==='answer'){openAnswer(key,p,t);return}
  if(CONFIRM[a]&&!confirm(CONFIRM[a](t)))return;
  send(key,{action:a,millyard:p.millyard,runId:p.runId,...(t?{ticket:t.number}:{}),...attempt(t),...(CONFIRM[a]?{confirmed:true}:{})})}
/** The ticket's attempt as this page drew it, whatever its state, so an action never reaches a newer attempt. */
function attempt(t){return t?{attempt:t.attempt}:{}}
/** The request names the project, run and ticket as this page saw them; the server refuses it if they have changed. */
async function send(key,body){note(key,'pending','Sending…');
  try{const r=await fetch('/api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));
    note(key,r.ok?'ok':'failed',j.message||(r.ok?'Done.':'The request failed ('+r.status+').'));return r.ok}
  catch(e){note(key,'failed','The board could not be reached: '+e.message);return false}}
const dlg=document.getElementById('dlg'),dform=document.getElementById('dform'),dm=document.getElementById('dm'),ds=document.getElementById('ds'),dsend=document.getElementById('dsend');let answering=null;
function openAnswer(key,p,t){answering={key,p,t};document.getElementById('dt').textContent='Answer #'+t.number+' '+t.title;
  document.getElementById('dq').textContent=(t.question?'Question: '+t.question:t.blockage||'Nothing is recorded about what stopped this ticket.')+(t.diagnosis?'\\n\\nAnswering: '+t.diagnosis.next.explanation:'');
  dm.value='';ds.className='fb';ds.textContent='';dsend.disabled=false;dlg.showModal();dm.focus()}
document.getElementById('dcancel').onclick=()=>dlg.close();
dform.onsubmit=async e=>{e.preventDefault();if(!answering||dsend.disabled)return;const {key,p,t}=answering;dsend.disabled=true;ds.className='fb pending';ds.textContent='Sending…';
  const ok=await send(key,{action:'answer',millyard:p.millyard,runId:p.runId,ticket:t.number,...attempt(t),message:dm.value});
  if(ok&&answering?.key===key){dlg.close();dm.value='';answering=null;return}
  const n=notes.get(key);ds.className='fb failed';ds.textContent=n?n.message:'The request failed.';dsend.disabled=false};
dlg.onclose=()=>{if(dsend.disabled)return;answering=null};
function detail(t,secs){
  if(t.state==='working')return (t.stage||'unknown')+(t.role?' ('+t.role+')':'')+'; round '+(t.bounces+1)+'; bounces '+t.bounces+'; '+secs+'s in stage'+(t.stopRequested?'; stop requested':'');
  if(t.state==='blocked')return 'blocked by '+t.blockers.map(n=>'#'+n).join(', ');
  if(t.state==='logjam')return 'logjam: '+(t.reason||'')+(t.stage?' at '+t.stage:'');
  return t.state}
/** What stopped the ticket, the code and environment it stopped on, and the supported command that moves it on. */
function diagnosis(box,t){const d=t.diagnosis;box.hidden=!d;if(!d)return;
  box.querySelector('.dxh').textContent='Stopped at '+d.phase+(d.command?' running '+d.command:'')+' · last progress '+new Date(d.lastProgress).toLocaleString()+' · attempt '+d.attempt;
  box.querySelector('.dxi').textContent=(Object.entries(d.identities).filter(([,v])=>v).map(([k,v])=>k+' '+(/^[0-9a-f]{40}$/.test(v)?v.slice(0,12):v)).join(' · ')||'No code or environment identity is recorded.')+(d.owner?' · owner: '+d.owner:'');
  box.querySelector('code').textContent=d.next.command;box.querySelector('.dxn span').textContent=d.next.explanation;
  box.querySelector('pre').textContent=d.excerpt;box.querySelector('.dxl').textContent=(d.log?'Full log: '+d.log+' · ':'')+'Every step: mill run log '+t.number}
function render(){if(!view)return;const seen=new Set();let working=0,jam=0,queued=0;
  for(const p of view.projects){let card=rows.get(p.millyard);
    if(!card){card=document.createElement('div');card.className='p';card.innerHTML='<h2><span class="nm"></span><small></small></h2><div class="path"></div><div class="err"></div><div class="rb"><span class="rs" role="status"></span><button type="button" class="ac" data-a="start-run">Start Run</button><button type="button" class="ac" data-a="stop-run">Stop Run</button></div><div class="pr"></div><div class="fb" role="status"></div><div class="ts"></div>';
      const key=p.millyard;card.querySelectorAll('.rb button').forEach(b=>b.onclick=()=>act(key,card.data,null,b.dataset.a));root.appendChild(card);rows.set(p.millyard,card)}
    seen.add(p.millyard);card.data=p;const counts={};for(const t of p.tickets)counts[t.state]=(counts[t.state]||0)+1;working+=counts.working||0;jam+=counts.logjam||0;queued+=counts.queued||0;
    card.querySelector('.nm').textContent=p.name;card.querySelector('small').textContent=p.error?'unreadable':Object.entries(counts).map(([k,v])=>v+' '+k).join(' · ');
    card.querySelector('.path').textContent=p.millyard;card.querySelector('.err').textContent=p.error||'';
    const rs=card.querySelector('.rs');rs.className='rs '+p.runStatus;rs.textContent=p.runStatus+(p.runStatus==='stopping'?' (waiting for stage boundaries)':'');
    card.querySelector('.pr').textContent=p.pausedReason||'';card.querySelector('.rb').hidden=Boolean(p.error);
    controls(card.querySelector('.rb'),p.millyard,a=>p.runActions[a==='start-run'?'start':'stop']);feedback(card.querySelector(':scope>.fb'),p.millyard);
    const ts=card.querySelector('.ts');
    for(const t of p.tickets){const key=p.millyard+'#'+t.number;let row=rows.get(key);
      if(!row){row=document.createElement('div');row.innerHTML='<div class="h"><a class="tl"><span class="n"></span><span class="ti"></span></a><span class="bb"></span><button type="button" class="more" aria-expanded="false">Actions</button></div><div class="d"></div><div class="why"></div>'
          +'<div class="dx" hidden><div class="dxh"></div><div class="dxi"></div><div class="dxn">Next: <code></code> <span></span></div><details><summary>Output</summary><pre></pre><div class="dxl"></div></details></div><div class="lane">'+LANES.map((l,i)=>'<div class="c"><i></i><span class="full">'+l+'</span><span class="short">'+SHORT[i]+'</span></div>').join('')+'<div class="blade" aria-hidden="true"><svg viewBox="0 0 34 34"><path class="disc" d="M17 3.80 L22.13 0.79 L22.39 2.04 L22.05 4.80 L27.94 3.99 L27.70 5.24 L26.33 7.67 L32.09 9.16 L31.39 10.23 L29.20 11.95 L33.94 15.53 L32.88 16.25 L30.20 17 L33.21 22.13 L31.96 22.39 L29.20 22.05 L30.01 27.94 L28.76 27.70 L26.33 26.33 L24.84 32.09 L23.77 31.39 L22.05 29.20 L18.47 33.94 L17.75 32.88 L17 30.20 L11.87 33.21 L11.61 31.96 L11.95 29.20 L6.06 30.01 L6.30 28.76 L7.67 26.33 L1.91 24.84 L2.61 23.77 L4.80 22.05 L0.06 18.47 L1.12 17.75 L3.80 17 L0.79 11.87 L2.04 11.61 L4.80 11.95 L3.99 6.06 L5.24 6.30 L7.67 7.67 L9.16 1.91 L10.23 2.61 L11.95 4.80 L15.53 0.06 L16.25 1.12 Z"/><circle class="hub" cx="17" cy="17" r="4"/></svg></div><div class="chip"></div></div>'
        +'<div class="acts" hidden>'+ACTIONS.map(([a,label])=>'<button type="button" class="ac" data-a="'+a+'">'+label+'</button>').join('')+'</div><div class="fb" role="status"></div>';
        const mill=p.millyard;row.querySelector('.more').onclick=()=>{if(opened.has(key))opened.delete(key);else opened.add(key);render()};row.querySelectorAll('.acts button').forEach(b=>b.onclick=()=>act(key,rows.get(mill).data,row.data,b.dataset.a));ts.appendChild(row);rows.set(key,row)}
      seen.add(key);row.data=t;const index=LANES.indexOf(t.lane);row.querySelector('.why').textContent=t.blockage||'';
      diagnosis(row.querySelector('.dx'),t);controls(row.querySelector('.acts'),key,a=>t.actions[a]);feedback(row.querySelector('.fb'),key);
      row.className='t '+t.state+(t.picked?' picked':'');row.querySelector('.n').textContent='#'+t.number;row.querySelector('.ti').textContent=t.title;row.querySelector('.ti').title=t.title;link(row.querySelector('.tl'),t);
      row.querySelector('.bb').innerHTML=(t.picked?'<span class="badge">Pending pick</span> ':'')+(t.appended?'<span class="badge">Appended</span> ':'')+(t.bounces?'<span class="badge b">↺ '+t.bounces+'</span>':'')+(t.stopRequested?' <span class="badge">stop</span>':'')+(t.state==='logjam'?' <span class="badge jam">logjam</span>':'');
      row.querySelectorAll('.c').forEach((c,i)=>{c.classList.toggle('past',i<index);c.classList.toggle('cur',i===index)});const open=opened.has(key),more=row.querySelector('.more');row.querySelector('.acts').hidden=!open;more.setAttribute('aria-expanded',String(open));more.setAttribute('aria-label',(open?'Hide':'Show')+' actions for #'+t.number);row.querySelectorAll('.chip,.blade').forEach(marker=>marker.style.left=(index*10+5)+'%');
      if(prevBounces.has(key)&&prevBounces.get(key)<t.bounces){row.classList.add('bounce');setTimeout(()=>row.classList.remove('bounce'),600)}prevBounces.set(key,t.bounces)}}
  for(const [key,el] of rows)if(!seen.has(key)){el.remove();rows.delete(key);opened.delete(key)}
  const empty=root.querySelector('.empty');if(view.projects.length)empty?.remove();else if(!empty)root.innerHTML='<div class="empty">No active runs. Your workshop is clear.</div>';else empty.textContent='No active runs. Your workshop is clear.';
  document.getElementById('metric-projects').textContent=view.projects.length;document.getElementById('metric-working').textContent=working;document.getElementById('metric-queued').textContent=queued;document.getElementById('metric-jam').textContent=jam;document.getElementById('jam-count').classList.toggle('has-jams',jam>0);
  sum.textContent=view.projects.length+' project'+(view.projects.length===1?'':'s')+' · '+working+' working'+(jam?' · '+jam+' logjam':'');tick()}
/** Only an absolute http(s) URL becomes an href; anything else leaves a plain, unfocusable anchor. */
function safeUrl(u){if(typeof u!=='string')return null;try{const url=new URL(u);return url.protocol==='https:'||url.protocol==='http:'?url.href:null}catch{return null}}
function link(a,t){const url=safeUrl(t.url);
  if(url){a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label','#'+t.number+' '+t.title+' (opens tracker issue in a new tab)')}
  else{a.removeAttribute('href');a.removeAttribute('target');a.removeAttribute('rel');a.removeAttribute('aria-label')}}
function tick(){if(!view)return;const extra=Math.floor((Date.now()-got)/1000);at.textContent=new Date(view.time).toLocaleTimeString();
  for(const p of view.projects)for(const t of p.tickets){const row=rows.get(p.millyard+'#'+t.number);if(row)row.querySelector('.d').textContent=detail(t,t.timeInStageSeconds==null?0:t.timeInStageSeconds+extra)}}
setInterval(tick,1000);
const connection=document.getElementById('connection'),connectionNote=document.getElementById('connection-note');
const es=new EventSource('/events');es.onopen=()=>{live.classList.add('on');connection.textContent='Live';connectionNote.hidden=true};es.onerror=()=>{live.classList.remove('on');connection.textContent='Reconnecting';connectionNote.hidden=false;document.getElementById('connection-message').textContent=view?'Connection lost. Showing the last snapshot while the Board reconnects.':'Cannot reach the Board. Reconnecting automatically.'};
es.onmessage=e=>{view=JSON.parse(e.data);got=Date.now();render()};
</script></body></html>`;
