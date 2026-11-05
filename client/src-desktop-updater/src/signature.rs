//! tauri-plugin-updater 2.13.1 signature rules: a base64 minisign public key
//! and signature, verified with the same `minisign-verify` crate, then the
//! signed `version:` field (read only after the global signature) must equal
//! the announced version when `requireSignedVersion` is enabled.
use base64::Engine;
use minisign_verify::{PublicKey, Signature, StreamVerifier};

pub const MAX_SIGNATURE_BYTES: usize = 4096;

fn decode_text(value: &str) -> Result<String, String> {
    if value.len() > MAX_SIGNATURE_BYTES {
        return Err("github_update_signature".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "github_update_signature")?;
    String::from_utf8(bytes).map_err(|_| "github_update_signature".into())
}

/// Decoded key and signature for one download. Pre-hashed (`ED`) signatures,
/// which the Tauri CLI produces, are verified while streaming to disk.
pub struct Verifier {
    key: PublicKey,
    signature: Signature,
    announced: String,
    prehashed: bool,
}

impl Verifier {
    pub fn new(pubkey: &str, signature: &str, announced: &str) -> Result<Self, String> {
        let key = PublicKey::decode(&decode_text(pubkey)?).map_err(|_| "github_update_signature")?;
        let signature =
            Signature::decode(&decode_text(signature)?).map_err(|_| "github_update_signature")?;
        // A wrong key fails here, before any byte is downloaded or buffered.
        let prehashed = match key.verify_stream(&signature) {
            Ok(_) => true,
            Err(minisign_verify::Error::UnsupportedLegacyMode) => false,
            Err(_) => return Err("github_update_signature".into()),
        };
        Ok(Self {
            key,
            signature,
            announced: announced.to_owned(),
            prehashed,
        })
    }
    pub fn stream(&self) -> Option<StreamVerifier<'_>> {
        if !self.prehashed {
            return None;
        }
        self.key.verify_stream(&self.signature).ok()
    }
    /// Legacy (`Ed`) signatures cover the raw bytes and cannot be streamed.
    pub fn verify_bytes(&self, data: &[u8]) -> Result<(), String> {
        self.key
            .verify(data, &self.signature, true)
            .map_err(|_| "github_update_signature")?;
        self.signed_version()
    }
    pub fn finish(&self, mut stream: StreamVerifier<'_>) -> Result<(), String> {
        stream.finalize().map_err(|_| "github_update_signature")?;
        self.signed_version()
    }
    fn signed_version(&self) -> Result<(), String> {
        // Only usable after `verify`/`finalize`: the global signature covers it.
        let signed = self
            .signature
            .trusted_comment()
            .split('\t')
            .find_map(|field| field.strip_prefix("version:"))
            .ok_or("github_update_signature")?;
        // Announced versions are already stable `x.y.z`; the plugin compares as
        // semver, which for these is the same as `v`-insensitive equality.
        if signed.trim_start_matches('v') != self.announced {
            return Err("github_update_signature".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated with `tauri signer`-compatible minisign (prehashed ED and
    // legacy Ed) for bytes `tarobot-update-fixture`, signed version 1.2.3.
    // Regenerate with `node tests/fixtures/generate.mjs` (tests/minisign.mjs).
    pub const PUBKEY: &str = include_str!("../tests/fixtures/pubkey.b64");
    pub const PREHASHED: &str = include_str!("../tests/fixtures/prehashed.sig.b64");
    pub const LEGACY: &str = include_str!("../tests/fixtures/legacy.sig.b64");
    pub const UNVERSIONED: &str = include_str!("../tests/fixtures/unversioned.sig.b64");
    pub const OTHER_PUBKEY: &str = include_str!("../tests/fixtures/other-pubkey.b64");
    const DATA: &[u8] = b"tarobot-update-fixture";

    #[test]
    fn prehashed_signature_streams_and_binds_the_announced_version() {
        let verifier = Verifier::new(PUBKEY.trim(), PREHASHED.trim(), "1.2.3").unwrap();
        let mut stream = verifier.stream().unwrap();
        stream.update(&DATA[..5]);
        stream.update(&DATA[5..]);
        verifier.finish(stream).unwrap();
        let other = Verifier::new(PUBKEY.trim(), PREHASHED.trim(), "1.2.4").unwrap();
        let mut stream = other.stream().unwrap();
        stream.update(DATA);
        assert_eq!(other.finish(stream).unwrap_err(), "github_update_signature");
        let tampered = Verifier::new(PUBKEY.trim(), PREHASHED.trim(), "1.2.3").unwrap();
        let mut stream = tampered.stream().unwrap();
        stream.update(b"tarobot-update-fixturX");
        assert!(tampered.finish(stream).is_err());
    }

    #[test]
    fn legacy_signature_is_verified_in_memory_and_still_needs_a_signed_version() {
        let verifier = Verifier::new(PUBKEY.trim(), LEGACY.trim(), "1.2.3").unwrap();
        assert!(verifier.stream().is_none());
        verifier.verify_bytes(DATA).unwrap();
        assert!(verifier.verify_bytes(b"other").is_err());
        let missing = Verifier::new(PUBKEY.trim(), UNVERSIONED.trim(), "1.2.3").unwrap();
        let mut stream = missing.stream().unwrap();
        stream.update(DATA);
        assert_eq!(missing.finish(stream).unwrap_err(), "github_update_signature");
    }

    #[test]
    fn malformed_inputs_and_foreign_keys_fail_closed() {
        assert!(Verifier::new("not base64", PREHASHED.trim(), "1.2.3").is_err());
        assert!(Verifier::new(OTHER_PUBKEY.trim(), PREHASHED.trim(), "1.2.3").is_err());
        assert!(Verifier::new(PUBKEY.trim(), "AAAA", "1.2.3").is_err());
        assert!(Verifier::new(PUBKEY.trim(), &"A".repeat(MAX_SIGNATURE_BYTES + 4), "1.2.3").is_err());
    }
}
