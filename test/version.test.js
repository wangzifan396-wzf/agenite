// v0.67.0 — version-sanity checks. Pure: reads package.json (and the seeded
// badge JSON) and asserts the version is well-formed semver and that the badge
// stayed in sync. No server spawn, so it can't flake in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

test('package.json version is valid semver', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.version, SEMVER, `version "${pkg.version}" is not semver`);
});

test('seeded badge JSON echoes the package version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const badge = JSON.parse(readFileSync(join(root, 'docs/badges/version.json'), 'utf8'));
  assert.equal(badge.schemaVersion, 1, 'badge must be shields.io endpoint schema v1');
  assert.equal(badge.message, `v${pkg.version}`, 'badge message must track package.json');
  assert.match(badge.message, /^v\d+\.\d+\.\d+$/, 'badge message must be vX.Y.Z');
});
