// -----------------------------------------------------------------------------
// A fake Epson projector on 127.0.0.1: the ESC/VP.net handshake (password
// optional), then the ESC/VP21 questions and commands the integration uses,
// with the power cycle (warm-up, cool-down) and their delayed answers.
// Modes: silent (accepts TCP, never answers), busy, pushed IMEVENT, garbage.
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';

const IDENTIFIER = Buffer.from('ESC/VP.net', 'ascii');

export function message(type, status, headers = []) {
  const head = Buffer.alloc(16);
  IDENTIFIER.copy(head, 0);
  head[10] = 0x10;
  head[11] = type;
  head[14] = status;
  head[15] = headers.length;
  return Buffer.concat([head, ...headers]);
}

/** A HELLO answer of the UDP search, with a projector name header. */
export function helloReply(name = 'EBW49') {
  const header = Buffer.alloc(18);
  header[0] = 3;
  header[1] = 1;
  Buffer.from(name, 'ascii').copy(header, 2, 0, 16);
  return message(1, 0x20, [header]);
}

export async function startFakeProjector(options = {}) {
  const state = {
    password: options.password ?? '',
    serial: options.serial === undefined ? 'X5AB1234567' : options.serial,
    power: options.power ?? '04',
    source: options.source ?? '30',
    colorMode: options.colorMode ?? '15',
    mute: options.mute ?? 'OFF',
    lamp: options.lamp ?? '1234 0',
    acceptedSources: options.acceptedSources ?? ['30', 'A0', '10'],
    acceptedColorModes: options.acceptedColorModes ?? ['15', '07', '06', '00', '0C'],
    powerOnDelay: options.powerOnDelay ?? 0,
    powerOffDelay: options.powerOffDelay ?? 0,
    silent: options.silent ?? false,
    busy: options.busy ?? false,
    pushEvents: options.pushEvents ?? false,
    garbage: options.garbage ?? false,
    noAnswer: new Set(options.noAnswer ?? []),
  };
  const received = [];
  const passwords = [];
  const sockets = new Set();
  let connections = 0;

  const answer = (socket, text) => {
    if (!socket.destroyed) {
      if (state.pushEvents) {
        socket.write(
          `IMEVENT=0001 ${state.power === '01' ? '03' : '01'} 00000000 00000000 T1 F1\r:`,
        );
      }
      socket.write(text);
    }
  };

  const handle = (socket, line) => {
    received.push(line);
    const query = /^([A-Z]+)\?$/.exec(line);
    if (state.noAnswer.has(line)) {
      return;
    }
    if (query) {
      const key = query[1];
      const on = state.power === '01';
      const values = {
        PWR: state.power,
        SNO: state.serial,
        LAMP: state.lamp,
        SOURCE: on ? state.source : null,
        CMODE: on ? state.colorMode : null,
        MUTE: on ? state.mute : null,
      };
      const value = values[key];
      answer(socket, value == null ? 'ERR\r:' : `${key}=${value}\r:`);
      return;
    }
    const [command, argument] = line.split(' ');
    if (command === 'PWR' && argument === 'ON') {
      if (!['00', '04', '09'].includes(state.power)) {
        answer(socket, 'ERR\r:');
        return;
      }
      state.power = '02';
      setTimeout(() => {
        state.power = '01';
        answer(socket, ':');
      }, state.powerOnDelay);
      return;
    }
    if (command === 'PWR' && argument === 'OFF') {
      if (state.power !== '01') {
        answer(socket, 'ERR\r:');
        return;
      }
      state.power = '03';
      setTimeout(() => {
        state.power = '04';
        answer(socket, ':');
      }, state.powerOffDelay);
      return;
    }
    const on = state.power === '01';
    if (command === 'SOURCE' && on && state.acceptedSources.includes(argument)) {
      state.source = argument;
      answer(socket, ':');
      return;
    }
    if (command === 'CMODE' && on && state.acceptedColorModes.includes(argument)) {
      state.colorMode = argument;
      answer(socket, ':');
      return;
    }
    if (command === 'MUTE' && on && ['ON', 'OFF'].includes(argument)) {
      state.mute = argument;
      answer(socket, ':');
      return;
    }
    answer(socket, 'ERR\r:');
  };

  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let ready = false;
    socket.on('data', (chunk) => {
      if (state.silent) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        if (state.garbage) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.end();
          return;
        }
        if (buffer.length < 16) {
          return;
        }
        const count = buffer[15];
        if (buffer.length < 16 + count * 18) {
          return;
        }
        let password = '';
        for (let i = 0; i < count; i += 1) {
          const start = 16 + i * 18;
          if (buffer[start] === 1) {
            const info = buffer.subarray(start + 2, start + 18);
            const end = info.indexOf(0);
            password = info.subarray(0, end === -1 ? 16 : end).toString('ascii');
          }
        }
        passwords.push(password);
        buffer = buffer.subarray(16 + count * 18);
        if (state.busy) {
          socket.write(message(3, 0x53));
          return;
        }
        if (state.password && !password) {
          socket.write(message(3, 0x41));
          return;
        }
        if (state.password && password !== state.password) {
          socket.write(message(3, 0x43));
          return;
        }
        socket.write(message(3, 0x20));
        ready = true;
      }
      let end = buffer.indexOf(0x0d);
      while (end !== -1) {
        const line = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 1);
        handle(socket, line);
        end = buffer.indexOf(0x0d);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    received,
    passwords,
    get connections() {
      return connections;
    },
    /** Sends raw bytes on every open session (pushed messages, junk). */
    push(text) {
      for (const socket of sockets) {
        socket.write(text);
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
