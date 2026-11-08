let challenges = 0;
let attempts = 0;
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  let result;
  if (path === "/api/info") result = { sale_id: "PIT-001", mode: "test", signing_address: "test" };
  else if (path === "/api/gate/challenge") {
    challenges++;
    result = { session_id: `session-${challenges}`, nonce: `nonce-${challenges}`, pow_target: "18446744073709551615", challenge: { hint: "test", options: ["a", "b", "c"] } };
  } else if (path === "/api/gate/verify") {
    attempts++;
    const body = JSON.parse(options.body);
    if (body.session_id !== `session-${attempts}`) throw new Error("challenge was reused");
    result = attempts === 1 ? { error: "challenge_failed" } : { pass: "{}", sig_b64: "test", verifier: {} };
  } else throw new Error(`unexpected path ${path}`);
  return { json: async () => result };
};
