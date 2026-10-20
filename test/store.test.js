import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';

test('/data is read back strictly: no prototype, only valid ids, blocks and codes', async () => {
  const store = new MemoryStore();
  store.data = JSON.parse(
    JSON.stringify({
      projectors: {
        X5AB1234567: {
          id: 'X5AB1234567',
          host: '192.168.1.50',
          port: 3629,
          name: 'Salon',
          sources: ['C0', 'zz', 'C0X', 42],
          colorModes: [],
          password: 'never kept',
        },
        mismatch: { id: 'other' },
        'bad id': { id: 'bad id' },
      },
      authBlocks: {
        '192.168.1.50:3629': { kind: 'auth_refused', retryAt: 123 },
        'x:1': { kind: 'other', retryAt: 1 },
        nope: { kind: 'auth_required', retryAt: 1 },
      },
    }).replace('"mismatch"', '"__proto__"'),
  );
  const data = await store.load();
  assert.equal(Object.getPrototypeOf(data.projectors), null);
  assert.equal(Object.getPrototypeOf(data.authBlocks), null);
  assert.deepEqual(Object.keys(data.projectors), ['X5AB1234567']);
  assert.deepEqual(data.projectors.X5AB1234567.sources, ['C0']);
  assert.equal(data.projectors.X5AB1234567.password, undefined);
  assert.deepEqual(Object.keys(data.authBlocks), ['192.168.1.50:3629']);
  assert.equal({}.id, undefined, 'no pollution');
});
