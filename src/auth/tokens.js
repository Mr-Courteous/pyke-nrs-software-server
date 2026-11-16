const jwt = require('jsonwebtoken');

/**
 * Stateless JWT auth, same posture as the CRON_SECRET bearer-token
 * pattern already protecting GET /api/quickbooks/poll — a shared
 * secret checked per-request rather than server-side session storage,
 * which is what a serverless deployment (Vercel, no persistent
 * process) needs anyway.
 */

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set. Set it in your .env before starting the server.');
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET is too short. Use at least 32 random characters (for example: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))").');
  }
  return secret;
}

/** 12h expiry — short enough that a leaked token has a shelf life, long enough not to force re-login mid-workday. */
function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, getSecret(), { expiresIn: '12h' });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signToken, verifyToken };
