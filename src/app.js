// -----------------------------------------------------------------------------
// The integration: the Epson projectors it knows (typed addresses, HELLO
// search through Gladys), the Gladys devices built from them, the polling of
// power, source, color mode, A/V mute and lamp hours, the commands
// (serialized per projector, decided on the state read again just before,
// within the 5 s Gladys gives a command), the refused passwords (persisted,
// tried again every 30 minutes, never in a loop) and the configuration screen
// buttons. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { DEVICE_TYPE, FEATURES, LIMITS, TIMINGS } from './constants.js';
import { ProjectorClient } from './escvp/client.js';
import {
  COMMANDS,
  UNREACHABLE_LABEL,
  parseCode,
  parseLampHours,
  parseMute,
  parseSerial,
  powerState,
} from './escvp/codes.js';
import { ESCVPNET_PORT, helloRequest, parseHelloReply } from './escvp/protocol.js';
import { ERROR_KINDS, ProjectorError } from './escvp/session.js';
import { T } from './i18n.js';
import {
  buildDevice,
  colorModeOptions,
  featureKey,
  projectorName,
  sourceOptions,
  stateList,
} from './model.js';
import { FileStore, emptyData, isProjectorId } from './store.js';

const AUTH_KINDS = new Set([ERROR_KINDS.AUTH_REQUIRED, ERROR_KINDS.AUTH_REFUSED]);
const PRESSES = new Set([FEATURES.POWER_ON, FEATURES.STANDBY, FEATURES.AV_MUTE]);
const short = (value) => String(value).slice(0, 32);

/**
 * Whether an address answering the search may be asked: an IPv4 address of
 * a local network (never public, loopback, broadcast, multicast nor the
 * cloud metadata address). Typed addresses are not filtered.
 */
export function isLanAddress(host) {
  if (typeof host !== 'string' || isIP(host) !== 4) {
    return false;
  }
  const [a, b, c, d] = host.split('.').map(Number);
  if (d === 255 || d === 0) {
    return false;
  }
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254 && !(c === 169 && d === 254))
  );
}

/** The id of a projector that gives no serial number: its address. */
export const addressId = ({ host, port }) =>
  `ip-${host.replace(/[^a-z0-9]/gi, '-').slice(0, 36)}${port === ESCVPNET_PORT ? '' : `-${port}`}`;

