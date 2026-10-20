// -----------------------------------------------------------------------------
// The client of one projector address: opens an ESC/VP.net session when one
// is needed, reuses it while it is used, and closes it after `idleClose` of
// silence (a projector accepts few sessions at once: it is not kept forever).
// Callers serialize their calls (the app queue); every call is bounded by the
// budget it is given.
// -----------------------------------------------------------------------------

import { ESCVPNET_PORT } from './protocol.js';
import { ERROR_KINDS, ProjectorError, Session } from './session.js';

export class ProjectorClient {
  constructor({
    host,
    port = ESCVPNET_PORT,
    password = '',
    connect,
    connectTimeout = 3_000,
    requestTimeout = 3_000,
    idleClose = 10_000,
  }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.connect = connect;
    this.connectTimeout = connectTimeout;
    this.requestTimeout = requestTimeout;
    this.idleClose = idleClose;
    this.current = undefined;
    this.idleTimer = undefined;
    /** Called with the value of every pushed IMEVENT. */
    this.onEvent = undefined;
  }

  async session(budget) {
    this.clearIdle();
    if (this.current?.open) {
      return this.current;
    }
    this.current = undefined;
    if (!(budget > 0)) {
      throw new ProjectorError(ERROR_KINDS.BUDGET, 'No time left, nothing sent');
    }
    const session = await Session.open({
      host: this.host,
      port: this.port,
      password: this.password || undefined,
      timeoutMs: Math.min(this.connectTimeout, budget),
      ...(this.connect ? { connect: this.connect } : {}),
    });
    session.onEvent = (value) => this.onEvent?.(value);
    this.current = session;
    return session;
  }

  /** Runs `task(session, budgetLeft)` within `budget` ms, then arms the idle close. */
  async run(budget, task) {
    const started = Date.now();
    try {
      const session = await this.session(budget);
      return await task(session, () => budget - (Date.now() - started));
    } catch (err) {
      if (err.kind !== ERROR_KINDS.REFUSED && err.kind !== ERROR_KINDS.BUDGET) {
        // Any other failure may have left the session out of step: a new one next time.
        this.close();
      }
      throw err;
    } finally {
      this.armIdle();
    }
  }

  /**
   * `COMMAND?` -> its value. An answer for another command (out of step)
   * closes the session.
   */
  async query(session, command, budget) {
    const frame = await session.request(`${command}?`, Math.min(this.requestTimeout, budget));
    if (frame.kind !== 'value' || frame.command !== command) {
      this.close();
      throw new ProjectorError(ERROR_KINDS.PROTOCOL, `Unexpected answer to ${command}?`);
    }
    return frame.value;
  }

  /** `COMMAND VALUE`, answered ':' (anything else closes the session). */
  async set(session, command, timeoutMs) {
    const frame = await session.request(command, timeoutMs);
    if (frame.kind !== 'ok') {
      this.close();
      throw new ProjectorError(
        ERROR_KINDS.PROTOCOL,
        'Unexpected answer: sent, without confirmation from the projector',
        { sent: true },
      );
    }
  }

  clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  armIdle() {
    this.clearIdle();
    if (!this.current) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Never under a request in progress (a long power command).
      if (this.current && !this.current.pending) {
        this.close();
      } else {
        this.armIdle();
      }
    }, this.idleClose);
    this.idleTimer.unref?.();
  }

  close() {
    this.clearIdle();
    const session = this.current;
    this.current = undefined;
    session?.close();
  }
}
