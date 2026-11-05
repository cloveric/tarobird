import assert from 'node:assert/strict';
import path from 'node:path';

// These are persisted native identities, not product display names.
export const iosIdentity = Object.freeze({
  app: 'com.tarobot.client', share: 'com.tarobot.client.share', group: 'group.com.tarobot.client',
});

export function iosReleasePlan({ mode = 'simulator', version, buildNumber = '1', teamId, output }) {
  assert.ok(['simulator', 'testflight'].includes(mode), 'mode must be simulator or testflight');
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'iOS version must be numeric major.minor.patch');
  assert.match(String(buildNumber), /^[1-9]\d{0,3}$/, 'build number must be 1–9999; increase it for every upload');
  assert.ok(typeof output === 'string' && path.isAbsolute(output), 'output must be an absolute path');
  if (mode === 'testflight') assert.match(teamId ?? '', /^[A-Z0-9]{10}$/, 'TestFlight requires a 10-character Apple team ID');
  const derivedData = path.join(output, 'DerivedData');
  const archive = path.join(output, 'TaroBot.xcarchive');
  const buildArgs = [
    '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
    '-derivedDataPath', derivedData, '-clonedSourcePackagesDirPath', path.join(output, 'SourcePackages'),
    '-packageCachePath', path.join(output, 'PackageCache'),
    '-onlyUsePackageVersionsFromResolvedFile',
    '-destination', mode === 'simulator' ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS',
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${buildNumber}`,
    `CLANG_MODULE_CACHE_PATH=${path.join(output, 'ModuleCache')}`,
  ];
  // Disabling signing also removes Xcode's simulated application-identifier.
  // Keychain then rejects even the initial app-lock read with errSecMissingEntitlement.
  // Ad-hoc signing is local and needs no Apple account or provisioning profile.
  if (mode === 'simulator') buildArgs.push('CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'build');
  else buildArgs.push(`DEVELOPMENT_TEAM=${teamId}`, 'APS_ENVIRONMENT=production', '-archivePath', archive, 'archive');
  return {
    mode, version, buildNumber: String(buildNumber), teamId, output, archive, derivedData, buildArgs,
    exportOptions: mode === 'testflight' ? {
      method: 'app-store-connect', destination: 'export', teamID: teamId, signingStyle: 'automatic',
      manageAppVersionAndBuildNumber: false, uploadSymbols: false, stripSwiftSymbols: true,
    } : undefined,
  };
}

export function validateIOSBundleMetadata(app, share, { version, buildNumber, mode = 'testflight' }) {
  for (const [metadata, id] of [[app, iosIdentity.app], [share, iosIdentity.share]]) {
    assert.equal(metadata.CFBundleIdentifier, id, 'native bundle identity changed');
    assert.equal(metadata.CFBundleDisplayName, 'TaroBird', 'incorrect product display name');
    assert.equal(metadata.CFBundleShortVersionString, version, 'bundle version differs from client package');
    assert.equal(metadata.CFBundleVersion, String(buildNumber), 'app and extension build numbers must match');
    assert.deepEqual(metadata.CFBundleSupportedPlatforms, [mode === 'simulator' ? 'iPhoneSimulator' : 'iPhoneOS'], 'wrong platform artifact');
  }
}

// Call on the exported IPA, since export may re-sign the archive.
export function validateIOSEntitlements(app, share, teamId) {
  assert.match(teamId ?? '', /^[A-Z0-9]{10}$/);
  for (const [rights, id] of [[app, iosIdentity.app], [share, iosIdentity.share]]) {
    assert.equal(rights['application-identifier'], `${teamId}.${id}`, 'wrong signing identity');
    assert.equal(rights['com.apple.developer.team-identifier'], teamId, 'wrong development team');
    assert.notEqual(rights['get-task-allow'], true, 'debugging entitlement must not ship');
    assert.deepEqual(rights['com.apple.security.application-groups'], [iosIdentity.group], 'missing or unexpected App Group');
  }
  assert.equal(app['aps-environment'], 'production', 'TestFlight must use production APNs');
}
