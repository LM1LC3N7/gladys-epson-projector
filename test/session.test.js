// -----------------------------------------------------------------------------
// One ESC/VP.net session against the fake projector on the loopback
// interface: handshake, password, busy, silent and junk projectors, bounded
// answers, pushed IMEVENT, a timed out request closing the session.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { ERROR_KINDS, MAX_FRAME, Session } from '../src/escvp/session.js';
import { startFakeProjector } from './fixtures/fakeProjector.js';

async function fake(t, options) {
  const projector = await startFakeProjector(options);
  t.after(() => projector.close());
  return projector;
}

const open = (port, password, timeoutMs = 1_000) =>
  Session.open({ host: '127.0.0.1', port, password, timeoutMs });

async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('a session answers questions and commands', async (t) => {
  const projector = await fake(t, { power: '01' });
  const session = await open(projector.port);
  t.after(() => session.close());
  assert.deepEqual(await session.request('PWR?', 500), {
    kind: 'value',
    command: 'PWR',
    value: '01',
  });
  assert.deepEqual(await session.request('SOURCE A0', 500), { kind: 'ok' });
  await assert.rejects(session.request('SOURCE 52', 500), { kind: ERROR_KINDS.REFUSED });
  // Still in step after an ERR.
  assert.equal((await session.request('SOURCE?', 500)).value, 'A0');
  assert.deepEqual(projector.passwords, ['']);
});

test('only well-formed commands are written', async (t) => {
  const projector = await fake(t);
  const session = await open(projector.port);
  t.after(() => session.close());
  for (const command of ['PWR?\rPWR OFF', 'pwr?', '', 'SOURCE ', 'X'.repeat(40)]) {
    await assert.rejects(session.request(command, 500), { kind: ERROR_KINDS.PROTOCOL });
  }
  assert.deepEqual(projector.received, []);
});

test('the password: required, refused, accepted, never in an error', async (t) => {
  const projector = await fake(t, { password: 'S3cret!' });
  await assert.rejects(open(projector.port), (err) => {
    assert.equal(err.kind, ERROR_KINDS.AUTH_REQUIRED);
    return true;
  });
  await assert.rejects(open(projector.port, 'wrong'), (err) => {
    assert.equal(err.kind, ERROR_KINDS.AUTH_REFUSED);
    assert.ok(!err.message.includes('wrong'));
    return true;
  });
  const session = await open(projector.port, 'S3cret!');
  t.after(() => session.close());
  assert.equal((await session.request('PWR?', 500)).value, '04');
  assert.deepEqual(projector.passwords, ['', 'wrong', 'S3cret!']);
});

test('busy, silent, junk and absent projectors', async (t) => {
  const busy = await fake(t, { busy: true });
  await assert.rejects(open(busy.port), { kind: ERROR_KINDS.BUSY });
  const silent = await fake(t, { silent: true });
  await assert.rejects(open(silent.port, undefined, 200), { kind: ERROR_KINDS.NO_ANSWER });
  const junk = await fake(t, { garbage: true });
  await assert.rejects(open(junk.port), { kind: ERROR_KINDS.PROTOCOL });
  await assert.rejects(open(await closedPort()), { kind: ERROR_KINDS.UNREACHABLE });
});

test('a pushed IMEVENT is not taken for an answer', async (t) => {
  const projector = await fake(t, { power: '01', pushEvents: true });
  const session = await open(projector.port);
  t.after(() => session.close());
  const events = [];
  session.onEvent = (value) => events.push(value);
  assert.equal((await session.request('PWR?', 500)).value, '01');
  assert.equal((await session.request('LAMP?', 500)).value, '1234 0');
  assert.equal(events.length, 2);
});

test('a request not answered in time: "sent", and the session is closed', async (t) => {
  const projector = await fake(t, { noAnswer: ['LAMP?'] });
  const session = await open(projector.port);
  await assert.rejects(session.request('LAMP?', 100), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    assert.equal(err.sent, true);
    return true;
  });
  assert.equal(session.open, false);
  await assert.rejects(session.request('PWR?', 100), { kind: ERROR_KINDS.UNREACHABLE });
});

test('an answer longer than the bound closes the session', async (t) => {
  const projector = await fake(t, { noAnswer: ['PWR?'] });
  const session = await open(projector.port);
  const pending = session.request('PWR?', 1_000);
  projector.push('A'.repeat(MAX_FRAME + 10));
  await assert.rejects(pending, { kind: ERROR_KINDS.PROTOCOL });
  assert.equal(session.open, false);
});

test('M1 a long frame arriving whole, colon included, is refused before parsing', async (t) => {
  const projector = await fake(t, { noAnswer: ['LAMP?'] });
  const session = await open(projector.port);
  const pending = session.request('LAMP?', 1_000);
  projector.push(`LAMP=${'1'.repeat(60_000)}\r:`);
  await assert.rejects(pending, { kind: ERROR_KINDS.PROTOCOL, message: 'Answer too long' });
  assert.equal(session.open, false);
});
