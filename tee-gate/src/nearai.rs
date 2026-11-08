//! Optional live attestation from NEAR AI Cloud (feature "nearai").
//!
//! Fetches a real Intel TDX model attestation report so the webapp inspector
//! can verify live evidence with `dcap-qvl` (see docs/04-architecture.md).
//! Pass signing remains the gate key — the production path self-hosts the
//! checker in an enclave (see docs/03-threat-model.md, tier 2).

use anyhow::{Context, Result};
use serde_json::{json, Value};

pub fn host() -> String {
    std::env::var("HUMANGATE_AIAPI_HOST").unwrap_or_else(|_| "https://cloud-api.near.ai".into())
}

fn api_key() -> Option<String> {
    std::env::var("NEAR_AI_CLOUD_API_KEY").ok().filter(|k| !k.is_empty())
}

pub fn enabled() -> bool {
    api_key().is_some()
}

/// GET /v1/attestation/report?model=<MODEL_ID>&provider=near&signing_algo=ed25519&nonce=…
pub async fn live_evidence(model_id: &str, nonce: &str) -> Result<Value> {
    let key = api_key().context("NEAR_AI_CLOUD_API_KEY not set")?;
    let client = reqwest::Client::new();
    let url = format!("{}/v1/attestation/report", host());
    let resp = client
        .get(&url)
        .query(&[
            ("model", model_id),
            ("provider", "near"),
            ("include_tls_fingerprint", "false"),
            ("signing_algo", "ed25519"),
            ("nonce", nonce),
        ])
        .header("x-no-aliasing", "true")
        .header("Accept", "application/json")
        .bearer_auth(&key)
        .send()
        .await
        .context("attestation report request failed")?;
    let status = resp.status();
    let body: Value = resp.json().await.context("attestation report parse failed")?;
    let reports = body
        .get("model_attestations")
        .and_then(|v| v.as_array())
        .map(|arr| arr.len())
        .unwrap_or(0);

    let note = if reports > 0 {
        "Preflight evidence fetched. Verify intel_quote with dcap-qvl in-browser, then trust the signing_address it binds."
    } else {
        "No model attestations returned — fail closed on pass issuance if it matters for this request."
    };

    Ok(json!({
        "mode": "NEAR-AI-CLOUD",
        "status": status.as_u16(),
        "model": model_id,
        "nonce": nonce,
        "model_attestations_count": reports,
        "note": note,
        "raw": body,
    }))
}
