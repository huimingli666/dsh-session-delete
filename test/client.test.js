/**
 * dsh-session-delete — browser-bundle smoke test.
 * Loads the built lib/client.js inside a node:vm sandbox and verifies it
 * registers through the dsh module loader with a hot-rod React/require.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

test('client bundle loads through the dsh module loader', () => {
  const bundle = readFileSync(bundlePath, 'utf8')
  const require = (name) => {
    if (name === 'react') {
      return {
        useState: () => [undefined, () => {}],
        useCallback: (fn) => fn,
      }
    }
    throw new Error(`unexpected require: ${name}`)
  }
  const module = { exports: {} }
  let spec
  const sandbox = {
    window: { __ModuleLoader__: { load: (s) => { spec = s } } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' })

  assert.ok(spec, 'bundle must call window.__ModuleLoader__.load')
  assert.equal(spec.id, '@dsh-plugins/dsh-session-delete')
  assert.equal(typeof spec.factory, 'function')

  const exports = spec.factory(require)
  assert.equal(typeof exports.apply, 'function')
  // The inject guard requires the slots ledger and the workspaces kit to be
  // declared — without them, ctx.slots access is rejected and no button is
  // ever registered.
  assert.equal(Array.isArray(exports.inject), true)
  assert.ok(exports.inject.includes('slots'), 'inject must declare slots')
  assert.ok(exports.inject.includes('workspaces'), 'inject must declare workspaces')
})

test('bundle warns instead of throwing on a broken apply (fail-degrade)', () => {
  const bundle = readFileSync(bundlePath, 'utf8')
  let spec
  const sandbox = {
    window: { __ModuleLoader__: { load: (s) => { spec = s } } },
    console: { error: () => {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox)
  const exports = spec.factory((name) => {
    if (name === 'react') return { useState: () => [undefined, () => {}], useCallback: () => () => {} }
    throw new Error('no deps')
  })
  // A ctx without slots must not throw — apply returns silently after logging.
  const broken = exports.apply({ slots: undefined, effect: undefined, workspaces: {} })
  assert.equal(broken, undefined)
})