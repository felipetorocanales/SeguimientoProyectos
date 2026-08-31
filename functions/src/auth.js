/**
 * auth.js - API Key middleware for Cloud Functions
 * 
 * Every external request (from Teams / Power Automate) must include:
 *   Header: X-API-Key: <value of NEXUS_API_KEY env var>
 * 
 * Set the key with:
 *   firebase functions:secrets:set NEXUS_API_KEY
 */

const { defineSecret } = require("firebase-functions/params");

// Define the secret - set via: firebase functions:secrets:set NEXUS_API_KEY
const NEXUS_API_KEY = defineSecret("NEXUS_API_KEY");

/**
 * Express middleware that validates the X-API-Key header.
 * Returns a middleware function that uses the resolved secret at runtime.
 */
function apiKeyMiddleware(req, res, next) {
  const providedKey = req.headers["x-api-key"];
  const expectedKey = process.env.NEXUS_API_KEY;

  if (!expectedKey) {
    // In local emulator without secret, skip auth (dev mode)
    console.warn("[Auth] NEXUS_API_KEY not set - running in dev mode (no auth)");
    return next();
  }

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(403).json({
      error: "Forbidden",
      message: "API key inválida o no proporcionada. Incluye el header X-API-Key."
    });
  }

  next();
}

module.exports = { apiKeyMiddleware, NEXUS_API_KEY };
