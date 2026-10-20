// -----------------------------------------------------------------------------
// EpsonApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and fake projectors on the loopback
// interface. The polling timer never fires: the tests drive it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect, createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EpsonApp, addressId, isLanAddress } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { helloReply, startFakeProjector } from './fixtures/fakeProjector.js';

const SELECTOR = 'epson-projector';
const SERIAL = 'X5AB1234567';
const id = (key, projectorId = SERIAL) =>
  `ext:${SELECTOR}:epson:${projectorId}${key ? `:${key}` : ''}`;

/** No polling round; real (short) timeouts. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  requestTimeout: 500,
  idleClose: 200,
  preRead: 400,
  commandBudget: 1_200,
  powerOnWait: 3_000,
  powerOffWait: 3_000,
  recheckDelay: 20,
  persistDelay: 5,
  probeRetry: 60_000,
  authRetry: 60_000,
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function setup(
  t,
  { projector: options, config, scanResults = {}, timings = {}, ...rest } = {},
) {
  const projector = await startFakeProjector(options);
  t.after(() => projector.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${projector.port}` },
    scanResults,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const store = rest.store ?? new MemoryStore();
  const app = new EpsonApp({
    gladys,
    logger,
    store,
    timers,
    timings: { ...FAST, ...timings },
    ...rest,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  return { projector, gladys, app, logs, store };
}

const discovered = (gladys, projectorId = SERIAL) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, projectorId));

async function createDevice(gladys, projectorId = SERIAL) {
  await waitFor(() => discovered(gladys, projectorId), 'the device in the Discovery tab');
  const device = discovered(gladys, projectorId);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('status', projectorId)) !== undefined, 'the status');
  return device;
}

const press = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    value,
  );

const commands = (projector) => projector.received.filter((line) => !line.endsWith('?'));

test('a typed address becomes a Gladys device, keyed by its serial number', async (t) => {
  const { gladys } = await setup(t);
  await waitFor(() => discovered(gladys), 'the device');
  const device = discovered(gladys);
  assert.equal(device.name, 'Epson projector 127.0.0.1');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_on',
    'standby',
    'status',
    'source',
    'color_mode',
    'av_mute',
    'lamp_hours',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  assert.deepEqual(
    [byKey.power.category, byKey.power.type, byKey.power.read_only],
    ['unknown', 'binary', true],
  );
  for (const key of ['power_on', 'standby']) {
    assert.deepEqual([byKey[key].category, byKey[key].type], ['button', 'push']);
  }
  assert.ok(!device.features.some((f) => f.category === 'switch'), 'never a switch');
  assert.deepEqual(
    [byKey.lamp_hours.category, byKey.lamp_hours.type, byKey.lamp_hours.unit],
    ['duration', 'integer', 'hours'],
  );
  assert.equal(byKey.source.supported_options[0].value, '30');
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
});

test('a projector without a serial number is keyed by its address', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { serial: null } });
  const projectorId = addressId({ host: '127.0.0.1', port: projector.port });
  await waitFor(() => discovered(gladys, projectorId), 'the device');
  assert.match(projectorId, /^ip-127-0-0-1-\d+$/);
});

test('in standby: power 0, status, lamp hours; nothing asked that needs the lamp on', async (t) => {
  const { gladys, projector } = await setup(t);
  await createDevice(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('status')), 'Standby');
  assert.equal(gladys.fake.lastState(id('lamp_hours')), 1234);
  assert.equal(gladys.fake.lastState(id('source')), undefined);
  assert.ok(!projector.received.includes('SOURCE?'));
});

test('on: source, color mode and A/V mute are read', async (t) => {
  const { gladys } = await setup(t, { projector: { power: '01', source: 'A0', mute: 'ON' } });
  await createDevice(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('status')), 'On');
  assert.equal(gladys.fake.lastState(id('source')), 'A0');
  assert.equal(gladys.fake.lastState(id('color_mode')), '15');
  assert.equal(gladys.fake.lastState(id('av_mute')), 1);
});

test('a source code the list does not know is added to the dropdown', async (t) => {
  const { gladys } = await setup(t, { projector: { power: '01', source: 'C0' } });
  await createDevice(gladys);
  await waitFor(
    () =>
      discovered(gladys)
        .features.find((f) => f.external_id === id('source'))
        .supported_options.some((o) => o.value === 'C0'),
    'the new option',
  );
  await gladys.fake.deviceUpdated(discovered(gladys));
  await waitFor(() => gladys.fake.lastState(id('source')) === 'C0', 'the source');
});

test('Power on: sent only from standby, decided on the state read just before', async (t) => {
  const { gladys, projector } = await setup(t);
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(commands(projector), ['PWR ON']);
  await waitFor(() => gladys.fake.lastState(id('power')) === 1, 'power 1');
  // Already on: nothing sent.
  const again = await press(gladys, device, 'power_on');
  assert.equal(again.success, true);
  assert.deepEqual(commands(projector), ['PWR ON']);
});

test('Power on while cooling down: nothing sent, said so', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '03' } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /cooling down, nothing sent/);
  assert.deepEqual(commands(projector), []);
});

test('a slow warm-up: acked as sent, the queue held, then the state read again', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { powerOnDelay: 2_500 } });
  const device = await createDevice(gladys);
  const started = Date.now();
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, true, ack.error);
  assert.ok(Date.now() - started < FAST.commandBudget + 200, 'acked within the budget');
  // While the projector warms up, a command waits, then is dropped, never sent late.
  const source = await press(gladys, device, 'source', 'A0');
  assert.equal(source.success, false);
  assert.match(source.error, /nothing sent/);
  await waitFor(() => gladys.fake.lastState(id('power')) === 1, 'power 1 after the warm-up');
  assert.deepEqual(commands(projector), ['PWR ON']);
});

test('Standby: sent only when on, goes before the commands waiting', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '01' } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'standby');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(commands(projector), ['PWR OFF']);
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0');
  const again = await press(gladys, device, 'standby');
  assert.equal(again.success, true);
  assert.deepEqual(commands(projector), ['PWR OFF']);
});

test('Standby while warming up: nothing sent, said so', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '02' } });
  const device = await createDevice(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  const ack = await press(gladys, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /warming up, nothing sent/);
  assert.deepEqual(commands(projector), []);
});

test('Source and color mode: validated, sent when on, refusals reported', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '01' } });
  const device = await createDevice(gladys);
  assert.equal((await press(gladys, device, 'source', 'A0')).success, true);
  assert.equal(gladys.fake.lastState(id('source')), 'A0');
  assert.equal((await press(gladys, device, 'color_mode', '07')).success, true);
  assert.equal(gladys.fake.lastState(id('color_mode')), '07');
  const unknown = await press(gladys, device, 'source', 'A0\rPWR OFF');
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /nothing sent/);
  const refused = await press(gladys, device, 'source', '52');
  assert.equal(refused.success, false);
  assert.match(refused.error, /Refused by .*ERR/);
  assert.deepEqual(commands(projector), ['SOURCE A0', 'CMODE 07', 'SOURCE 52']);
});

test('Source in standby: nothing sent', async (t) => {
  const { gladys, projector } = await setup(t);
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'source', 'A0');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not on \(standby\), nothing sent/);
  assert.deepEqual(commands(projector), []);
});

test('A/V mute: each press reads the state and sends the explicit opposite', async (t) => {
  const { gladys, projector } = await setup(t, { projector: { power: '01' } });
  const device = await createDevice(gladys);
  assert.equal((await press(gladys, device, 'av_mute')).success, true);
  assert.equal(gladys.fake.lastState(id('av_mute')), 1);
  assert.equal((await press(gladys, device, 'av_mute')).success, true);
  assert.equal(gladys.fake.lastState(id('av_mute')), 0);
  assert.deepEqual(commands(projector), ['MUTE ON', 'MUTE OFF']);
});

test('read-only features cannot be commanded', async (t) => {
  const { gladys } = await setup(t);
  const device = await createDevice(gladys);
  for (const key of ['power', 'status', 'lamp_hours']) {
    const ack = await press(gladys, device, key);
    assert.equal(ack.success, false, key);
  }
});

test('a password: required, then given; never in the logs nor in /data', async (t) => {
  const { gladys, app, projector, logs, store } = await setup(t, {
    projector: { password: 'S3cret!' },
  });
  await waitFor(() => gladys.fake.connectionStatus?.connected === false, 'the status');
  assert.match(gladys.fake.connectionStatus.message.en, /A password is set/);
  assert.equal(discovered(gladys), undefined);
  // Not tried again in a loop: the next round leaves it alone.
  const tries = projector.connections;
  await app.tick();
  await app.probeAddresses(false);
  assert.equal(projector.connections, tries);
  // A reconnection to Gladys does not lift the block either.
  await app.start(gladys.fake.config, { connected: true });
  assert.equal(projector.connections, tries);
  // Saving the configuration does.
  await gladys.fake.configUpdated({
    addresses: `127.0.0.1:${projector.port}`,
    password: 'S3cret!',
  });
  await waitFor(() => discovered(gladys), 'the device');
  await waitFor(() => gladys.fake.connectionStatus?.connected === true, 'connected');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!logs.some((line) => line.includes('S3cret!')));
  assert.ok(!JSON.stringify(store.data).includes('S3cret!'));
});

test('a refused password is persisted and stops the polling and the commands', async (t) => {
  const store = new MemoryStore();
  const { gladys, app, projector } = await setup(t, {
    store,
    projector: { password: 'one' },
    config: { addresses: '', password: 'one' },
  });
  // Known through the search path: typed later.
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${projector.port}`, password: 'one' });
  const device = await createDevice(gladys);
  projector.state.password = 'two';
  // The open session is closed after idleClose: the next one asks again.
  await new Promise((resolve) => setTimeout(resolve, FAST.idleClose + 100));
  await app.poll({ force: true });
  await waitFor(() => gladys.fake.connectionStatus?.connected === false, 'the status');
  assert.match(gladys.fake.connectionStatus.message.en, /Password refused/);
  await waitFor(() => Object.keys(store.data.authBlocks ?? {}).length === 1, 'the block saved');
  const tries = projector.connections;
  await app.poll({ force: true });
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /password missing or refused.*nothing sent/);
  assert.equal(projector.connections, tries, 'not tried again');
});

test('a projector that stops answering: power 0, "Unreachable", named in the status', async (t) => {
  const { gladys, app, projector } = await setup(t);
  await createDevice(gladys);
  await projector.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await app.poll({ force: true });
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('status')), 'Unreachable');
  await app.updateStatus();
  assert.match(gladys.fake.connectionStatus.message.en, /Unreachable/);
});

test('a typed address where nothing answers is named, and asked again only every minute', async (t) => {
  const port = await closedPort();
  const { gladys, app } = await setup(t, { config: { addresses: `127.0.0.1:${port}, nope_bad` } });
  await waitFor(() => gladys.fake.connectionStatus?.message, 'the status');
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /No Epson projector answers at: 127\.0\.0\.1:/,
  );
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /Ignored in the configuration \(invalid\): nope_bad/,
  );
  assert.equal(await app.probeAddresses(false), false);
});

test('the polling never asks faster than the interval', async (t) => {
  const { gladys, app, projector } = await setup(t);
  await createDevice(gladys);
  const asked = projector.received.filter((l) => l === 'PWR?').length;
  await app.poll();
  await app.poll();
  await app.start(gladys.fake.config, { connected: true });
  assert.equal(projector.received.filter((l) => l === 'PWR?').length, asked);
});

test('the search: HELLO broadcast through Gladys, only local network replies asked', async (t) => {
  const projector = await startFakeProjector();
  t.after(() => projector.close());
  const hello = helloReply('Salon').toString('base64');
  const asked = [];
  // Every address is reached through the fake projector on the loopback interface.
  const connect = ({ host }) => {
    asked.push(host);
    return netConnect({ host: '127.0.0.1', port: projector.port });
  };
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { addresses: '' },
    scanResults: {
      'udp-active-broadcast': [
        { source_ip: '192.168.1.50', source_port: 3629, payload_base64: hello },
        { source_ip: '8.8.8.8', source_port: 3629, payload_base64: hello },
        { source_ip: '127.0.0.1', source_port: 3629, payload_base64: hello },
        { source_ip: '192.168.1.51', source_port: 3629, payload_base64: 'bm90IGVzYy92cA==' },
      ],
    },
  });
  const app = new EpsonApp({
    gladys,
    store: new MemoryStore(),
    timers,
    timings: FAST,
    connect,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  const ack = await gladys.fake.action('find_projectors');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /1 projector\(s\): Salon \(192\.168\.1\.50\)/);
  assert.deepEqual(asked, ['192.168.1.50']);
  const scan = gladys.fake.scans.at(-1);
  assert.equal(scan.type, 'udp-active-broadcast');
  assert.equal(scan.port, 3629);
  assert.equal(Buffer.from(scan.payload_base64, 'base64').subarray(0, 10).toString(), 'ESC/VP.net');
  assert.equal(discovered(gladys).name, 'Salon');
});

test('"Check the projectors" reads each one', async (t) => {
  const { gladys } = await setup(t, { projector: { power: '01' } });
  await waitFor(() => discovered(gladys), 'the device');
  const ack = await gladys.fake.action('check_projectors');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /On, lamp 1234 h/);
  assert.match(ack.data.message.fr, /allumé, lampe 1234 h/);
});

test('a reconnection to Gladys publishes the status and the devices again', async (t) => {
  const { gladys, app } = await setup(t);
  await createDevice(gladys);
  const statuses = gladys.fake.connectionStatuses.length;
  await app.start(gladys.fake.config, { connected: true });
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(discovered(gladys));
});

test('a device published again keeps every feature', async (t) => {
  const { gladys, app } = await setup(t);
  const device = await createDevice(gladys);
  await app.publishDevices();
  assert.deepEqual(
    discovered(gladys).features.map((f) => f.external_id),
    device.features.map((f) => f.external_id),
  );
});

test('isLanAddress', () => {
  assert.ok(isLanAddress('192.168.1.50'));
  assert.ok(isLanAddress('10.0.0.7'));
  assert.ok(isLanAddress('172.20.1.2'));
  for (const host of [
    '8.8.8.8',
    '127.0.0.1',
    '192.168.1.255',
    '169.254.169.254',
    '224.0.0.1',
    'example.com',
  ]) {
    assert.ok(!isLanAddress(host), host);
  }
});
