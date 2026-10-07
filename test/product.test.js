
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname,'..');
const DB = path.join(ROOT,'data','test-sc-smt.sqlite');

function request(method, path, body=null, headers={}) {
  return new Promise((resolve,reject)=>{
    const payload=body ? JSON.stringify(body) : null;
    const req=http.request({
      host:'127.0.0.1',
      port:4174,
      method,
      path,
      headers:{'Content-Type':'application/json', ...(payload?{'Content-Length':Buffer.byteLength(payload)}:{}), ...headers}
    },res=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>resolve({status:res.statusCode,body:data?JSON.parse(data):{}}));
    });
    req.on('error',reject);
    if(payload) req.write(payload);
    req.end();
  });
}

let child;

test.before(async()=>{
  try{fs.unlinkSync(DB)}catch{}
  child=spawn(process.execPath,[path.join(ROOT,'server.js')],{
    cwd:ROOT,
    env:{...process.env,PORT:'4174',SC_SMT_DB:DB},
    stdio:['ignore','pipe','pipe']
  });
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('server start timeout')),5000);
    child.stdout.on('data',d=>{
      if(String(d).includes('running at')){clearTimeout(timeout);resolve();}
    });
    child.on('error',reject);
  });
});

test.after(()=>{try{child.kill('SIGTERM')}catch{};try{fs.unlinkSync(DB)}catch{}});

test('demo starts with a current approval and pending action', async()=>{
  const r=await request('GET','/api/state');
  assert.equal(r.status,200);
  assert.equal(r.body.decisions.find(x=>x.id==='D-104').status,'CURRENT');
  assert.equal(r.body.actions.find(x=>x.id==='A-2207').status,'PENDING');
});

test('expired qualification puts approval on hold', async()=>{
  const change=await request('POST','/api/simulate/qualification-expiry');
  assert.equal(change.status,200);
  assert.equal(change.body.state.decisions.find(x=>x.id==='D-104').status,'REVALIDATION_REQUIRED');
  assert.equal(change.body.state.actions.find(x=>x.id==='A-2207').status,'HOLD');
});

test('revalidation does not merely flip status when current evidence is invalid', async()=>{
  const r=await request('POST','/api/decisions/D-104/revalidate');
  assert.equal(r.status,200);
  assert.equal(r.body.status,'HOLD');
  assert.equal(r.body.state.decisions.find(x=>x.id==='D-104').status,'REVALIDATION_REQUIRED');
});

test('expiry endpoint is idempotent', async()=>{
  const a=await request('POST','/api/maintenance/expiry-scan');
  assert.equal(a.status,200);
  const b=await request('POST','/api/maintenance/expiry-scan');
  assert.equal(b.status,200);
});

test('new verified qualification enables a fresh revalidation and authorization', async()=>{
  await request('POST','/api/simulate/renew-qualification');
  const re=await request('POST','/api/decisions/D-104/revalidate');
  assert.equal(re.body.status,'CURRENT');
  const au=await request('POST','/api/actions/A-2207/authorize');
  assert.equal(au.body.status,'ALLOW');
  assert.equal(au.body.state.actions.find(x=>x.id==='A-2207').status,'AUTHORIZED');
});

test('cycle registration is rejected', async()=>{
  const r=await request('POST','/api/dependencies',{
    upstream_type:'action',upstream_id:'A-2207',
    downstream_type:'fact',downstream_id:'vendor_123|vendor.qualification.status',
    dependency_type:'REQUIRES_CURRENT',required_state:'CURRENT'
  });
  assert.equal(r.status,409);
});

test('unrelated dependency does not become part of the vendor-change closure', async()=>{
  const r=await request('GET','/api/state');
  assert.equal(r.status,200);
  const ids=r.body.impact.map(x=>`${x.downstream_type}:${x.downstream_id}`);
  assert.ok(ids.includes('decision:D-104'));
  assert.ok(ids.includes('action:A-2207'));
  assert.equal(ids.includes('decision:UNRELATED'),false);
});

test('source authentication is enforced', async()=>{
  const r=await request('POST','/api/evidence',{
    entity_id:'vendor_123',
    fact_key:'vendor.qualification.status',
    value:'VALID',
    effective_from:new Date().toISOString(),
    verify:true
  });
  assert.equal(r.status,401);
});

test('end-to-end execution succeeds only after state-bound authorization', async()=>{
  const one=await request('POST','/api/actions/A-2207/execute',null,{'Idempotency-Key':'same-key'});
  assert.equal(one.body.status,'EXECUTED');
  const two=await request('POST','/api/actions/A-2207/execute',null,{'Idempotency-Key':'same-key'});
  assert.equal(two.body.action_id,one.body.action_id);
  assert.equal(two.body.duplicate,true);
});
