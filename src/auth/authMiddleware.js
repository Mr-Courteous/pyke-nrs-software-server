const { verifyToken } = require('./tokens');

/**
 * Verifies `Authorization: Bearer <token>` and attaches req.user =
 * { id, email, role }. Applied at the top of every financial-data
 * router (arRoutes, apRoutes, glRoutes, bankRoutes) and to the
 * invoice/stats routes in routes.js — everything that reads or writes
 * real business data. Left off the QuickBooks OAuth connect/callback
 * routes (a browser redirect flow that can't carry a bearer header —
 * protected by its own CSRF-state cookie instead), the NRS poll and
 * webhook endpoints (external systems, protected by CRON_SECRET / a
 * shared source-system convention, not a logged-in user), and
 * /api/auth/login + /api/auth/bootstrap-admin themselves, which have
 * to be reachable before anyone has a token.
 */
function requireAuth(req, res, next) {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header.' });

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * Gates a route to specific roles. Must run after requireAuth.
 * ADMIN always passes, regardless of which roles are listed — it's
 * the superset role, not a fourth thing every route has to name
 * explicitly.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (req.user.role === 'ADMIN' || allowedRoles.includes(req.user.role)) return next();
    return res.status(403).json({ error: `This action requires one of these roles: ${allowedRoles.join(', ')}.` });
  };
}

module.exports = { requireAuth, requireRole };
