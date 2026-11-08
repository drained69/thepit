//! tee-gate — pass issuer for the $HUMAN prototype.
//!
//! Modes:
//!   sim    (default) — simulated evidence for local development and demos.
//!   nearai           — attestation preflight only. Pass issuance is disabled
//!                      because this mode does not bind the pass key to evidence.

mod pass;
mod policy;
mod sim;
mod state;

#[cfg(feature = "nearai")]
mod nearai;

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::{get, post};
use axum::Router;
use clap::Parser;
use serde::Deserialize;
use serde_json::{json, Value};

/// Everything a route handler needs. `model_id` is only used in nearai mode.
struct AppState {
    gate: state::GateState,
    model_id: String,
}

type S = Arc<AppState>;

#[derive(Parser, Debug)]
#[command(name = "tee-gate", about = "Attested human-allocation gate for the $HUMAN sale")]
struct Args {
    /// HTTP port.
    #[arg(long, default_value_t = 8788)]
    port: u16,
    /// "sim" (simulated evidence, default) or "nearai" (preflight only).
    #[arg(long, default_value = "sim")]
    mode: String,
    /// Sale the passes bind to (must match the contract's sale_id).
    #[arg(long, default_value = "HUMAN-001")]
    sale_id: String,
    /// Key storage directory (sim-enclave.sk / sim-root.sk live here).
    #[arg(long, default_value = "~/.human-gate")]
    storage: String,
    /// Verifier name pinned on-chain.
    #[arg(long, default_value = "human-gate-sim-1")]
    verifier_name: String,
    /// NEAR AI Cloud model id for nearai-mode attestation preflight.
    #[arg(long, default_value = "deepseek-r1-distrill-qwen-32b")]
    model: String,
    /// Also copy sim-root.pub here (e.g. ../res) so scripts can pin it.
    #[arg(long)]
    export_root: Option<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tee_gate=info,axum=warn".into()),
        )
        .init();

    let args = Args::parse();
    if args.mode != "sim" && args.mode != "nearai" {
        eprintln!("--mode must be \"sim\" or \"nearai\" (got {:?})", args.mode);
        std::process::exit(1);
    }
    #[cfg(not(feature = "nearai"))]
    if args.mode == "nearai" {
        eprintln!("--mode nearai requires a rebuild with --features nearai");
        std::process::exit(1);
    }

    let storage = shellexpand::tilde(&args.storage).to_string();
    let (signing, sim_root) = sim::load_or_create_keys(&storage);
    let root_pub = hex::encode(sim_root.verifying_key().as_bytes());

    // Publish the verifiable sim-root public key so scripts/the webapp can pin
    // it; deployment copies it into res/sim-root.pub.
    let root_pub_path = std::path::Path::new(&storage).join("sim-root.pub");
    if let Err(e) = std::fs::write(&root_pub_path, format!("{root_pub}\n")) {
        eprintln!("could not write {:?}: {e}", root_pub_path);
        std::process::exit(1);
    }
    if let Some(dst) = &args.export_root {
        let dst = shellexpand::tilde(dst).to_string();
        let _ = std::fs::create_dir_all(&dst);
        let _ = std::fs::write(
            std::path::Path::new(&dst).join("sim-root.pub"),
            format!("{root_pub}\n"),
        );
    }

    let policy = policy::GatePolicy {
        verifier_name: args.verifier_name.clone(),
        pow_target: policy::pow_target(),
        pass_cap_tokens: 2_000_000,
        pass_ttl_ms: 5 * 60 * 1000,
        session_ttl_ms: 15 * 60 * 1000,
        max_attempts: 5,
        hash: policy::policy_hash(),
    };

    let gate = state::GateState::new(&args.mode, &args.sale_id, signing, sim_root, policy);
    let st: S = Arc::new(AppState {
        gate,
        model_id: args.model.clone(),
    });

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/info", get(info))
        .route("/api/gate/challenge", get(challenge))
        .route("/api/gate/verify", post(verify))
        .route("/api/gate/attestation", get(attestation))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(st);

    let addr = format!("0.0.0.0:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    tracing::info!(
        "tee-gate listening on http://{} mode={} sale={}",
        addr,
        args.mode,
        args.sale_id
    );
    println!("tee-gate up:  http://{addr}");
    println!("mode:         {}", args.mode);
    println!("sale_id:      {}", args.sale_id);
    println!("policy_hash:  {}", policy::policy_hash());
    println!("sim-root.pub: {root_pub}  (written to {})", root_pub_path.display());
    axum::serve(listener, app).await.unwrap();
}

