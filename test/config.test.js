import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { POLL_INTERVAL } from '../src/constants.js';

test('addresses: IPv4 or host name, optional port, pasted URLs reduced', () => {
  assert.deepEqual(parseAddress(' 192.168.1.50 '), { host: '192.168.1.50', port: 3629 });
  assert.deepEqual(parseAddress('http://192.168.1.50/cgi-bin'), {
    host: '192.168.1.50',
    port: 3629,
  });
  assert.deepEqual(parseAddress('Projector.local:4000'), { host: 'projector.local', port: 4000 });
  for (const bad of ['', '999.1.1.1', '192.168.1.50:0', '192.168.1.50:70000', 'a_b', '-x']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('the configuration is normalized', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.50, 192.168.1.50;bad_one 10.0.0.2',
    password: '  pass  ',
    poll_interval: 3,
  });
  assert.deepEqual(config.addresses, [
    { host: '192.168.1.50', port: 3629 },
    { host: '10.0.0.2', port: 3629 },
  ]);
  assert.deepEqual(config.invalid, ['bad_one']);
  assert.equal(config.password, 'pass');
  assert.equal(config.passwordInvalid, false);
  assert.equal(config.pollInterval, POLL_INTERVAL.min);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, POLL_INTERVAL.max);
});

test('a password ESC/VP.net cannot carry is ignored, without being echoed', () => {
  const config = normalizeConfig({ password: 'x'.repeat(17) });
  assert.equal(config.password, '');
  assert.equal(config.passwordInvalid, true);
  assert.ok(!config.invalid.some((entry) => entry.includes('xxx')));
  assert.equal(normalizeConfig({ password: 'mot de passé' }).passwordInvalid, true);
  assert.equal(normalizeConfig({}).passwordInvalid, false);
});
