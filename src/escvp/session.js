// -----------------------------------------------------------------------------
// One ESC/VP.net session with a projector: a TCP connection to port 3629, the
// CONNECT handshake (with the password when one is set), then ESC/VP21
// requests one at a time. Ported from epson-projector (pszafer, MIT):
// `escvpnet/escvpnet.py` (connect) and `projector_tcp.py` (the listener that
// reads up to ':' and skips the pushed IMEVENT messages).
//
// Hostile input: an answer frame is 512 bytes at most, the handshake 16 + 8 x
// 18 bytes; anything longer, or not ESC/VP.net, closes the session. A request
// that timed out closes the session too, so that its late answer can never
// settle the next request. The password is never logged nor put in an error.
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';
import {
  COLON,
  HEADER_SIZE,
  MESSAGE_SIZE,
  MESSAGE_TYPES,
  STATUS,
  connectRequest,
  parseFrame,
  parseMessageHead,
} from './protocol.js';

export const MAX_FRAME = 512;

export const ERROR_KINDS = Object.freeze({
  /** No TCP connection (refused, no route, timeout): nothing reached the projector. */
  UNREACHABLE: 'unreachable',
  /** Connected, but no valid CONNECT answer in time: nothing sent but the handshake. */
  NO_ANSWER: 'no_answer',
  /** The projector asks for a password and none is configured. */
  AUTH_REQUIRED: 'auth_required',
  /** The projector refused the configured password. */
  AUTH_REFUSED: 'auth_refused',
  /** The projector says it is busy (another session...). */
  BUSY: 'busy',
  /** The answer is not ESC/VP.net, or too long. */
  PROTOCOL: 'protocol',
  /** A request was sent and not answered in time: it may have been executed. */
  TIMEOUT: 'timeout',
  /** The connection closed after a request was sent: it may have been executed. */
  CLOSED: 'closed',
  /** The projector answered ERR. */
  REFUSED: 'refused',
  /** No time left: nothing sent. */
  BUDGET: 'budget',
});

export class ProjectorError extends Error {
  constructor(kind, message, { sent = false } = {}) {
    super(message);
    this.name = 'ProjectorError';
    this.kind = kind;
    /** Whether the command may have reached the projector. */
    this.sent = sent;
  }
}

const COMMAND = /^[A-Z][A-Z0-9_]{0,15}(?:\?| [0-9A-Z ]{1,16})$/;

const STATUS_ERRORS = new Map([
  [STATUS.UNAUTHORIZED, [ERROR_KINDS.AUTH_REQUIRED, 'The projector asks for a password']],
  [STATUS.FORBIDDEN, [ERROR_KINDS.AUTH_REFUSED, 'The projector refused the password']],
  [STATUS.SERVICE_UNAVAILABLE, [ERROR_KINDS.BUSY, 'The projector is busy']],
]);

export class Session {
  /**
   * Opens a session within `timeoutMs` (TCP connection and handshake).
   * Rejects with a ProjectorError.
   */
  static open({ host, port, password, timeoutMs, connect = netConnect }) {
    const session = new Session();
    return session.start({ host, port, password, timeoutMs, connect }).then(() => session);
  }

  constructor() {
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.closed = false;
    this.pending = undefined;
    /** Called with the value of every pushed IMEVENT (power status, warnings). */
    this.onEvent = undefined;
  }

  get open() {
    return this.ready && !this.closed;
  }

  start({ host, port, password, timeoutMs, connect }) {
    // Built first: an invalid password throws before anything is sent.
    const hello = connectRequest(password);
    return new Promise((resolve, reject) => {
      let connected = false;
      const fail = (kind, message) => {
        clearTimeout(timer);
        this.destroy();
        reject(new ProjectorError(kind, message));
      };
      const timer = setTimeout(
        () =>
          connected
            ? fail(ERROR_KINDS.NO_ANSWER, 'The projector did not open an ESC/VP.net session')
            : fail(ERROR_KINDS.UNREACHABLE, 'No connection to the projector (timeout)'),
        Math.max(1, timeoutMs),
      );
      this.handshake = { resolve, fail, done: () => clearTimeout(timer) };
      try {
        this.socket = connect({ host, port });
      } catch {
        fail(ERROR_KINDS.UNREACHABLE, 'No connection to the projector');
        return;
      }
      this.socket.setNoDelay?.(true);
      this.socket.on('connect', () => {
        connected = true;
        this.socket.write(hello);
      });
      this.socket.on('data', (chunk) => this.receive(chunk));
      this.socket.on('error', (err) => {
        if (!this.ready) {
          fail(
            connected ? ERROR_KINDS.NO_ANSWER : ERROR_KINDS.UNREACHABLE,
            `No connection to the projector (${err.code ?? 'network error'})`,
          );
        }
      });
      this.socket.on('close', () => {
        if (!this.ready && !this.closed) {
          fail(
            connected ? ERROR_KINDS.NO_ANSWER : ERROR_KINDS.UNREACHABLE,
            'The projector closed the connection',
          );
        }
        this.closed = true;
        this.rejectPending(ERROR_KINDS.CLOSED, 'The projector closed the connection');
      });
    });
  }

