//! A short-lived capability for exactly one frozen chat request, never a login token.
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Actor {
    pub uid: i32,
    pub version: i32,
    pub role: String,
    pub conversation_id: i32,
    pub run_id: String,
    digest: String,
    exp: usize,
    aud: String,
}

fn secret() -> Option<String> {
    std::env::var("BLOG_DELEGATION_SECRET")
        .ok()
        .filter(|s| s.len() >= 32)
}

pub(super) fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub(super) fn issue(
    uid: i32,
    version: i32,
    role: String,
    cid: i32,
    run_id: String,
    body: &[u8],
) -> Option<String> {
    if uid <= 0 || cid <= 0 || !valid_id(&run_id) {
        return None;
    }
    let actor = Actor {
        uid,
        version,
        role,
        conversation_id: cid,
        run_id,
        digest: hex::encode(Sha256::digest(body)),
        exp: (chrono::Utc::now().timestamp() + 900) as usize,
        aud: "blog-chat-run".into(),
    };
    encode(
        &Header::default(),
        &actor,
        &EncodingKey::from_secret(secret()?.as_bytes()),
    )
    .ok()
}

pub(super) fn verify(ticket: &str, body: &[u8]) -> Option<Actor> {
    verify_with_key(ticket, body, secret()?.as_bytes())
}

fn verify_with_key(ticket: &str, body: &[u8], key: &[u8]) -> Option<Actor> {
    let mut validation = Validation::default();
    validation.leeway = 0;
    validation.set_audience(&["blog-chat-run"]);
    let actor = decode::<Actor>(ticket, &DecodingKey::from_secret(key), &validation)
        .ok()?
        .claims;
    (actor.uid > 0
        && actor.conversation_id > 0
        && valid_id(&actor.run_id)
        && actor.digest == hex::encode(Sha256::digest(body)))
    .then_some(actor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_binds_request_and_cannot_be_a_login_or_tool_token() {
        let key = b"synthetic-run-ticket-key-used-only-in-tests";
        let body = b"{\"conversation_id\":42,\"message\":\"hello\"}";
        let mut actor = Actor {
            uid: 7,
            version: 3,
            role: "user".into(),
            conversation_id: 42,
            run_id: "a".repeat(32),
            digest: hex::encode(Sha256::digest(body)),
            exp: (chrono::Utc::now().timestamp() + 60) as usize,
            aud: "blog-chat-run".into(),
        };
        let sign = |actor: &Actor| {
            encode(&Header::default(), actor, &EncodingKey::from_secret(key)).unwrap()
        };
        let ticket = sign(&actor);
        assert_eq!(verify_with_key(&ticket, body, key).unwrap().uid, 7);
        assert!(verify_with_key(&ticket, b"changed body", key).is_none());
        assert!(verify_with_key(&ticket, body, b"other signer").is_none());
        actor.aud = "blog-session".into();
        assert!(verify_with_key(&sign(&actor), body, key).is_none());
        actor.aud = "blog-chat-run".into();
        actor.exp = (chrono::Utc::now().timestamp() - 1) as usize;
        assert!(verify_with_key(&sign(&actor), body, key).is_none());
    }
}