// ————————————————————————————————— routes ——————————————————————————————————

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "tee-gate", "ts_ms": state::GateState::now_ms() }))
}

async fn info(State(st): State<S>) -> impl IntoResponse {
    Json(json!({
        "service": "tee-gate",
        "mode": st.gate.mode,
        "sale_id": st.gate.sale_id,
        "verifier_name": st.gate.policy.verifier_name,
        "signing_address": st.gate.signing_address(),
        "sim_root_pubkey": st.gate.sim_root_address(),
        "policy_hash": st.gate.policy.hash,
        "pow_target": st.gate.policy.pow_target,
        "pass_cap_tokens": st.gate.policy.pass_cap_tokens.to_string(),
        "pass_ttl_ms": st.gate.policy.pass_ttl_ms,
        "model_id": st.model_id,
        "nearai_enabled": nearai_enabled(),
    }))
}

#[derive(Deserialize)]
struct ChallengeQuery {
    buyer: String,
    epoch: u32,
}

async fn challenge(
    State(st): State<S>,
    Query(q): Query<ChallengeQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let buyer = q.buyer.trim().to_lowercase();
    if buyer.len() < 2
        || buyer.len() > 64
        || !buyer.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return Err(bad_request(json!({ "error": "invalid_buyer_account" })));
    }
    if q.epoch >= 8 {
        return Err(bad_request(json!({ "error": "invalid_epoch" })));
    }
    let response = st.gate.issue_challenge(&buyer, q.epoch);
    if response.get("error").is_some() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, Json(response)));
    }
    Ok(Json(response))
}

#[derive(Deserialize)]
struct VerifyBody {
    session_id: String,
    pow_solution: String,
    answer: String,
}

async fn verify(
    State(st): State<S>,
    Json(body): Json<VerifyBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if st.gate.mode != "sim" {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "pass_issuance_disabled_for_attestation_preflight_mode" })),
        ));
    }
    match st.gate.solve(&body.session_id, &body.pow_solution, &body.answer) {
        Ok(mut out) => {
            let nonce = out["pass_nonce"].as_str().unwrap_or_default().to_string();
            out["evidence"] = assemble_evidence(&st, &nonce).await;
            Ok(Json(out))
        }
        Err(e) => Err(bad_request(json!({ "error": e }))),
    }
}

#[derive(Deserialize)]
struct AttestationQuery {
    nonce: String,
}

/// Standalone evidence bundle (for scripts/register-verifier.mjs).
async fn attestation(
    State(st): State<S>,
    Query(q): Query<AttestationQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if q.nonce.len() != 64 || !q.nonce.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad_request(json!({ "error": "nonce_must_be_64_hex" })));
    }
    let evidence = assemble_evidence(&st, &q.nonce).await;
    let evidence_str = serde_json::to_string(&evidence).unwrap_or_else(|_| String::new());
    Ok(Json(json!({
        "signing_address": st.gate.signing_address(),
        "signing_algo": "ed25519",
        "verifier_name": st.gate.policy.verifier_name,
        "policy_hash": st.gate.policy.hash,
        "nonce": q.nonce,
        "evidence_hash": pass::sha256_hex(evidence_str.as_bytes()),
        "evidence": evidence,
    })))
}

// ————————————————————————————— evidence —————————————————————————————

fn nearai_enabled() -> bool {
    #[cfg(feature = "nearai")]
    {
        nearai::enabled()
    }
    #[cfg(not(feature = "nearai"))]
    {
        false
    }
}

async fn assemble_evidence(st: &S, nonce: &str) -> Value {
    if st.gate.mode == "nearai" {
        #[cfg(feature = "nearai")]
        {
            match nearai::live_evidence(&st.model_id, nonce).await {
                Ok(v) => v,
                Err(e) => json!({ "mode": "NEAR-AI-CLOUD", "error": e.to_string(), "fallback": true }),
            }
        }
        #[cfg(not(feature = "nearai"))]
        {
            json!({ "mode": "NEAR-AI-CLOUD", "error": "built without --features nearai", "fallback": true })
        }
    } else {
        sim::sim_evidence(
            &st.gate.sim_root,
            &st.gate.signing,
            &st.gate.policy.hash,
            nonce,
        )
    }
}

fn bad_request(v: Value) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(v))
}
