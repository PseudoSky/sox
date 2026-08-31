#!/usr/bin/env node
/**
 * no-unguarded-listen.test.cjs — BL-619 rule unit pins (node:test, no framework).
 *
 * Run: node tools/eslint-local/no-unguarded-listen.test.cjs
 * (plain node:test — no repo/graph/db dependency; every input is fabricated.)
 *
 * Exercises the rule's three exemptions:
 *   (a) first arg literal 0 (ephemeral port)
 *   (b) X.on('error') / X.once('error') earlier in the enclosing body
 *   (c) inside listenGuarded / doListen
 * plus the negative controls (guard after the listen, guard on a different
 * receiver, guard out of the enclosing scope).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const rule = require('./no-unguarded-listen.cjs');

// eslint is a transitive dependency (peer of @nx/eslint); resolve it through
// that peer so this test does not depend on a root hoist.
const req = createRequire(require.resolve('@nx/eslint'));
const { Linter } = req('eslint');

function lint(code) {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { sox: { rules: { 'no-unguarded-listen': rule } } },
    rules: { 'sox/no-unguarded-listen': 'error' },
  });
}

test('BL-619: flags an unguarded listen()', () => {
  assert.equal(lint(`server.listen(8080, '127.0.0.1', () => {});`).length, 1);
});

test('BL-619: allows first arg literal 0 (ephemeral port)', () => {
  assert.equal(lint(`server.listen(0, '127.0.0.1', () => {});`).length, 0);
});

test('BL-619: allows on(error) earlier in the enclosing body', () => {
  assert.equal(lint(`server.on('error', () => {});\nserver.listen(8080);`).length, 0);
});

test('BL-619: allows once(error) earlier in the enclosing body', () => {
  assert.equal(lint(`server.once('error', () => {});\nserver.listen(8080);`).length, 0);
});

test('BL-619: flags on(error) attached AFTER the listen', () => {
  assert.equal(lint(`server.listen(8080);\nserver.on('error', () => {});`).length, 1);
});

test('BL-619: flags a guard on a DIFFERENT receiver', () => {
  assert.equal(lint(`other.on('error', () => {});\nserver.listen(8080);`).length, 1);
});

test('BL-619: allows a listen inside listenGuarded', () => {
  assert.equal(lint(`function listenGuarded() { server.listen(8080); }`).length, 0);
});

test('BL-619: allows a listen inside doListen', () => {
  assert.equal(lint(`function doListen() { server.listen('/tmp/x.sock'); }`).length, 0);
});

test('BL-619: flags a listen whose guard lives in an OUTER function', () => {
  const code = `function outer() { server.on('error', () => {}); return () => { server.listen(8080); }; }`;
  assert.equal(lint(code).length, 1);
});
