// SPIKE output for #28. Not shipped, disposable.
// Web option: one page, pushed over Server-Sent Events, read-only.
//   node spike/live-view/web.ts [--port 4444] [millyard...]
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { discover, readView, LANES, SHORT, type View } from './model.ts';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || process.env.PORT || 4444);
const extra = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');

const clients = new Set<ServerResponse>();
let view: View = readView(discover(homedir(), extra));
let fingerprint = '';
const stable = (v: View) => JSON.stringify(v.projects, (key, value) => (key === 'seconds' ? undefined : value));
setInterval(() => {
  view = readView(discover(homedir(), extra));
  const next = stable(view);
  if (next === fingerprint) return;
  fingerprint = next;
  const payload = `data: ${JSON.stringify(view)}\n\n`;
  for (const client of clients) client.write(payload);
}, 400);
setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, 15000);

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mill live</title>
<style>
:root{--bg:#0e1116;--card:#171c24;--line:#2a3140;--fg:#e6e9ef;--dim:#8b93a3;--work:#4cc2ff;--done:#49d17d;--jam:#ff5c5c;--blk:#f2c04d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;padding:12px 16px 40px;max-width:900px;margin-inline:auto}
h1{font-size:14px;font-weight:500;margin:0 0 12px;display:flex;gap:8px;color:var(--dim)}h1 .live{width:8px;height:8px;border-radius:50%;background:var(--jam);align-self:center}h1 .live.on{background:var(--done)}h1 .at{margin-left:auto;font-variant-numeric:tabular-nums}
.p{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 12px 4px;margin:0 0 12px}
.p h2{font-size:15px;margin:0 0 4px;display:flex;gap:8px;align-items:baseline;min-width:0}.p h2 small{color:var(--dim);font-weight:400;margin-left:auto;white-space:nowrap}.p .path{font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t{padding:10px 0 8px;border-top:1px solid var(--line)}.t .h{display:flex;gap:8px;align-items:baseline;font-size:14px;min-width:0}.t .h .n{color:var(--dim);font-variant-numeric:tabular-nums}.t .h .ti{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.t .h .s{margin-left:auto;font-size:12px;color:var(--dim);white-space:nowrap;font-variant-numeric:tabular-nums}
.lane{position:relative;display:grid;grid-template-columns:repeat(10,minmax(0,1fr));margin-top:10px;height:36px}
.lane:before{content:"";position:absolute;left:5%;right:5%;top:9px;height:2px;background:var(--line)}
.c{position:relative;text-align:center;font-size:10px;color:var(--dim);min-width:0}.c i{display:block;width:8px;height:8px;border-radius:50%;background:var(--line);margin:6px auto 4px}.c.past i{background:var(--dim)}
.chip{position:absolute;top:1px;width:18px;height:18px;border-radius:50%;background:var(--work);transform:translateX(-50%);transition:left .7s cubic-bezier(.4,0,.2,1),background .3s;box-shadow:0 0 0 3px var(--card)}
.working .chip:after{content:"";position:absolute;inset:-5px;border:2px solid transparent;border-top-color:var(--work);border-radius:50%;animation:spin .9s linear infinite}
.done .chip{background:var(--done)}.logjam .chip{background:var(--jam);animation:pulse 1s ease-in-out infinite}.blocked .chip{background:var(--blk)}.queued .chip{background:var(--dim)}
.bounce .chip{animation:shake .5s}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{box-shadow:0 0 0 8px rgba(255,92,92,.25)}}@keyframes shake{25%{margin-left:-5px}75%{margin-left:5px}}
.badge{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--line);color:var(--fg)}.badge.jam{background:var(--jam);color:#fff}.badge.b{background:#3a3020;color:var(--blk)}
@media (max-width:520px){.c .full{display:none}}@media (min-width:521px){.c .short{display:none}}
.empty{color:var(--dim);text-align:center;padding:40px 0}
</style></head><body>
<h1><span class="live" id="live"></span><span id="sum">connecting</span><span class="at" id="at"></span></h1>
<div id="root"><div class="empty">No runs found.</div></div>
<script>
const LANES=${JSON.stringify(LANES)},SHORT=${JSON.stringify(SHORT)};
const root=document.getElementById('root'),sum=document.getElementById('sum'),at=document.getElementById('at'),live=document.getElementById('live');
let view=null,got=0;const rows=new Map(),prevBounces=new Map();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function detail(t,secs){if(t.state==='working')return (t.role||t.stage||'')+(t.bounces?' · round '+(t.bounces+1):'')+' · '+secs+'s';if(t.state==='blocked')return 'blocked by '+t.blockers.map(n=>'#'+n).join(', ');if(t.state==='logjam')return 'logjam: '+(t.reason||'')+(t.stage?' at '+t.stage:'');if(t.state==='done')return 'merged';return 'queued'}
function render(){if(!view)return;const seen=new Set();let working=0,jam=0;
  for(const p of view.projects){let card=rows.get(p.millyard);if(!card){card=document.createElement('div');card.className='p';card.innerHTML='<h2><span class="nm"></span><small></small></h2><div class="path"></div><div class="ts"></div>';root.appendChild(card);rows.set(p.millyard,card)}seen.add(p.millyard);
    const counts={};for(const t of p.tickets){counts[t.state]=(counts[t.state]||0)+1}working+=counts.working||0;jam+=counts.logjam||0;
    card.querySelector('.nm').textContent=p.name;card.querySelector('small').textContent=p.error?'unreadable':Object.entries(counts).map(([k,v])=>v+' '+k).join(' · ');card.querySelector('.path').textContent=p.millyard;
    const ts=card.querySelector('.ts');for(const t of p.tickets){const key=p.millyard+'#'+t.number;let row=rows.get(key);
      if(!row){row=document.createElement('div');row.innerHTML='<div class="h"><span class="n"></span><span class="ti"></span><span class="bb"></span><span class="s"></span></div><div class="lane">'+LANES.map((l,i)=>'<div class="c"><i></i><span class="full">'+l+'</span><span class="short">'+SHORT[i]+'</span></div>').join('')+'<div class="chip"></div></div>';ts.appendChild(row);rows.set(key,row)}seen.add(key);
      row.className='t '+t.state;row.querySelector('.n').textContent='#'+t.number;row.querySelector('.ti').textContent=t.title;row.querySelector('.ti').title=t.title;
      const bb=row.querySelector('.bb');bb.innerHTML=(t.bounces?'<span class="badge b">↺ '+t.bounces+'</span>':'')+(t.stopRequested?' <span class="badge">stop</span>':'')+(t.state==='logjam'?' <span class="badge jam">logjam</span>':'');
      row.querySelectorAll('.c').forEach((c,i)=>c.classList.toggle('past',i<t.lane));row.querySelector('.chip').style.left=(t.lane*10+5)+'%';
      if(prevBounces.has(key)&&prevBounces.get(key)<t.bounces){row.classList.add('bounce');setTimeout(()=>row.classList.remove('bounce'),600)}prevBounces.set(key,t.bounces);
      row.dataset.secs=t.seconds==null?'':t.seconds}}
  for(const [key,el] of rows)if(!seen.has(key)){el.remove();rows.delete(key)}
  root.querySelector('.empty')?.remove();if(!view.projects.length&&!root.querySelector('.empty')){root.innerHTML='<div class="empty">No runs found.</div>'}
  sum.textContent=view.projects.length+' project'+(view.projects.length===1?'':'s')+' · '+working+' working'+(jam?' · '+jam+' logjam':'');tick()}
function tick(){if(!view)return;const extra=Math.floor((Date.now()-got)/1000);at.textContent=new Date(view.at).toLocaleTimeString();
  for(const p of view.projects)for(const t of p.tickets){const row=rows.get(p.millyard+'#'+t.number);if(row)row.querySelector('.s').textContent=detail(t,t.seconds==null?0:t.seconds+extra)}}
setInterval(tick,1000);
const es=new EventSource('/events');es.onopen=()=>live.classList.add('on');es.onerror=()=>live.classList.remove('on');
es.onmessage=e=>{view=JSON.parse(e.data);got=Date.now();render()};
</script></body></html>`;

createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(view)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/view.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(view)); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
}).listen(port, '127.0.0.1', () => console.error(`live view on http://127.0.0.1:${port} (read-only; ${extra.length ? extra.join(', ') + ' plus ' : ''}slots and registry)`));
