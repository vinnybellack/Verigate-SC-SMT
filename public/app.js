
const state = {data:null};

async function api(path, options={}) {
  const res = await fetch(path, {
    headers:{'Content-Type':'application/json', ...(options.headers||{})},
    ...options
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function pill(text, cls='neutral'){return `<span class="pill ${cls}">${esc(text)}</span>`}
function fmtTime(v){return v ? new Date(v).toLocaleString() : '—'}

function statusClass(v){
  const s=String(v||'').toUpperCase();
  if(['ALLOW','CURRENT','VERIFIED','AUTHORITATIVE','EXECUTED','AUTHORIZED','READY'].includes(s)) return 'good';
  if(['HOLD','REVALIDATION_REQUIRED','RECEIVED','PENDING'].includes(s)) return 'warn';
  if(['BLOCK','BLOCKED','EXPIRED','STALE','FAILED','REJECTED','CONFLICT'].includes(s)) return 'bad';
  return 'neutral';
}

function render(){
  const d=state.data;
  if(!d) return;
  document.getElementById('k-evidence').textContent=d.summary.evidence_count;
  document.getElementById('k-affected').textContent=d.impact.length;
  document.getElementById('k-decisions').textContent=d.summary.decisions_count;
  document.getElementById('k-held').textContent=d.summary.held_actions;
  document.getElementById('k-held').textContent=d.summary.held_actions;

  const latest=d.latest_change;
  document.getElementById('latest-value').textContent=latest?.value_text || '—';
  document.getElementById('latest-version').textContent=latest ? `EV ${latest.id} • v${latest.version}` : '—';

  const decision=d.decisions.find(x=>x.id==='D-104') || d.decisions[0];
  const action=d.actions.find(x=>x.id==='A-2207') || d.actions[0];

  document.getElementById('decision-status').innerHTML=decision?pill(decision.status,statusClass(decision.status)):'—';
  document.getElementById('action-status').innerHTML=action?pill(action.status,statusClass(action.status)):'—';

  const gate=document.getElementById('gate');
  const gateState=action?.status==='EXECUTED'?'EXECUTED':action?.status==='AUTHORIZED'?'ALLOW':action?.status==='HOLD'?'HOLD':'HOLD';
  gate.className=`gate ${statusClass(gateState)}`;
  document.getElementById('gate-status').textContent=gateState;
  document.getElementById('gate-reason').textContent=
    gateState==='EXECUTED'?'The simulated external adapter accepted the action after execution-time validation.':
    gateState==='ALLOW'?'A current authorization exists and is bound to the current decision, evidence versions, policy, and action parameters.':
    'Execution is stopped until a valid decision and authorization exist.';

  document.getElementById('execute').disabled=action?.status!=='AUTHORIZED';
  document.getElementById('authorize').disabled=action?.status!=='PENDING';

  renderImpact();
  renderTables();
  renderAudit();
}

function renderImpact(){
  const d=state.data;
  const nodes=[...d.impact];
  const byKey=new Map(nodes.map(x=>[`${x.downstream_type}:${x.downstream_id}`,x]));
  let html=`<div class="node"><div class="node-row"><div><b>EV-006 • Vendor qualification</b><div class="muted">Current evidence / latest version</div></div>${pill('CHANGED','bad')}</div></div>`;
  if(!nodes.length){
    html+=`<div class="muted" style="padding:14px">No registered downstream dependencies.</div>`;
  }else{
    const grouped=[...nodes].sort((a,b)=>a.downstream_type.localeCompare(b.downstream_type));
    for(const n of grouped){
      html+=`<div class="connector"></div><div class="node"><div class="node-row"><div><b>${esc(n.downstream_type)}:${esc(n.downstream_id)}</b><div class="muted">${esc(n.dependency_type)} • required ${esc(n.required_state)}</div></div>${pill(n.downstream_type==='decision'?'RECHECK':'HOLD','warn')}</div></div>`;
    }
  }
  document.getElementById('impact').innerHTML=html;
}

function renderTables(){
  const d=state.data;
  document.getElementById('evidence-body').innerHTML=d.evidence.map(e=>`
    <tr>
      <td>${esc(e.id)}</td><td>${esc(e.entity_id)}</td><td>${esc(e.fact_key)}</td><td><b>${esc(e.value_text)}</b></td>
      <td>${esc(e.source_name)}</td><td>${pill(e.status,statusClass(e.status))}</td><td>v${e.version}</td>
    </tr>`).join('');

  document.getElementById('dep-body').innerHTML=d.dependencies.map(x=>`
    <tr><td>${esc(x.id)}</td><td>${esc(x.upstream_type)}:${esc(x.upstream_id)}</td><td>→</td><td>${esc(x.downstream_type)}:${esc(x.downstream_id)}</td><td>${esc(x.dependency_type)}</td><td>${esc(x.required_state)}</td></tr>`).join('');

  document.getElementById('decision-body').innerHTML=d.decisions.map(x=>`
    <tr><td>${esc(x.id)}</td><td>${esc(x.decision_type)}</td><td>${pill(x.status,statusClass(x.status))}</td><td>${esc(x.policy_version)}</td><td>${esc(x.decision_hash.slice(0,14))}…</td><td>${fmtTime(x.validated_at)}</td></tr>`).join('');

  document.getElementById('action-body').innerHTML=d.actions.map(x=>`
    <tr><td>${esc(x.id)}</td><td>${esc(x.action_type)}</td><td>${esc(x.decision_id)}</td><td>${pill(x.status,statusClass(x.status))}</td><td>${esc(x.execution_target)}</td><td>${fmtTime(x.executed_at)}</td></tr>`).join('');
}

function renderAudit(){
  const events=state.data.audit||[];
  document.getElementById('audit-list').innerHTML=events.map(e=>`
    <div class="event">
      <div class="event-dot ${statusClass(
        e.event_type.includes('EXECUT')?'EXECUTED':
        e.event_type.includes('HOLD')?'HOLD':
        e.event_type.includes('FAILED')?'FAILED':'CURRENT'
      )}"></div>
      <div>
        <div class="event-title">${esc(e.event_type.replaceAll('_',' '))}</div>
        <div class="muted">${fmtTime(e.created_at)} • ${esc(e.actor)} • ${esc(e.entity_type)}:${esc(e.entity_id)}</div>
        <div class="event-reason">${esc(e.reason)}</div>
      </div>
    </div>`).join('');
}

async function refresh(){
  try{
    state.data=await api('/api/state');
    render();
    hideError();
  }catch(e){showError(e.message)}
}

function showError(msg){document.getElementById('error').textContent=msg;document.getElementById('error').classList.remove('hidden')}
function hideError(){document.getElementById('error').classList.add('hidden')}

async function simulateChange(){
  await api('/api/simulate/qualification-expiry',{method:'POST'});
  await refresh();
}
async function renewQualification(){
  await api('/api/simulate/renew-qualification',{method:'POST'});
  await refresh();
}
async function revalidate(){
  await api('/api/decisions/D-104/revalidate',{method:'POST'});
  await refresh();
}
async function authorize(){
  const action=state.data.actions.find(x=>x.id==='A-2207');
  if(!action) return;
  await api(`/api/actions/${action.id}/authorize`,{method:'POST'});
  await refresh();
}
async function execute(){
  const action=state.data.actions.find(x=>x.id==='A-2207');
  if(!action) return;
  await api(`/api/actions/${action.id}/execute`,{
    method:'POST',
    headers:{'Idempotency-Key':crypto.randomUUID()}
  });
  await refresh();
}
async function resetDemo(){
  if(!confirm('Reset the demo database to its initial state?')) return;
  await api('/api/reset-demo',{method:'POST'});
  await refresh();
}

function switchView(id, btn){
  document.querySelectorAll('.view').forEach(x=>x.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');
}

document.getElementById('refresh').onclick=refresh;
document.getElementById('simulate').onclick=simulateChange;
document.getElementById('renew').onclick=renewQualification;
document.getElementById('revalidate').onclick=revalidate;
document.getElementById('authorize').onclick=authorize;
document.getElementById('execute').onclick=execute;
document.getElementById('reset').onclick=resetDemo;
refresh();
