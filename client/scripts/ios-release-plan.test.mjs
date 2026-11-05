import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iosReleasePlan, validateIOSBundleMetadata, validateIOSEntitlements } from './ios-release-plan.mjs';

const base = { version: '1.0.90', buildNumber: '1', output: '/tmp/ios build' };
test('simulator builds use local ad-hoc signing without a team, preserving Keychain entitlements', () => {
  const plan = iosReleasePlan(base);
  assert.equal(plan.mode, 'simulator');
  assert.ok(plan.buildArgs.includes('CODE_SIGNING_ALLOWED=YES'));
  assert.ok(plan.buildArgs.includes('CODE_SIGN_IDENTITY=-'));
  assert.ok(!plan.buildArgs.some((arg) => arg.startsWith('DEVELOPMENT_TEAM=')));
  assert.ok(plan.buildArgs.includes('MARKETING_VERSION=1.0.90'));
  assert.ok(plan.buildArgs.includes('CURRENT_PROJECT_VERSION=1'));
  assert.ok(plan.buildArgs.includes('-onlyUsePackageVersionsFromResolvedFile'));
  assert.equal(plan.exportOptions, undefined);
});
test('TestFlight archives and exports with production signing and no version rewriting', () => {
  const plan = iosReleasePlan({ ...base, mode: 'testflight', teamId: 'ABCD123456' });
  assert.ok(plan.buildArgs.includes('archive'));
  assert.ok(plan.archive.endsWith('/TaroBird.xcarchive'));
  assert.ok(plan.buildArgs.includes('APS_ENVIRONMENT=production'));
  assert.ok(!plan.buildArgs.includes('CODE_SIGNING_ALLOWED=NO'));
  assert.ok(!plan.buildArgs.includes('CODE_SIGN_IDENTITY=-'));
  assert.ok(!plan.buildArgs.includes('-allowProvisioningUpdates'));
  assert.equal(plan.exportOptions.method, 'app-store-connect');
  assert.equal(plan.exportOptions.destination, 'export');
  assert.equal(plan.exportOptions.manageAppVersionAndBuildNumber, false);
  assert.equal(plan.exportOptions.uploadSymbols, false, "Optional symbols must not expose local archive paths");
});
test('release arguments fail closed for invalid versions, teams and build numbers', () => {
  for (const change of [{ version: '1.0.90-beta.1' }, { buildNumber: '0' }, { buildNumber: '01' }, { buildNumber: '10000' }, { mode: 'unknown' }, { mode: 'testflight' }, { mode: 'testflight', teamId: '$(unsafe)' }]) {
    assert.throws(() => iosReleasePlan({ ...base, ...change }));
  }
});
const bundle = { CFBundleIdentifier: 'com.tarobot.client', CFBundleDisplayName: 'TaroBird', CFBundleShortVersionString: '1.0.90', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneOS'] };
const extension = { ...bundle, CFBundleIdentifier: 'com.tarobot.client.share' };
test('final package rejects simulator artifacts, mismatched extension versions and wrong identities', () => {
  assert.doesNotThrow(() => validateIOSBundleMetadata(bundle, extension, base));
  assert.throws(() => validateIOSBundleMetadata({ ...bundle, CFBundleSupportedPlatforms: ['iPhoneSimulator'] }, extension, base));
  assert.throws(() => validateIOSBundleMetadata(bundle, { ...extension, CFBundleVersion: '2' }, base));
  assert.throws(() => validateIOSBundleMetadata({ ...bundle, CFBundleIdentifier: 'com.other.app' }, extension, base));
});
test('simulator receipts only accept simulator app and extension bundles', () => {
  const app = { ...bundle, CFBundleSupportedPlatforms: ['iPhoneSimulator'] };
  const share = { ...extension, CFBundleSupportedPlatforms: ['iPhoneSimulator'] };
  assert.doesNotThrow(() => validateIOSBundleMetadata(app, share, { ...base, mode: 'simulator' }));
  assert.throws(() => validateIOSBundleMetadata(app, extension, { ...base, mode: 'simulator' }));
});
const appRights = { 'application-identifier': 'ABCD123456.com.tarobot.client', 'com.apple.developer.team-identifier': 'ABCD123456', 'com.apple.security.application-groups': ['group.com.tarobot.client'], 'aps-environment': 'production', 'get-task-allow': false };
const shareRights = { ...appRights, 'application-identifier': 'ABCD123456.com.tarobot.client.share' };
test('distribution entitlement verification rejects debug, sandbox push and wrong teams', () => {
  assert.doesNotThrow(() => validateIOSEntitlements(appRights, shareRights, 'ABCD123456'));
  for (const change of [{ 'get-task-allow': true }, { 'aps-environment': 'development' }, { 'application-identifier': 'OTHER12345.com.tarobot.client' }, { 'com.apple.security.application-groups': [] }]) {
    assert.throws(() => validateIOSEntitlements({ ...appRights, ...change }, shareRights, 'ABCD123456'));
  }
  assert.throws(() => validateIOSEntitlements(appRights, { ...shareRights, 'get-task-allow': true }, 'ABCD123456'));
  assert.throws(() => validateIOSEntitlements(appRights, { ...shareRights, 'com.apple.developer.team-identifier': 'OTHER12345' }, 'ABCD123456'));
});

test('renaming the App changes display labels without changing native identities', () => {
  assert.doesNotThrow(() => validateIOSBundleMetadata(bundle, extension, base));
  assert.throws(() => validateIOSBundleMetadata({ ...bundle, CFBundleDisplayName: 'TaroBot' }, extension, base), /display name/);
  assert.throws(() => validateIOSBundleMetadata(bundle, { ...extension, CFBundleDisplayName: 'TaroBot' }, base), /display name/);
});
