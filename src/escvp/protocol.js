// -----------------------------------------------------------------------------
// ESC/VP.net, the network wrapper Epson publishes around its ESC/VP21 command
// set (pure, no I/O). Ported from epson-projector (pszafer, MIT, see
// THIRD_PARTY_NOTICES.md): `escvpnet/message.py`, `escvpnet/headers.py` and
// `escvpnet/escvpnet.py`.
//
// A message is a 16-byte header:
//   "ESC/VP.net" (10 bytes), version 0x10, type, 2 reserved bytes, status,
//   header count
// followed by `count` headers of 18 bytes: id, attribute, 16 bytes of info
// (NUL padded). After a CONNECT answered OK, the same TCP socket carries plain
// ESC/VP21: `COMMAND?\r` answered `COMMAND=VALUE\r:`, `COMMAND VALUE\r`
// answered `:`, `ERR\r:` for a refused command.
// -----------------------------------------------------------------------------

export const ESCVPNET_PORT = 3629;
export const IDENTIFIER = Buffer.from('ESC/VP.net', 'ascii');
export const VERSION = 0x10;
export const MESSAGE_SIZE = 16;
export const HEADER_SIZE = 18;
/** More headers than this in an answer is not ESC/VP.net. */
export const MAX_HEADERS = 8;

export const MESSAGE_TYPES = Object.freeze({ HELLO: 1, PASSWORD: 2, CONNECT: 3 });

export const STATUS = Object.freeze({
  REQUEST: 0x00,
  OK: 0x20,
  BAD_REQUEST: 0x40,
  /** A password is required. */
  UNAUTHORIZED: 0x41,
  /** The password is wrong. */
  FORBIDDEN: 0x43,
  REQUEST_NOT_ALLOWED: 0x45,
  /** The projector is busy. */
  SERVICE_UNAVAILABLE: 0x53,
  PROTOCOL_VERSION_NOT_SUPPORTED: 0x55,
});

export const HEADER_IDS = Object.freeze({
  PASSWORD: 1,
  NEW_PASSWORD: 2,
  PROJECTOR_NAME: 3,
  IM_TYPE: 4,
  PROJECTOR_COMMAND_TYPE: 5,
});

/** The password ESC/VP.net carries: 16 ASCII characters at most. */
export function isValidPassword(password) {
  return typeof password === 'string' && password.length <= 16 && /^[\x20-\x7e]*$/.test(password);
}

function header(id, attribute, info = Buffer.alloc(0)) {
  const buffer = Buffer.alloc(HEADER_SIZE);
  buffer[0] = id;
  buffer[1] = attribute;
  info.copy(buffer, 2, 0, Math.min(info.length, 16));
  return buffer;
}

/** One request message: `type`, status REQUEST, the given headers. */
export function buildMessage(type, headers = []) {
  const head = Buffer.alloc(MESSAGE_SIZE);
  IDENTIFIER.copy(head, 0);
  head[10] = VERSION;
  head[11] = type;
  // bytes 12-13 reserved (0), byte 14 status REQUEST (0)
  head[15] = headers.length;
  return Buffer.concat([head, ...headers]);
}

/** The HELLO request (the UDP search). */
export const helloRequest = () => buildMessage(MESSAGE_TYPES.HELLO);

/**
 * The CONNECT request that opens an ESC/VP21 session. Without a password, no
 * header (as epson-projector); with one, a PASSWORD header (attribute 1).
 */
export function connectRequest(password) {
  if (!password) {
    return buildMessage(MESSAGE_TYPES.CONNECT);
  }
  if (!isValidPassword(password)) {
    throw new RangeError('The ESC/VP.net password holds 16 ASCII characters at most');
  }
  return buildMessage(MESSAGE_TYPES.CONNECT, [
    header(HEADER_IDS.PASSWORD, 1, Buffer.from(password, 'ascii')),
  ]);
}

/**
 * The fixed part of an answer: `{ type, status, headerCount }`, or undefined
 * when these 16 bytes are not an ESC/VP.net 1.0 message.
 */
export function parseMessageHead(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MESSAGE_SIZE) {
    return undefined;
  }
  if (!buffer.subarray(0, 10).equals(IDENTIFIER) || buffer[10] !== VERSION) {
    return undefined;
  }
  const headerCount = buffer[15];
  if (headerCount > MAX_HEADERS) {
    return undefined;
  }
  return { type: buffer[11], status: buffer[14], headerCount };
}

/** Printable ASCII of a NUL padded info field (control characters dropped). */
function infoText(info) {
  const end = info.indexOf(0);
  return info
    .subarray(0, end === -1 ? info.length : end)
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();
}

/**
 * A whole message (UDP datagram of the search): head and headers, or
 * undefined when malformed or truncated. Only the projector name is kept from
 * the headers (ASCII names only; the Japanese encodings are not decoded).
 */
export function parseMessage(buffer) {
  const head = parseMessageHead(buffer);
  if (!head || buffer.length < MESSAGE_SIZE + head.headerCount * HEADER_SIZE) {
    return undefined;
  }
  let projectorName;
  for (let i = 0; i < head.headerCount; i += 1) {
    const start = MESSAGE_SIZE + i * HEADER_SIZE;
    const id = buffer[start];
    const attribute = buffer[start + 1];
    if (id === HEADER_IDS.PROJECTOR_NAME && attribute === 1) {
      projectorName = infoText(buffer.subarray(start + 2, start + HEADER_SIZE)) || undefined;
    }
  }
  return { ...head, projectorName };
}

/** A HELLO answer of the search: `{ projectorName }`, or undefined. */
export function parseHelloReply(buffer) {
  const message = parseMessage(buffer);
  if (!message || message.type !== MESSAGE_TYPES.HELLO || message.status !== STATUS.OK) {
    return undefined;
  }
  return { projectorName: message.projectorName };
}

// --- ESC/VP21 frames -----------------------------------------------------------

/** End of every ESC/VP21 answer. */
export const COLON = 0x3a;

/**
 * One ESC/VP21 frame (the bytes up to and including ':'), decoded:
 *   { kind: 'ok' }                          ':' alone (a set command done)
 *   { kind: 'error' }                       'ERR'
 *   { kind: 'value', command, value }       'PWR=01'
 *   { kind: 'event', value }                'IMEVENT=...' (pushed at any time)
 *   { kind: 'unknown' }                     anything else
 */
export function parseFrame(frame) {
  const text = frame
    .toString('latin1')
    .replace(/:$/, '')
    .replace(/[\r\n]+/g, '\r')
    .replace(/^\r+|\r+$/g, '')
    .trim();
  if (text === '') {
    return { kind: 'ok' };
  }
  if (text === 'ERR') {
    return { kind: 'error' };
  }
  const match = /^([A-Z][A-Z0-9_]{0,15})=([^\r]*)$/.exec(text);
  if (!match) {
    return { kind: 'unknown' };
  }
  const [, command, raw] = match;
  const value = raw.replace(/[^\x20-\x7e]/g, '').trim();
  if (command === 'IMEVENT') {
    return { kind: 'event', value };
  }
  return { kind: 'value', command, value };
}
