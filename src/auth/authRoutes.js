const express = require('express');
const authStore = require('./authStore');
const { signToken } = require('./tokens');
const { requireAuth, requireRole } = require('./authMiddleware');

const router = express.Router();

/**
 * One-time bootstrap: creates the first user, as ADMIN, and only
 * works while the user table is empty. This is what lets a freshly
 * migrated database go from "zero users, every route locked" to
 * "has an admin who can create everyone else" without a secret baked
 * into a seed script or committed to the repo. Once any user exists,
 * this route refuses — every subsequent user is created by an admin
 * via POST /api/auth/users.
 * Body: { email, password, name? }
 */
router.post('/bootstrap-admin', async (req, res) => {
  try {
    const existing = await authStore.userCount();
    if (existing > 0) {
      return res.status(403).json({ error: 'Setup is already complete — sign in and create users via POST /api/auth/users instead.' });
    }
    const { email, password, name } = req.body || {};
    const user = await authStore.createUser({ email, password, name, role: 'ADMIN' });
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Body: { email, password } */
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required.' });

  const user = await authStore.verifyCredentials(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ user, token: signToken(user) });
});

/** Whoever the bearer token belongs to — lets a frontend confirm a stored token is still valid and see current role. */
router.get('/me', requireAuth, async (req, res) => {
  const user = await authStore.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// ── User management (ADMIN only) ────────────────────────────────────

router.get('/users', requireAuth, requireRole('ADMIN'), async (req, res) => {
  res.json(await authStore.listUsers());
});

/** Body: { email, password, name?, role? } — role defaults to VIEWER if omitted. */
router.post('/users', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const user = await authStore.createUser(req.body || {});
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Body: { role } — ADMIN | FINANCE | VIEWER */
router.patch('/users/:id/role', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const user = await authStore.setRole(req.params.id, req.body?.role);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Body: { active } — deactivating blocks login without deleting the account, preserving whatever it created (bills, payments, journal entries) as attributable audit history. */
router.patch('/users/:id/active', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const user = await authStore.setActive(req.params.id, req.body?.active);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

module.exports = router;