/** Resolves `{ settled: true, value }` if `promise` settles within `ms`, else `{ settled: false }`. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class EpsonApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'epson-projector' }),
    store = new FileStore(),
    connect,
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    /** id -> ProjectorClient */
    this.clients = new Map();
    /** id -> last reading (see model.js stateList) */
    this.readings = new Map();
    /** id -> time of the last poll */
    this.lastPoll = new Map();
    /** id -> { running, items, hold } */
    this.queues = new Map();
    /** address key -> { at, kind } of the last probe of a typed address */
    this.probes = new Map();
    /** ids of the devices created in Gladys */
    this.created = new Set();
    this.backgroundTimers = new Set();
    this.generation = 0;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.scanning = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys
   * (`connected`) and on every configuration save (`saved`). A save is the one
   * thing that lifts the password blocks; a reconnection to Gladys lifts
   * nothing and never makes the projectors asked sooner.
   */
  async start(raw = {}, { connected = false, saved = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = this.timers.setInterval(() => this.tick(), this.config.pollInterval * 1000);
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/epson-projector.json moved to epson-projector.json.bad');
      }
      // A saved retry time is read back bounded: never later than one retry period.
      for (const block of Object.values(this.data.authBlocks)) {
        block.retryAt = Math.min(block.retryAt, this.now() + this.timings.authRetry);
      }
    }
    if (connected) {
      // The core forgot the status and what was published: everything again.
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (saved) {
      this.liftAuthBlocks();
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('probe the addresses', () => this.probeAddresses(saved));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('poll', () => this.poll({ republish: connected }));
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handle of this.backgroundTimers) {
      this.timers.clearTimeout(handle);
    }
    this.backgroundTimers.clear();
    for (const client of this.clients.values()) {
      client.close();
    }
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  /** One timer round: the typed addresses not answering yet, then the polling. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return this.probeAddresses(false)
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.poll())
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Queue -------------------------------------------------------------------

  /**
   * One task at a time per projector. An `urgent` task (Standby) goes before
   * the tasks still waiting, never before the one running. A task may `hold`
   * the queue on a promise (a power command waiting for its answer): the next
   * tasks wait for it.
   */
  enqueue(id, task, { urgent = false } = {}) {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(id, queue);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      const holds = [];
      const hold = (promise, label) => {
        holds.push(promise);
        // Set at once: a command pressed from now on is refused without waiting.
        queue.held = label || 'busy';
      };
      try {
        item.resolve(await item.task(hold));
      } catch (err) {
        item.reject(err);
      }
      if (holds.length > 0) {
        await Promise.allSettled(holds);
        queue.held = undefined;
      }
    }
    queue.running = false;
  }

  isBusy(id) {
    const queue = this.queues.get(id);
    return Boolean(queue && (queue.running || queue.items.length > 0));
  }

  // --- Known projectors -----------------------------------------------------------

  get projectors() {
    return Object.values(this.data?.projectors ?? {});
  }

  projectorOf(device) {
    return this.projectors.find(
      (p) => this.gladys.externalIds(DEVICE_TYPE, p.id).device === device?.external_id,
    );
  }

  /** The client of a projector, recreated when its address or the password changes. */
  clientOf(projector) {
    let client = this.clients.get(projector.id);
    if (
      !client ||
      client.host !== projector.host ||
      client.port !== projector.port ||
      client.password !== this.config.password
    ) {
      client?.close();
      client = this.newClient(projector);
      this.clients.set(projector.id, client);
    }
    return client;
  }

  newClient({ host, port }) {
    return new ProjectorClient({
      host,
      port,
      password: this.config.password,
      connect: this.connect,
      connectTimeout: this.timings.connectTimeout,
      requestTimeout: this.timings.requestTimeout,
      idleClose: this.timings.idleClose,
    });
  }

  // --- Password blocks (persisted, per address) --------------------------------------

  authBlock(address) {
    const block = this.data?.authBlocks?.[addressKey(address)];
    return block && AUTH_KINDS.has(block.kind) ? block : undefined;
  }

  /** Blocked: the password is not tried again before `retryAt` (a save lifts it). */
  isAuthBlocked(address) {
    const block = this.authBlock(address);
    return Boolean(block) && this.now() < block.retryAt;
  }

  setAuthBlock(address, kind) {
    const key = addressKey(address);
    const previous = this.data.authBlocks[key];
    this.data.authBlocks[key] = { kind, retryAt: this.now() + this.timings.authRetry };
    this.persist();
    if (previous?.kind !== kind) {
      this.updateStatus().catch(() => {});
      this.logger.warn(
        `${key}: ${kind === ERROR_KINDS.AUTH_REQUIRED ? 'a password is required' : 'password refused'}; tried again in ${Math.round(this.timings.authRetry / 60_000)} minutes or when the configuration is saved`,
      );
    }
  }

  clearAuthBlock(address) {
    const key = addressKey(address);
    if (this.data.authBlocks[key]) {
      delete this.data.authBlocks[key];
      this.persist();
      this.updateStatus().catch(() => {});
      this.logger.info(`${key}: password accepted`);
    }
  }

  liftAuthBlocks() {
    if (Object.keys(this.data.authBlocks).length > 0) {
      this.data.authBlocks = Object.create(null);
      this.persist();
    }
  }

  /** Called on every failure of a session: a password problem becomes a block. */
  noteSessionError(address, err) {
    if (AUTH_KINDS.has(err?.kind)) {
      this.setAuthBlock(address, err.kind);
    }
  }

  // --- Identification and search --------------------------------------------------------

  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
    } catch (err) {
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      list = this.gladys.devices;
    }
    const byExternalId = new Map(
      this.projectors.map((p) => [this.gladys.externalIds(DEVICE_TYPE, p.id).device, p.id]),
    );
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => byExternalId.get(d?.external_id))
        .filter(Boolean),
    );
  }

  /**
   * Asks the projector at `address` who it is: `SNO?` (serial number, the
   * id when it answers one) and `PWR?` (that it speaks ESC/VP21). Remembers
   * it and returns it. Throws a ProjectorError.
   */
  async identify(address, name) {
    if (this.isAuthBlocked(address)) {
      throw new ProjectorError(
        this.authBlock(address).kind,
        'Password problem, not tried again yet',
      );
    }
    const client = this.newClient(address);
    const budget = this.timings.connectTimeout + 2 * this.timings.requestTimeout;
    let serial;
    try {
      await client.run(budget, async (session, left) => {
        try {
          serial = parseSerial(await client.query(session, COMMANDS.SERIAL, left()));
        } catch (err) {
          if (err.kind !== ERROR_KINDS.REFUSED && err.kind !== ERROR_KINDS.PROTOCOL) {
            throw err;
          }
        }
        // A new session if SNO? left the old one out of step.
        const again = client.current?.open ? session : await client.session(left());
        if (!powerState(await client.query(again, COMMANDS.POWER, left()))) {
          throw new ProjectorError(ERROR_KINDS.PROTOCOL, 'Not an ESC/VP21 power state');
        }
      });
    } catch (err) {
      this.noteSessionError(address, err);
      throw err;
    } finally {
      client.close();
    }
    this.clearAuthBlock(address);
    return this.remember(address, serial, name);
  }

  remember(address, serial, name) {
    const projectors = this.data.projectors;
    const id = serial ?? addressId(address);
    if (!isProjectorId(id)) {
      return undefined;
    }
    let projector = projectors[id];
    if (!projector) {
      if (Object.keys(projectors).length >= LIMITS.projectors) {
        this.warnOnce(
          'projectors',
          `More than ${LIMITS.projectors} projectors: the next ones are ignored`,
        );
        return undefined;
      }
      projector = { id, host: '', port: ESCVPNET_PORT, name: '', sources: [], colorModes: [] };
      projectors[id] = projector;
    }
    // Another projector that had this address lost it (DHCP): it is never
    // commanded at an address that is no longer its own.
    for (const other of this.projectors) {
      if (other.id !== id && other.host === address.host && other.port === address.port) {
        this.logger.warn(`${projectorName(other)} no longer answers at ${addressKey(address)}`);
        other.host = '';
        this.clients.get(other.id)?.close();
        this.clients.delete(other.id);
        this.readings.set(other.id, { reachable: false });
      }
    }
    Object.assign(projector, { host: address.host, port: address.port });
    if (serial) {
      projector.serial = serial;
    }
    if (typeof name === 'string' && name.trim()) {
      projector.name = name.trim().slice(0, LIMITS.name);
    }
    this.persist();
    return projector;
  }

  /** The typed addresses with no known projector: at start, then every minute. */
  async probeAddresses(force) {
    let changed = false;
    await Promise.all(
      this.config.addresses.map(async (address) => {
        if (this.projectors.some((p) => p.host === address.host && p.port === address.port)) {
          this.probes.delete(addressKey(address));
          return;
        }
        const key = addressKey(address);
        const last = this.probes.get(key)?.at ?? -Infinity;
        if (!force && this.now() - last < this.timings.probeRetry) {
          return;
        }
        if (this.isAuthBlocked(address)) {
          return;
        }
        this.probes.set(key, { at: this.now() });
        try {
          changed = Boolean(await this.identify(address)) || changed;
          this.probes.delete(key);
        } catch (err) {
          this.probes.set(key, { at: this.now(), kind: err.kind });
          this.logger.debug?.(`${key}: ${err.message}`);
        }
      }),
    );
    return changed;
  }

  /** HELLO broadcast through Gladys (UDP 3629), then the typed addresses. */
  scan() {
    if (!this.scanning) {
      this.scanning = this.doScan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async doScan() {
    const started = this.now();
    let replies = [];
    let failed = false;
    try {
      replies = await this.gladys.scanNetwork('udp-active-broadcast', {
        port: ESCVPNET_PORT,
        payload: helloRequest(),
        timeoutSeconds: this.timings.scanSeconds,
      });
    } catch (err) {
      failed = true;
      this.logger.warn(`Network search failed: ${err.message}`);
    }
    const seen = new Set();
    const toIdentify = [];
    for (const reply of (Array.isArray(replies) ? replies : []).slice(0, LIMITS.searchReplies)) {
      if (typeof reply?.payload_base64 !== 'string' || typeof reply.source_ip !== 'string') {
        continue;
      }
      // The address that answered, never one the payload would name.
      const host = reply.source_ip.replace(/^::ffff:/, '');
      if (!isLanAddress(host) || seen.has(host)) {
        continue;
      }
      const hello = parseHelloReply(Buffer.from(reply.payload_base64.slice(0, 1024), 'base64'));
      if (!hello) {
        continue;
      }
      seen.add(host);
      const address = { host, port: ESCVPNET_PORT };
      const known = this.projectors.find((p) => p.host === host && p.port === ESCVPNET_PORT);
      if (known) {
        if (hello.projectorName && !known.name) {
          known.name = hello.projectorName.slice(0, LIMITS.name);
          this.persist();
        }
        continue;
      }
      toIdentify.push({ address, name: hello.projectorName });
    }
    // A few at a time, none started after the deadline: the action of Gladys
    // (60 s) always gets its answer.
    let skipped = 0;
    await mapLimit(toIdentify, this.timings.scanConcurrency, async ({ address, name }) => {
      if (this.now() - started > this.timings.scanDeadline) {
        skipped += 1;
        return;
      }
      try {
        await this.identify(address, name);
      } catch (err) {
        this.logger.debug?.(`${address.host}: ${err.message}`);
      }
    });
    if (skipped > 0) {
      this.logger.warn(`Search: ${skipped} answer(s) not checked in time`);
    }
    if (this.now() - started <= this.timings.scanDeadline) {
      await this.probeAddresses(true);
    }
    await this.publishDevices();
    return { failed, skipped };
  }

  /**
   * The codes in the dropdowns of the device created in Gladys
   * (`gladys.devices`, kept up to date by the SDK), merged into the known
   * projector: codes seen before a reset of /data are never dropped.
   */
  mergeCreatedOptions(projector) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, projector.id).device;
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    for (const [key, field, known] of [
      [FEATURES.SOURCE, 'sources', sourceOptions],
      [FEATURES.COLOR_MODE, 'colorModes', colorModeOptions],
    ]) {
      const feature = (Array.isArray(created?.features) ? created.features : []).find(
        (f) => f?.external_id === `${externalId}:${key}`,
      );
      for (const option of Array.isArray(feature?.supported_options)
        ? feature.supported_options
        : []) {
        this.addCode(projector, field, known, parseCode(option?.value));
      }
    }
  }

  /** Adds a code seen on the projector to a dropdown; true when it was new. */
  addCode(projector, field, known, code) {
    if (!code || known(projector).some((o) => o.value === code)) {
      return false;
    }
    if (projector[field].length >= LIMITS.extraOptions) {
      this.warnOnce(`${field}:${projector.id}`, `${projectorName(projector)}: too many ${field}`);
      return false;
    }
    projector[field].push(code);
    this.persist();
    return true;
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const projectors = this.projectors;
    projectors.forEach((p) => this.mergeCreatedOptions(p));
    await this.gladys.publishDiscoveredDevices(projectors.map((p) => buildDevice(this.gladys, p)));
  }

  // --- Polling -----------------------------------------------------------------------

  /**
   * Every created projector with an address, at most once per poll interval
   * (`force` for a device just created and after a command), skipped while a
   * command holds its queue.
   */
  poll({ force = false, republish = false } = {}) {
    const interval = this.config.pollInterval * 1000;
    return Promise.all(
      this.projectors
        .filter((p) => this.created.has(p.id) && p.host)
        .map((p) => {
          const last = this.lastPoll.get(p.id) ?? -Infinity;
          if (!force && this.now() - last < interval * 0.9) {
            // Not asked again sooner: the last reading is published again when Gladys forgot it.
            return republish ? this.publishStates(p) : undefined;
          }
          if (this.isBusy(p.id)) {
            return undefined;
          }
          return this.readState(p);
        }),
    );
  }

  readState(projector) {
    if (this.isBusy(projector.id)) {
      return Promise.resolve(this.readings.get(projector.id));
    }
    return this.enqueue(projector.id, () => this.read(projector)).then(async (reading) => {
      if (reading !== undefined) {
        this.readings.set(projector.id, reading);
      }
      await this.publishStates(projector);
      return reading;
    });
  }

  /**
   * One reading: `PWR?` always, `SOURCE?`, `CMODE?` and `MUTE?` when the
   * projector is on, `LAMP?` always (a question the model refuses is left
   * out). Returns the reading, `{ reachable: false }` when nothing answers,
   * undefined when nothing can be said (password, busy, unexpected answer).
   */
  async read(projector) {
    this.lastPoll.set(projector.id, this.now());
    if (!projector.host || this.isAuthBlocked(projector)) {
      return undefined;
    }
    const client = this.clientOf(projector);
    const wasReachable = this.readings.get(projector.id)?.reachable === true;
    try {
      const reading = await client.run(this.timings.readBudget, async (session, left) => {
        const optional = async (command) => {
          try {
            return await client.query(session, command, left());
          } catch (err) {
            if (err.kind === ERROR_KINDS.REFUSED) {
              return undefined;
            }
            throw err;
          }
        };
        if (projector.serial && !wasReachable) {
          // Back online (or first reading of this run): make sure the address
          // still belongs to this projector before anything is published.
          const identity = await this.checkIdentity(projector, client, session, left());
          if (identity !== 'ok') {
            return { identity };
          }
        }
        const power = powerState(await client.query(session, COMMANDS.POWER, left()));
        if (!power) {
          throw new ProjectorError(ERROR_KINDS.PROTOCOL, 'Unexpected power state');
        }
        const result = { reachable: true, power };
        if (power.code === '01') {
          result.source = parseCode(await optional(COMMANDS.SOURCE));
          result.colorMode = parseCode(await optional(COMMANDS.COLOR_MODE));
          result.muted = parseMute(await optional(COMMANDS.MUTE));
        }
        result.lampHours = parseLampHours(await optional(COMMANDS.LAMP));
        return result;
      });
      this.clearAuthBlock(projector);
      if (reading.identity === 'moved') {
        this.forgetAddress(projector);
        return { reachable: false };
      }
      if (reading.identity === 'unconfirmed') {
        // No serial number answered: maybe another projector. Nothing is
        // published nor commanded until it gives this projector's serial again.
        this.warnOnce(
          `identity:${projector.id}`,
          `${projectorName(projector)}: no serial number at ${projector.host}, identity not confirmed`,
        );
        return undefined;
      }
      this.noteCodes(projector, reading);
      return reading;
    } catch (err) {
      this.noteSessionError(projector, err);
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        return { reachable: false };
      }
      if (!AUTH_KINDS.has(err.kind)) {
        this.warnOnce(
          `read:${projector.id}:${err.kind}`,
          `${projectorName(projector)}: ${err.message}`,
        );
      }
      return undefined;
    }
  }

  /** Codes read that the dropdowns do not list yet are added to them. */
  noteCodes(projector, reading) {
    const source = this.addCode(projector, 'sources', sourceOptions, reading.source);
    const colorMode = this.addCode(projector, 'colorModes', colorModeOptions, reading.colorMode);
    if (source || colorMode) {
      this.publishDevices().catch((err) =>
        this.logger.warn(`Could not publish the devices: ${err.message}`),
      );
    }
  }

  async publishStates(projector) {
    if (!this.created.has(projector.id)) {
      return;
    }
    const states = stateList(
      this.gladys,
      projector,
      this.readings.get(projector.id),
      UNREACHABLE_LABEL,
    );
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(
        `Could not publish the states of ${projectorName(projector)}: ${err.message}`,
      );
    }
  }

  /**
   * Merges the values just read or set into the last reading, and publishes
   * them without waiting: the ack of a command never depends on Gladys
   * taking its states.
   */
  update(projector, values) {
    const previous = this.readings.get(projector.id);
    this.readings.set(projector.id, {
      ...(previous?.reachable ? previous : {}),
      reachable: true,
      ...values,
    });
    this.publishStates(projector).catch(() => {});
  }

  /** Whether the projector was asked less than one poll interval ago (answered or not). */
  readRecently(projector) {
    const last = this.lastPoll.get(projector.id) ?? -Infinity;
    return this.now() - last < this.config.pollInterval * 1000 * 0.9;
  }

  /**
   * After a time without answer, the serial number is read again: `ok`, or
   * `moved` (another serial at this address), or `unconfirmed` (no serial
   * answered: maybe another projector, never taken for this one).
   */
  async checkIdentity(projector, client, session, budget) {
    let serial;
    try {
      serial = parseSerial(await client.query(session, COMMANDS.SERIAL, budget));
    } catch (err) {
      if (err.kind !== ERROR_KINDS.REFUSED) {
        throw err;
      }
    }
    if (!serial) {
      return 'unconfirmed';
    }
    return serial === projector.serial ? 'ok' : 'moved';
  }

  /** The address now answers with another serial: it is no longer this projector's. */
  forgetAddress(projector) {
    this.logger.warn(`${projectorName(projector)}: another projector answers at ${projector.host}`);
    projector.host = '';
    this.clients.get(projector.id)?.close();
    this.clients.delete(projector.id);
    this.persist();
  }

  recheck(projector, delay = this.timings.recheckDelay) {
    this.later(async () => {
      this.lastPoll.delete(projector.id);
      await this.readState(projector);
      await this.updateStatus();
    }, delay);
  }

  // --- Commands --------------------------------------------------------------------

  async setValue(device, feature, value) {
    const projector = this.projectorOf(device);
    if (!projector) {
      throw new Error(`Unknown projector ${short(device?.external_id)}`);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    let code;
    if (key === FEATURES.SOURCE || key === FEATURES.COLOR_MODE) {
      code = parseCode(value);
      const options =
        key === FEATURES.SOURCE ? sourceOptions(projector) : colorModeOptions(projector);
      if (!code || !options.some((o) => o.value === code)) {
        throw new Error(
          `Unknown ${key === FEATURES.SOURCE ? 'source' : 'color mode'} "${short(value)}", nothing sent`,
        );
      }
    } else if (!PRESSES.has(key)) {
      throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
    const held = this.queues.get(projector.id)?.held;
    if (held) {
      // A power command waits for its answer: refused at once, never queued.
      throw new ProjectorError(
        ERROR_KINDS.BUDGET,
        `${projectorName(projector)} is ${held} (power command in progress), nothing sent`,
      );
    }
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    const context = { late: false, mayHaveSent: false };
    const run = this.enqueue(
      projector.id,
      async (hold) => {
        if (context.late || this.remaining(started) < 50) {
          // Gladys stopped waiting while this command was queued: dropped, never sent late.
          context.late = true;
          throw new ProjectorError(
            ERROR_KINDS.BUDGET,
            `${projectorName(projector)} is busy (a power command in progress?): nothing sent`,
          );
        }
        return this.command(projector, key, code, started, context, hold);
      },
      { urgent: key === FEATURES.STANDBY },
    );
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          context.late = true;
          reject(
            context.mayHaveSent
              ? new ProjectorError(
                  ERROR_KINDS.TIMEOUT,
                  'Sent, without confirmation from the projector',
                  {
                    sent: true,
                  },
                )
              : new ProjectorError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command, nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  async command(projector, key, code, started, context, hold) {
    const name = projectorName(projector);
    if (!projector.host) {
      throw new ProjectorError(
        ERROR_KINDS.UNREACHABLE,
        `${name}: address unknown, type it or use "Find the projectors"; nothing sent`,
      );
    }
    if (this.isAuthBlocked(projector)) {
      throw new ProjectorError(
        this.authBlock(projector).kind,
        `${name}: password missing or refused (see the configuration), nothing sent`,
      );
    }
    const client = this.clientOf(projector);
    const left = () => this.remaining(started);
    const readBefore = (session, command, what) =>
      this.readBefore(client, session, command, what, Math.min(this.timings.preRead, left()));
    const send = (session, command, timeoutMs = left()) => {
      // Checked just before the bytes leave: never after Gladys was told "nothing sent".
      if (context.late || left() < this.timings.minSendTime) {
        throw new ProjectorError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
      }
      context.mayHaveSent = true;
      return client.set(session, command, timeoutMs);
    };
    let outcome;
    try {
      outcome = await client.run(left(), async (session) => {
        if (projector.serial && this.readings.get(projector.id)?.reachable !== true) {
          // Not answered since the last check (or since the start): the
          // address must still be this projector's before anything is sent.
          let identity;
          try {
            identity = await this.checkIdentity(
              projector,
              client,
              session,
              Math.min(this.timings.preRead, left()),
            );
          } catch (err) {
            throw this.readError(err, 'Serial number');
          }
          if (identity === 'moved') {
            this.forgetAddress(projector);
            this.readings.set(projector.id, { reachable: false });
            throw new Error(`${name}: another projector answers at its address, nothing sent`);
          }
          if (identity === 'unconfirmed') {
            throw new Error(
              `${name}: identity not confirmed (no serial number answered), nothing sent`,
            );
          }
        }
        const power = powerState(await readBefore(session, COMMANDS.POWER, 'Power state'));
        if (!power) {
          throw new ProjectorError(ERROR_KINDS.PROTOCOL, 'Unexpected power state, nothing sent');
        }
        this.update(projector, { power });
        switch (key) {
          case FEATURES.POWER_ON:
            if (power.on === true) {
              return undefined;
            }
            if (!power.canPowerOn) {
              throw new Error(`${name}: ${power.label.toLowerCase()}, nothing sent`);
            }
            return this.power(projector, session, 'PWR ON', this.timings.powerOnWait, {
              left,
              send,
              hold,
            });
          case FEATURES.STANDBY:
            if (power.inStandby) {
              return undefined;
            }
            if (power.code !== '01') {
              throw new Error(`${name}: ${power.label.toLowerCase()}, nothing sent`);
            }
            return this.power(projector, session, 'PWR OFF', this.timings.powerOffWait, {
              left,
              send,
              hold,
            });
          case FEATURES.SOURCE:
          case FEATURES.COLOR_MODE: {
            if (power.code !== '01') {
              throw new Error(`${name}: not on (${power.label.toLowerCase()}), nothing sent`);
            }
            const command = key === FEATURES.SOURCE ? COMMANDS.SOURCE : COMMANDS.COLOR_MODE;
            await send(session, `${command} ${code}`);
            this.update(
              projector,
              key === FEATURES.SOURCE ? { source: code } : { colorMode: code },
            );
            this.recheck(projector);
            return undefined;
          }
          case FEATURES.AV_MUTE: {
            if (power.code !== '01') {
              throw new Error(`${name}: not on (${power.label.toLowerCase()}), nothing sent`);
            }
            // Gladys sends a press, not a target: the mute is read just before
            // and the explicit opposite is sent, never a toggle.
            const muted = parseMute(await readBefore(session, COMMANDS.MUTE, 'A/V mute state'));
            if (muted === undefined) {
              throw new Error(`${name}: A/V mute state unknown, nothing sent`);
            }
            await send(session, `${COMMANDS.MUTE} ${muted ? 'OFF' : 'ON'}`);
            this.update(projector, { muted: !muted });
            return undefined;
          }
          default:
            throw new Error(`Feature "${short(key)}" cannot be commanded`);
        }
      });
    } catch (err) {
      this.noteSessionError(projector, err);
      throw this.commandError(name, err, context);
    }
    if (outcome?.unconfirmed) {
      // Thrown here, outside the session task: the session stays open for the
      // answer the projector gives after its warm-up or cool-down.
      throw new ProjectorError(ERROR_KINDS.TIMEOUT, outcome.unconfirmed, { sent: true });
    }
    return undefined;
  }

  /**
   * A read made before a command: whatever goes wrong, nothing was sent.
   * Unreachable, refused (ERR) and password errors keep their kind.
   */
  async readBefore(client, session, command, what, budget) {
    try {
      return await client.query(session, command, budget);
    } catch (err) {
      throw this.readError(err, what);
    }
  }

  readError(err, what) {
    if (!(err instanceof ProjectorError)) {
      return err;
    }
    if (err.kind === ERROR_KINDS.UNREACHABLE || AUTH_KINDS.has(err.kind)) {
      return err;
    }
    if (err.kind === ERROR_KINDS.REFUSED) {
      return new ProjectorError(err.kind, `${what} not readable (ERR), nothing sent`);
    }
    return new ProjectorError(err.kind, `${what} not read in time, nothing sent`);
  }

  /**
   * A power command: the projector answers it only once warm-up or cool-down
   * is over. Answered within the budget: done. Otherwise Gladys is told
   * "sent, without confirmation yet" (exactly what is known), the answer is
   * waited for in the background (the queue of the projector held, the other
   * commands refused at once), then the state is read again.
   */
  async power(projector, session, command, wait, { left, send, hold }) {
    const answer = send(session, command, wait);
    answer.catch(() => {});
    const result = await within(answer, left() - 100);
    if (result.settled) {
      this.recheck(projector);
      return undefined;
    }
    const phase = command === 'PWR ON' ? 'warming up' : 'cooling down';
    hold(
      answer.then(
        () => this.recheck(projector, 0),
        (err) => {
          this.logger.warn(
            `${projectorName(projector)}: ${command} not confirmed (${err.message})`,
          );
          this.recheck(projector, 0);
        },
      ),
      phase,
    );
    return {
      unconfirmed: `Sent; ${projectorName(projector)} confirms it after ${phase} (up to ${Math.round(wait / 1000)} s): without confirmation yet`,
    };
  }

  /** The error Gladys gets: "nothing sent" or "sent, without confirmation", exactly. */
  commandError(name, err, context) {
    if (!(err instanceof ProjectorError)) {
      return err;
    }
    if (err.kind === ERROR_KINDS.REFUSED) {
      return new ProjectorError(
        err.kind,
        context.mayHaveSent
          ? `Refused by ${name} (ERR): not available on this model or in this state`
          : `${name}: ${err.message.replace(/,? nothing sent$/, '')}, nothing sent`,
      );
    }
    if (err.sent && context.mayHaveSent) {
      return new ProjectorError(err.kind, 'Sent, without confirmation from the projector', {
        sent: true,
      });
    }
    if (err.kind === ERROR_KINDS.UNREACHABLE) {
      return new ProjectorError(
        err.kind,
        `${name} does not answer (off, standby without network?), nothing sent`,
      );
    }
    if (AUTH_KINDS.has(err.kind)) {
      return new ProjectorError(
        err.kind,
        `${name}: password missing or refused (see the configuration), nothing sent`,
      );
    }
    return new ProjectorError(
      err.kind,
      `${name}: ${err.message.replace(/,? nothing sent$/, '')}, nothing sent`,
    );
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(device) {
    const projector = this.projectorOf(device);
    if (!projector) {
      return;
    }
    this.created.add(projector.id);
    // Created or updated: this projector only, and never read sooner than the
    // interval (the last reading is published again instead).
    if (projector.host && !this.readRecently(projector)) {
      await this.readState(projector);
    } else {
      await this.publishStates(projector);
    }
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    const projector = this.projectorOf(device);
    if (projector) {
      this.created.delete(projector.id);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findProjectors() {
    const { failed, skipped } = await this.scan();
    await this.updateStatus();
    const parts = [];
    if (failed) {
      parts.push(T.searchFailed);
    }
    if (skipped > 0) {
      parts.push(T.searchPartial(skipped));
    }
    parts.push(T.found(this.projectors.map((p) => `${projectorName(p)} (${p.host || '?'})`)));
    return { en: parts.map((p) => p.en).join(' '), fr: parts.map((p) => p.fr).join(' ') };
  }

  async checkProjectors() {
    if (this.projectors.length === 0) {
      return T.noProjector;
    }
    const lines = await mapLimit(this.projectors, this.timings.checkConcurrency, async (p) => {
      const label = `${projectorName(p)} (${p.host || '?'})`;
      if (this.isAuthBlocked(p)) {
        return T.checkLine(label, undefined, T.passwordProblem);
      }
      if (this.isBusy(p.id)) {
        return T.checkLine(label, undefined, T.busy);
      }
      // Never read sooner than the interval: a recent reading is shown as is.
      return T.checkLine(
        label,
        this.readRecently(p) ? this.readings.get(p.id) : await this.readState(p),
      );
    });
    await this.updateStatus();
    return T.check(lines);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    if (this.config.passwordInvalid) {
      notes.push(T.passwordInvalid);
    }
    const label = (key) => {
      const projector = this.projectors.find((p) => p.host && addressKey(p) === key);
      return projector ? projectorName(projector) : key;
    };
    const blocked = (kind) =>
      Object.entries(this.data.authBlocks)
        .filter(([, block]) => block.kind === kind)
        .map(([key]) => label(key));
    const required = blocked(ERROR_KINDS.AUTH_REQUIRED);
    const refused = blocked(ERROR_KINDS.AUTH_REFUSED);
    if (required.length > 0) {
      notes.push(T.authRequired(required));
    }
    if (refused.length > 0) {
      notes.push(T.authRefused(refused));
    }
    const silent = this.config.addresses
      .filter(
        (a) =>
          this.probes.get(addressKey(a))?.kind &&
          !AUTH_KINDS.has(this.probes.get(addressKey(a)).kind),
      )
      .map(addressKey);
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const lost = this.projectors
      .filter((p) => this.created.has(p.id) && !p.host)
      .map(projectorName);
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost));
    }
    const off = this.projectors
      .filter(
        (p) => this.created.has(p.id) && p.host && this.readings.get(p.id)?.reachable === false,
      )
      .map(projectorName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration: "connected" means running, unless a password stops a projector.
    const status = { connected: required.length + refused.length === 0 };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
