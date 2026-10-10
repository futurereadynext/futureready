// Smoke test: teacher + student join, roles, signal relay, state, chat, mute-all, student cannot mute-all.
const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('../server');

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d); inbox.push(m);
    waiters.forEach((w, i) => { if (w.f(m)) { waiters.splice(i, 1); w.r(m); } });
  });
  ws.next = (type) => new Promise((r, j) => {
    const hit = inbox.find((m) => m.t === type);
    if (hit) { inbox.splice(inbox.indexOf(hit), 1); return r(hit); }
    const to = setTimeout(() => j(new Error('timeout waiting for ' + type)), 2000);
    waiters.push({ f: (m) => m.t === type, r: (m) => { clearTimeout(to); inbox.splice(inbox.indexOf(m), 1); r(m); } });
  });
  ws.has = (type) => inbox.some((m) => m.t === type);
  ws.send2 = (o) => ws.send(JSON.stringify(o));
  return new Promise((r) => ws.on('open', () => r(ws)));
}

server.listen(0, async () => {
  const port = server.address().port;
  try {
    const teacher = await client(port);
    teacher.send2({ t: 'join', room: 'abc123', name: 'Teacher', hostKey: 'secretkey' });
    const tw = await teacher.next('welcome');
    assert.strictEqual(tw.role, 'teacher');

    const student = await client(port);
    student.send2({ t: 'join', room: 'abc123', name: 'Asha' });
    const sw = await student.next('welcome');
    assert.strictEqual(sw.role, 'student');
    assert.strictEqual(sw.peers.length, 1);
    const pj = await teacher.next('peer-joined');
    assert.strictEqual(pj.peer.name, 'Asha');

    const fake = await client(port);
    fake.send2({ t: 'join', room: 'abc123', name: 'Fake', hostKey: 'wrong' });
    assert.strictEqual((await fake.next('welcome')).role, 'student');

    teacher.send2({ t: 'signal', to: sw.id, data: { description: { type: 'offer', sdp: 'x' } } });
    const sig = await student.next('signal');
    assert.strictEqual(sig.from, tw.id);

    student.send2({ t: 'state', state: { mic: true, hand: true, screen: true, screenId: 'z' } });
    const st = await teacher.next('state');
    assert.strictEqual(st.state.hand, true);
    assert.strictEqual(st.state.screen, false, 'students cannot present');

    teacher.send2({ t: 'chat', text: 'Hello <b>class</b>' });
    const ch = await student.next('chat');
    assert.strictEqual(ch.role, 'teacher');
    assert.ok(!ch.text.includes('<'));

    student.send2({ t: 'mute-all' });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!teacher.has('mute-all'), 'student mute-all must be ignored');
    teacher.send2({ t: 'mute-all' });
    await student.next('mute-all');

    student.close();
    const left = await teacher.next('peer-left');
    assert.strictEqual(left.id, sw.id);
    console.log('All signaling tests passed');
    process.exit(0);
  } catch (e) { console.error('FAIL', e); process.exit(1); }
});
