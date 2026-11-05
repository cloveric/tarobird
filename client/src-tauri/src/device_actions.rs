use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action { operation: String, target: String }
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Statement {
    pub device_id: String,
    hub_public_key: String,
    session_hash: String,
    action: Action,
    target_digest: String,
    nonce: String,
    expires_at: u64,
}
fn id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') }
fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
impl Statement {
    pub fn proof(&self) -> Result<String, String> {
        let key = STANDARD.decode(&self.hub_public_key).map_err(|_| "invalid_device_action")?;
        if key.len() != 44 || key[..12] != [0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]
            || !id(&self.device_id) || !digest(&self.session_hash) || !digest(&self.target_digest)
            || self.nonce.len() != 43 || !id(&self.nonce) || self.expires_at == 0 || self.expires_at > 9_007_199_254_740_991 {
            return Err("invalid_device_action".into());
        }
        match self.action.operation.as_str() {
            "approve" if self.action.target.len() == 8 && self.action.target.bytes().all(|c| c.is_ascii_digit()) => {},
            "revoke" if id(&self.action.target) => {},
            "network" | "bot-message-grant" | "screen-grant" if digest(&self.action.target) => {},
            _ => return Err("invalid_device_action".into()),
        }
        serde_json::to_string(&("tarocub/device-action/v1", &self.hub_public_key, &self.device_id, &self.session_hash,
            &self.action.operation, &self.action.target, &self.target_digest, &self.nonce, self.expires_at))
            .map_err(|_| "invalid_device_action".into())
    }
}
pub fn sign(key: &SigningKey, statement: &Statement) -> Result<String, String> {
    Ok(STANDARD.encode(key.sign(statement.proof()?.as_bytes()).to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vector() -> serde_json::Value { serde_json::from_str(include_str!("../../../tests/fixtures/device-action-vector.json")).unwrap() }
    #[test]
    fn signs_the_shared_node_vector_with_the_action_domain() {
        let v = vector();
        let statement: Statement = serde_json::from_value(v["statement"].clone()).unwrap();
        assert_eq!(statement.proof().unwrap(), v["proofText"].as_str().unwrap());
        assert_eq!(sign(&SigningKey::from_bytes(&[7; 32]), &statement).unwrap(), v["signature"].as_str().unwrap());
        assert!(statement.proof().unwrap().starts_with("[\"tarocub/device-action/v1\","));
    }
    #[test]
    fn signs_network_hashes_without_accepting_arbitrary_targets() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/device-network-action-vector.json")).unwrap();
        let statement: Statement = serde_json::from_value(v["statement"].clone()).unwrap();
        assert_eq!(statement.proof().unwrap(), v["proofText"].as_str().unwrap());
        assert_eq!(sign(&SigningKey::from_bytes(&[7; 32]), &statement).unwrap(), v["signature"].as_str().unwrap());
        for target in [String::new(), "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "device_target".into(), format!("{}\n", "a".repeat(64))] {
            let mut bad = v["statement"].clone(); bad["action"]["target"] = target.into();
            assert!(serde_json::from_value::<Statement>(bad).unwrap().proof().is_err());
        }
    }
    #[test]
    fn signs_message_grants_in_the_existing_action_domain() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/device-message-grant-vector.json")).unwrap();
        let statement: Statement = serde_json::from_value(v["statement"].clone()).unwrap();
        assert_eq!(statement.proof().unwrap(), v["proofText"].as_str().unwrap());
        assert_eq!(sign(&SigningKey::from_bytes(&[7; 32]), &statement).unwrap(), v["signature"].as_str().unwrap());
        let mut bad = v["statement"].clone(); bad["action"]["target"] = "../bot".into();
        assert!(serde_json::from_value::<Statement>(bad).unwrap().proof().is_err());
    }
    #[test]
    fn rejects_invalid_or_ambiguous_signing_requests() {
        for (field, value) in [("deviceId", "device_bad\0id"), ("nonce", "short"), ("sessionHash", "ABC"), ("targetDigest", "bad"), ("hubPublicKey", "invalid")] {
            let mut v = vector()["statement"].clone(); v[field] = value.into();
            let statement: Statement = serde_json::from_value(v).unwrap();
            assert!(statement.proof().is_err(), "accepted {field}");
        }
        for action in [serde_json::json!({"operation":"approve", "target":"8765432"}), serde_json::json!({"operation":"revoke", "target":"../device"}), serde_json::json!({"operation":"admin", "target":"device_target"})] {
            let mut v = vector()["statement"].clone(); v["action"] = action;
            assert!(serde_json::from_value::<Statement>(v).unwrap().proof().is_err());
        }
        let mut v = vector()["statement"].clone(); v["extra"] = true.into();
        assert!(serde_json::from_value::<Statement>(v).is_err());
    }
}
