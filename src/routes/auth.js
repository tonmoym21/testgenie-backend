const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');
const authService = require('../services/authService');

const router = Router();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

const registerWithInviteSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  inviteToken: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

// POST /api/auth/register
router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const user = await authService.register(req.body.email, req.body.password);
    res.status(201).json({
      message: 'Registration successful',
      user: { id: user.id, email: user.email, organizationId: user.organization_id },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register-with-invite - Register and accept invite in one step
router.post('/register-with-invite', authLimiter, validate(registerWithInviteSchema), async (req, res, next) => {
  try {
    const result = await authService.registerWithInvite(
      req.body.email,
      req.body.password,
      req.body.inviteToken
    );
    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: result.user.id,
        email: result.user.email,
        organizationId: result.user.organization_id,
      },
      organization: result.organization,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const tokens = await authService.login(req.body.email, req.body.password);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', validate(refreshSchema), async (req, res, next) => {
  try {
    const tokens = await authService.refresh(req.body.refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', validate(logoutSchema), async (req, res, next) => {
  try {
    await authService.logout(req.body.refreshToken);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me - Get current user info including org
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const orgInfo = await authService.getUserOrgInfo(req.user.id);
    res.json({
      id: req.user.id,
      email: req.user.email,
      organization: orgInfo,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
