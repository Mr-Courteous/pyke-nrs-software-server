const bcrypt = require('bcryptjs');
const prisma = require('../db/prismaClient');

/**
 * User store for Administrative Services.
 *
 * Same shape as the other *Store.js files: thin wrappers around Prisma
 * with the validation and any cross-cutting rule (role whitelist,
 * password length, never returning passwordHash) centralized here
 * rather than duplicated across authRoutes.js handlers.
 */

const VALID_ROLES = ['ADMIN', 'FINANCE', 'VIEWER'];
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

function serialize(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

async function userCount() {
  return prisma.user.count();
}

/**
 * role defaults to VIEWER — the least-privilege default matches the
 * platform documentation's RBAC posture (scope each user to what they
 * need, not everything by default). Bootstrap and admin-created users
 * override it explicitly.
 */
async function createUser({ email, password, name, role }) {
  if (!email) throw new Error('email is required.');
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (role && !VALID_ROLES.includes(role)) {
    throw new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) throw new Error(`A user with email ${normalizedEmail} already exists.`);

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({
    data: { email: normalizedEmail, passwordHash, name: name || null, role: role || 'VIEWER' },
  });
  return serialize(user);
}

/** Returns the serialized user on a correct, active-account login; null otherwise. Never distinguishes "no such user" from "wrong password" in what it returns, so callers can't leak which emails are registered. */
async function verifyCredentials(email, password) {
  const user = await prisma.user.findUnique({ where: { email: (email || '').toLowerCase().trim() } });
  if (!user || !user.active) return null;
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  return ok ? serialize(user) : null;
}

async function getUserById(id) {
  return serialize(await prisma.user.findUnique({ where: { id } }));
}

async function listUsers() {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  return users.map(serialize);
}

async function setRole(id, role) {
  if (!VALID_ROLES.includes(role)) throw new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
  const user = await prisma.user.update({ where: { id }, data: { role } }).catch(() => null);
  return serialize(user);
}

async function setActive(id, active) {
  const user = await prisma.user.update({ where: { id }, data: { active: !!active } }).catch(() => null);
  return serialize(user);
}

module.exports = {
  VALID_ROLES,
  userCount,
  createUser,
  verifyCredentials,
  getUserById,
  listUsers,
  setRole,
  setActive,
};
