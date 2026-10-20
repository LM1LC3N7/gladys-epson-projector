// -----------------------------------------------------------------------------
// ESC/VP.net messages and ESC/VP21 frames, and the codes (pure).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectRequest,
  helloRequest,
  isValidPassword,
  parseFrame,
  parseHelloReply,
  parseMessage,
  parseMessageHead,
} from '../src/escvp/protocol.js';
import {
  parseCode,
  parseLampHours,
  parseMute,
  parseSerial,
  powerState,
} from '../src/escvp/codes.js';
import { helloReply, message } from './fixtures/fakeProjector.js';

test('HELLO and CONNECT requests are the 16-byte ESC/VP.net header', () => {
  assert.deepEqual(
    [...helloRequest()],
    [...Buffer.from('ESC/VP.net'), 0x10, 0x01, 0, 0, 0x00, 0x00],
  );
  assert.deepEqual(
    [...connectRequest('')],
    [...Buffer.from('ESC/VP.net'), 0x10, 0x03, 0, 0, 0x00, 0x00],
  );
});

test('CONNECT with a password carries one PASSWORD header, NUL padded', () => {
  const request = connectRequest('abc');
  assert.equal(request.length, 16 + 18);
  assert.equal(request[15], 1);
  assert.deepEqual([...request.subarray(16, 18)], [1, 1]);
  assert.equal(request.subarray(18, 21).toString('ascii'), 'abc');
  assert.ok(request.subarray(21).every((byte) => byte === 0));
  assert.throws(() => connectRequest('x'.repeat(17)), RangeError);
  assert.throws(() => connectRequest('mot-de-passé'), RangeError);
});

test('passwords: 16 printable ASCII characters at most', () => {
  assert.ok(isValidPassword(''));
  assert.ok(isValidPassword('Abc 123!'));
  assert.ok(!isValidPassword('x'.repeat(17)));
  assert.ok(!isValidPassword('été'));
  assert.ok(!isValidPassword('a\rb'));
  assert.ok(!isValidPassword(undefined));
});

test('answers that are not ESC/VP.net 1.0 are refused', () => {
  assert.equal(parseMessageHead(Buffer.from('HTTP/1.1 400 Bad R')), undefined);
  const wrongVersion = message(3, 0x20);
  wrongVersion[10] = 0x20;
  assert.equal(parseMessageHead(wrongVersion), undefined);
  const tooManyHeaders = message(3, 0x20);
  tooManyHeaders[15] = 200;
  assert.equal(parseMessageHead(tooManyHeaders), undefined);
  assert.deepEqual(parseMessageHead(message(3, 0x43)), { type: 3, status: 0x43, headerCount: 0 });
});

test('HELLO answers: the projector name, truncated datagrams refused', () => {
  assert.deepEqual(parseHelloReply(helloReply('Salon')), { projectorName: 'Salon' });
  assert.equal(parseHelloReply(helloReply('Salon').subarray(0, 20)), undefined);
  assert.equal(parseHelloReply(helloRequest()), undefined, 'the request itself is not an answer');
  const control = helloReply('A\u0007B');
  assert.equal(parseMessage(control).projectorName, 'AB');
});

test('ESC/VP21 frames', () => {
  const frame = (text) => parseFrame(Buffer.from(text, 'latin1'));
  assert.deepEqual(frame(':'), { kind: 'ok' });
  assert.deepEqual(frame('ERR\r:'), { kind: 'error' });
  assert.deepEqual(frame('PWR=01\r:'), { kind: 'value', command: 'PWR', value: '01' });
  assert.deepEqual(frame('\rLAMP=1234 0\r:'), { kind: 'value', command: 'LAMP', value: '1234 0' });
  assert.deepEqual(frame('IMEVENT=0001 03 00000000 00000000 T1 F1\r:'), {
    kind: 'event',
    value: '0001 03 00000000 00000000 T1 F1',
  });
  assert.deepEqual(frame('garbage here\r:'), { kind: 'unknown' });
  assert.deepEqual(frame('__proto__=1\r:'), { kind: 'unknown' });
});

test('codes: power, source, mute, lamp, serial', () => {
  assert.equal(powerState('01').on, true);
  assert.equal(powerState('04').canPowerOn, true);
  assert.equal(powerState('03').canPowerOn, false);
  assert.deepEqual(powerState('7f'), {
    code: '7F',
    label: 'Unknown (7F)',
    on: undefined,
    inStandby: false,
    canPowerOn: false,
  });
  assert.equal(powerState('constructor'), undefined);
  assert.equal(parseCode('a0'), 'A0');
  assert.equal(parseCode('A00'), undefined);
  assert.equal(parseCode(null), undefined);
  assert.equal(parseMute('ON'), true);
  assert.equal(parseMute('OFF'), false);
  assert.equal(parseMute('01'), undefined);
  assert.equal(parseLampHours('1234 0'), 1234);
  assert.equal(parseLampHours('0'), 0);
  assert.equal(parseLampHours('-1'), undefined);
  assert.equal(parseLampHours('99999999'), undefined);
  assert.equal(parseSerial('x5ab1234567'), 'X5AB1234567');
  assert.equal(parseSerial('__proto__'), undefined);
  assert.equal(parseSerial(''), undefined);
});
