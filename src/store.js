// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known projectors by id, their address and
// name, the source and color mode codes seen on them, and whether their
// password was refused (with the time of the next try). Never the password.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FILE_NAME = 'epson-projector.json';

/** A projector id (serial number or address based): plain characters only. */
export const isProjectorId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,48}$/.test(id);

export const emptyData = () => ({
  projectors: Object.create(null),
  /** `host:port` -> { kind, retryAt }: a password missing or refused there. */
  authBlocks: Object.create(null),
});

const AUTH_BLOCK_KINDS = new Set(['auth_required', 'auth_refused']);

function sanitizeBlocks(blocks, base) {
  if (!blocks || typeof blocks !== 'object') {
    return;
  }
  for (const [key, block] of Object.entries(blocks).slice(0, 64)) {
    if (
      /^[a-z0-9.-]{1,253}:\d{1,5}$/.test(key) &&
      block &&
      AUTH_BLOCK_KINDS.has(block.kind) &&
      Number.isFinite(block.retryAt)
    ) {
      base.authBlocks[key] = { kind: block.kind, retryAt: block.retryAt };
    }
  }
}

const codes = (list) =>
  Array.isArray(list)
    ? list.filter((code) => typeof code === 'string' && /^[0-9A-F]{2}$/.test(code)).slice(0, 20)
    : [];

function sanitize(data) {
  const base = emptyData();
  sanitizeBlocks(data?.authBlocks, base);
  const projectors = data && typeof data === 'object' ? data.projectors : undefined;
  if (!projectors || typeof projectors !== 'object') {
    return base;
  }
  for (const [id, p] of Object.entries(projectors).slice(0, 64)) {
    if (!isProjectorId(id) || !p || typeof p !== 'object' || p.id !== id) {
      continue;
    }
    base.projectors[id] = {
      id,
      host: typeof p.host === 'string' ? p.host.slice(0, 253) : '',
      port: Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : 3629,
      name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
      serial: typeof p.serial === 'string' ? p.serial.slice(0, 32) : undefined,
      sources: codes(p.sources),
      colorModes: codes(p.colorModes),
      authRefused: p.authRefused === true,
      authRetryAt: Number.isFinite(p.authRetryAt) ? p.authRetryAt : 0,
    };
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = FILE_NAME } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to `<name>.bad` and
   * `corrupted` is set, so the app says so instead of silently starting over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}
