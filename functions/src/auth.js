/**
 * auth.js - API Key middleware for Cloud Functions v2
 *
 * Every external request (from Teams / Power Automate) must include:
 *   Header: X-API-Key: <value stored in Firebase Secret Manager as NEXUS_API_KEY>
 *
 * In Firebase Functions v2, secrets declared via `secrets: ["NEXUS_API_KEY"]`
 * in onRequest() options are automatically available as process.env.NEXUS_API_KEY
 * at runtime inside the function handler.
 */

/**
 * Express middleware that validates the X-API-Key header.
 */
function apiKeyMiddleware(req, res, next) {
  const providedKey = req.headers["x-api-key"];
  const expectedKey = process.env.NEXUS_API_KEY ? process.env.NEXUS_API_KEY.trim() : undefined;

  // In local dev / emulator without secret configured, allow all requests
  if (!expectedKey) {
    console.warn("[Auth] NEXUS_API_KEY not set – running without authentication (dev mode)");
    return next();
  }

  if (!providedKey) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Falta el header X-API-Key."
    });
  }

  // Constant-time comparison to prevent timing attacks
  const provided = Buffer.from(providedKey);
  const expected = Buffer.from(expectedKey);

  if (provided.length !== expected.length) {
    return res.status(403).json({
      error: "Forbidden",
      message: "API key inválida."
    });
  }

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided[i] ^ expected[i];
  }

  if (mismatch !== 0) {
    return res.status(403).json({
      error: "Forbidden",
      message: "API key inválida."
    });
  }

  next();
}

module.exports = { apiKeyMiddleware };
