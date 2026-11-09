//! Small helpers: wide math, signature/key decoding, events and input validation.

use crate::*;

pub(crate) fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

/// Standard base64 (with padding) → 64-byte signature.
pub(crate) fn decode_sig(sig_b64: &str) -> [u8; 64] {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let b = sig_b64.as_bytes();
    // 64 bytes encode to 88 chars ending in "==".
    let ok = b.len() == 88 && b[86] == b'=' && b[87] == b'=';
    let mut out = [0u8; 64];
    let mut n = 0;
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in &b[..if ok { 86 } else { 0 }] {
        let Some(v) = val(c) else { env::panic_str(err::BAD_PASS) };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if n == 64 {
                env::panic_str(err::BAD_PASS);
            }
            out[n] = (acc >> bits) as u8;
            n += 1;
        }
    }
    if n != 64 {
        env::panic_str(err::BAD_PASS);
    }
    out
}

pub(crate) fn decode_key(hex_key: &str) -> Option<[u8; 32]> {
    hex::decode(hex_key).ok()?.try_into().ok()
}

pub(crate) fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

/// Did the single callback input succeed? Reads no data: a successful call
/// that returns a value reports `TooLong`, which is still a success.
pub(crate) fn promise_ok() -> bool {
    env::promise_results_count() == 1
        && !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

/// NEP-297 event. `data` is one JSON object; every string interpolated into
/// it is an account id, a decimal number or a fixed label, so needs no escaping.
pub(crate) fn event(kind: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"pit","version":"1.0.0","event":"{kind}","data":[{data}]}}"#
    ));
}

/// Names: 1–64 chars, no control or invisible/bidi formatting characters
/// (which could make one coin look like another).
pub fn valid_name(s: &str) -> bool {
    let n = s.chars().count();
    (1..=64).contains(&n)
        && s.trim() == s
        && !s.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}')
        })
}

/// Icons: a short emoji/text, or a base64 raster data URL (no SVG: it can carry script).
pub fn valid_icon(s: &str) -> bool {
    if s.len() > MAX_ICON_BYTES {
        return false;
    }
    for prefix in ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"] {
        if let Some(b64) = s.strip_prefix(prefix) {
            return !b64.is_empty() && b64.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c));
        }
    }
    s.len() <= 32 && !s.contains(':') && !s.contains('<') && valid_name(s)
}

/// Verifier names land in event JSON, so keep them to safe characters.
pub(crate) fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

