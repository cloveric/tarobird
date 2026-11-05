import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// Isolated acceptance Hosts start without an owner. Bootstrap that local test
// owner in-process; both simulated App devices still use the public invited
// pairing route and require a separate owner approval afterwards.
export async function createAcceptanceInvitationIssuer(auth, deviceProof) {
  const keys = generateKeyPairSync('ed25519');
  const deviceId = 'acceptance_owner_' + randomBytes(8).toString('hex');
  const pending = await auth.pair({ deviceId, name: 'Acceptance invitation owner', platform: 'web',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
  await auth.approve(pending.code, 'local-owner');
  return async () => {
    const connection = 'acceptance_' + randomBytes(8).toString('hex');
    const clientNonce = randomBytes(32).toString('base64url');
    const challenge = await auth.challenge(connection, deviceId, clientNonce, '127.0.0.1');
    const { token } = await auth.authenticate(connection, sign(null,
      deviceProof(deviceId, challenge.nonce, clientNonce), keys.privateKey).toString('base64'));
    const session = await auth.authorize(token, '127.0.0.1');
    return auth.issuePairingInvite(session, { requestId: randomBytes(32).toString('base64url') });
  };
}

export async function requestAcceptancePairing(url, issueInvite, fields) {
  const invitation = await issueInvite();
  const response = await fetch(url + '/api/pair', { method: 'POST', body: JSON.stringify({ ...fields,
    invite: invitation.invite, requestId: randomBytes(32).toString('base64url') }) });
  const result = await response.json();
  if (!response.ok) throw new Error('Acceptance pairing failed: ' + JSON.stringify(result));
  return result;
}