  receive(chunk) {
    if (this.closed) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (!this.ready) {
      this.receiveHandshake();
      return;
    }
    this.receiveFrames();
  }

  receiveHandshake() {
    if (this.buffer.length < MESSAGE_SIZE) {
      return;
    }
    const head = parseMessageHead(this.buffer.subarray(0, MESSAGE_SIZE));
    if (!head || head.type !== MESSAGE_TYPES.CONNECT) {
      this.handshake.fail(ERROR_KINDS.PROTOCOL, 'Not an ESC/VP.net answer');
      return;
    }
    if (head.status !== STATUS.OK) {
      const [kind, message] = STATUS_ERRORS.get(head.status) ?? [
        ERROR_KINDS.PROTOCOL,
        `The projector refused the session (status 0x${head.status.toString(16)})`,
      ];
      this.handshake.fail(kind, message);
      return;
    }
    const size = MESSAGE_SIZE + head.headerCount * HEADER_SIZE;
    if (this.buffer.length < size) {
      return;
    }
    this.buffer = this.buffer.subarray(size);
    this.ready = true;
    this.handshake.done();
    this.handshake.resolve();
    this.handshake = undefined;
    if (this.buffer.length > 0) {
      this.receiveFrames();
    }
  }

  receiveFrames() {
    let end = this.buffer.indexOf(COLON);
    while (end !== -1) {
      if (end + 1 > MAX_FRAME) {
        // Bounded before parsing, whatever arrived in one chunk.
        this.destroy();
        this.rejectPending(ERROR_KINDS.PROTOCOL, 'Answer too long');
        return;
      }
      const frame = parseFrame(this.buffer.subarray(0, end + 1));
      this.buffer = this.buffer.subarray(end + 1);
      if (frame.kind === 'event') {
        try {
          this.onEvent?.(frame.value);
        } catch {
          // A listener error never breaks the session.
        }
      } else if (this.pending) {
        const { resolve } = this.pending;
        clearTimeout(this.pending.timer);
        this.pending = undefined;
        resolve(frame);
      }
      // Anything else (an answer nobody waits for) is dropped.
      end = this.buffer.indexOf(COLON);
    }
    if (this.buffer.length > MAX_FRAME) {
      this.destroy();
      this.rejectPending(ERROR_KINDS.PROTOCOL, 'Answer too long');
    }
  }

  /**
   * Sends one ESC/VP21 command (`PWR?`, `SOURCE 30`) and resolves with its
   * parsed answer frame. ERR rejects with REFUSED.
   */
  request(command, timeoutMs) {
    if (typeof command !== 'string' || !COMMAND.test(command)) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.PROTOCOL, 'Invalid command'));
    }
    if (!this.open) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.UNREACHABLE, 'Session closed'));
    }
    if (this.pending) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.BUSY, 'A request is in progress'));
    }
    if (!(timeoutMs > 0)) {
      return Promise.reject(new ProjectorError(ERROR_KINDS.BUDGET, 'No time left, nothing sent'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        // Closed: a late answer must never settle the next request.
        this.destroy();
        reject(
          new ProjectorError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the projector', {
            sent: true,
          }),
        );
      }, timeoutMs);
      this.pending = {
        timer,
        resolve: (frame) =>
          frame.kind === 'error'
            ? reject(new ProjectorError(ERROR_KINDS.REFUSED, 'Refused by the projector (ERR)'))
            : resolve(frame),
        reject,
      };
      this.socket.write(`${command}\r`);
    });
  }

  rejectPending(kind, message) {
    if (this.pending) {
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = undefined;
      reject(new ProjectorError(kind, message, { sent: true }));
    }
  }

  destroy() {
    this.closed = true;
    this.socket?.destroy();
  }

  close() {
    this.destroy();
    this.rejectPending(ERROR_KINDS.CLOSED, 'Session closed');
  }
}
