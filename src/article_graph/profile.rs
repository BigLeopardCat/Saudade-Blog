//! Shared model deployment contracts; token counting stays in the embedding service.

use super::Source;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

#[derive(Deserialize)]
pub struct Contract {
    schema_version: u8,
    signature_payload: String,
    tokenization_protocol: String,
}

#[derive(Deserialize)]
struct Identity {
    schema_version: u8,
    tokenizer_sha256: String,
    max_tokens: usize,
    add_special_tokens: bool,
    query_prefix: String,
    #[serde(default)]
    unicode_normalization: String,
    model_revision: String,
}

fn policy(
    contract: &Contract,
    expected: &str,
    query: &str,
) -> Result<(Identity, String), &'static str> {
    if contract.schema_version != 1
        || contract.signature_payload.len() > 16_384
        || contract.tokenization_protocol != "llama.cpp-tokenize-v1"
        || hex::encode(Sha256::digest(contract.signature_payload.as_bytes())) != expected
    {
        return Err("embedding_profile_mismatch");
    }
    let identity: Identity = serde_json::from_str(&contract.signature_payload)
        .map_err(|_| "embedding_profile_invalid")?;
    if identity.schema_version != 1
        || !(1..=32768).contains(&identity.max_tokens)
        || identity.tokenizer_sha256.len() != 64
        || !identity
            .tokenizer_sha256
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
        || !identity.model_revision.contains(";llama-")
    {
        return Err("embedding_profile_invalid");
    }
    let text = format!("{}{query}", identity.query_prefix);
    let text = match identity.unicode_normalization.as_str() {
        "" | "none" => text,
        "NFC" => text.nfc().collect(),
        _ => return Err("embedding_profile_invalid"),
    };
    Ok((identity, text))
}

fn count_matches(value: &Value, maximum: usize) -> Result<(), &'static str> {
    let tokens = value
        .get("tokens")
        .and_then(Value::as_array)
        .ok_or("embedding_tokenizer_invalid")?;
    if tokens.is_empty() || tokens.iter().any(|value| value.as_u64().is_none()) {
        return Err("embedding_tokenizer_invalid");
    }
    if tokens.len() > maximum {
        return Err("embedding_query_too_long");
    }
    Ok(())
}

pub async fn prepare(
    source: &Source,
    space: &Value,
    query: &str,
    client: &reqwest::Client,
    embedding_url: &str,
    key: &str,
) -> Result<String, &'static str> {
    let expected = space.get("profile").and_then(Value::as_str).unwrap_or("");
    if expected.is_empty() {
        return if source.embedding_profile.is_none() {
            Ok(query.to_owned())
        } else {
            Err("embedding_profile_mismatch")
        };
    }
    let contract = source
        .embedding_profile
        .as_ref()
        .ok_or("embedding_profile_missing")?;
    let (identity, text) = policy(contract, expected, query)?;
    let path = super::artifact_dir().join(format!("tokenizer-{}.json", identity.tokenizer_sha256));
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "embedding_tokenizer_missing")?;
    if file
        .metadata()
        .await
        .map_err(|_| "embedding_tokenizer_missing")?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("embedding_tokenizer_invalid");
    }
    let mut artifact = Vec::new();
    file.take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut artifact)
        .await
        .map_err(|_| "embedding_tokenizer_missing")?;
    if hex::encode(Sha256::digest(&artifact)) != identity.tokenizer_sha256 {
        return Err("embedding_tokenizer_mismatch");
    }
    let base = embedding_url
        .strip_suffix("/v1/embeddings")
        .ok_or("embedding_tokenizer_unavailable")?;
    let mut response = client
        .post(format!("{base}/tokenize"))
        .bearer_auth(key)
        .json(&serde_json::json!({"content":text,"add_special":identity.add_special_tokens}))
        .send()
        .await
        .map_err(|_| "embedding_tokenizer_unavailable")?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 512 * 1024)
    {
        return Err("embedding_tokenizer_unavailable");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "embedding_tokenizer_unavailable")?
    {
        if bytes.len() + chunk.len() > 512 * 1024 {
            return Err("embedding_tokenizer_invalid");
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "embedding_tokenizer_invalid")?;
    count_matches(&value, identity.max_tokens)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn contract(normalization: &str) -> (Contract, String) {
        let payload=serde_json::json!({"schema_version":1,"tokenizer_sha256":"a".repeat(64),"max_tokens":8,"add_special_tokens":true,"query_prefix":"Q: ","unicode_normalization":normalization,"model_revision":"fixture;llama-test;"}).to_string();
        let signature = hex::encode(Sha256::digest(payload.as_bytes()));
        (
            Contract {
                schema_version: 1,
                signature_payload: payload,
                tokenization_protocol: "llama.cpp-tokenize-v1".into(),
            },
            signature,
        )
    }
    #[test]
    fn exact_payload_binds_prefix_normalization_and_special_tokens() {
        let (mut contract, signature) = contract("NFC");
        let (identity, text) = policy(&contract, &signature, "Cafe\u{301} 猫🐱").unwrap();
        assert_eq!(text, "Q: Café 猫🐱");
        assert!(identity.add_special_tokens);
        contract.signature_payload.push(' ');
        assert!(matches!(
            policy(&contract, &signature, "query"),
            Err("embedding_profile_mismatch")
        ));
    }
    #[test]
    fn unknown_normalization_and_token_overflow_fail_closed() {
        let (contract, signature) = contract("custom");
        assert!(matches!(
            policy(&contract, &signature, "query"),
            Err("embedding_profile_invalid")
        ));
        assert_eq!(
            count_matches(&serde_json::json!({"tokens":[1,2]}), 2),
            Ok(())
        );
        assert_eq!(
            count_matches(&serde_json::json!({"tokens":[1,2,3]}), 2),
            Err("embedding_query_too_long")
        );
        assert_eq!(
            count_matches(&serde_json::json!({"tokens":[-1]}), 2),
            Err("embedding_tokenizer_invalid")
        );
    }
}
