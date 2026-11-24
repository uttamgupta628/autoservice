const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { User, MechanicProfile } = require('../models');
const { asyncHandler, ApiError, protect, upload } = require('../middleware');
const { uploadBuffer, destroy } = require('../config/cloudinary');

const sign = (user) => jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

async function withProfile(user) {
  const out = user.toJSON();
  if (user.role === 'mechanic') {
    const p = await MechanicProfile.findOne({ user: user._id }).select('verificationStatus verificationNote isOnline');
    out.mechanic = p;
  }
  return out;
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { name, email, phone, password, role } = req.body;
    if (!name || !email || !password) throw new ApiError(400, 'Name, email and password are required');
    if (password.length < 6) throw new ApiError(400, 'Password must be at least 6 characters');
    if (!['owner', 'mechanic'].includes(role)) throw new ApiError(400, 'Role must be owner or mechanic');
    if (await User.findOne({ email: email.toLowerCase() })) throw new ApiError(409, 'An account with this email already exists');
    if (phone && (await User.findOne({ phone }))) throw new ApiError(409, 'An account with this phone already exists');
    const user = await User.create({ name, email, phone, password, role });
    if (role === 'mechanic') await MechanicProfile.create({ user: user._id });
    res.status(201).json({ token: sign(user), user: await withProfile(user) });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { identifier, email, password } = req.body; // identifier = email or phone
    const id = (identifier || email || '').trim();
    if (!id || !password) throw new ApiError(400, 'Email/phone and password are required');
    const user = await User.findOne(id.includes('@') ? { email: id.toLowerCase() } : { phone: id }).select('+password');
    if (!user || !(await user.matchPassword(password))) throw new ApiError(401, 'Invalid credentials');
    if (user.status === 'suspended') throw new ApiError(403, 'This account has been suspended');
    res.json({ token: sign(user), user: await withProfile(user) });
  })
);

router.get('/me', protect, asyncHandler(async (req, res) => res.json({ user: await withProfile(req.user) })));

router.put(
  '/me',
  protect,
  asyncHandler(async (req, res) => {
    const { name, phone } = req.body;
    if (name) req.user.name = name;
    if (phone !== undefined) req.user.phone = phone;
    await req.user.save();
    res.json({ user: await withProfile(req.user) });
  })
);

router.post(
  '/avatar',
  protect,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file uploaded');
    const old = req.user.avatar?.publicId;
    req.user.avatar = await uploadBuffer(req.file.buffer, 'autoservice/avatars');
    await req.user.save();
    destroy(old);
    res.json({ user: await withProfile(req.user) });
  })
);

router.put(
  '/password',
  protect,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.matchPassword(currentPassword || ''))) throw new ApiError(400, 'Current password is incorrect');
    if (!newPassword || newPassword.length < 6) throw new ApiError(400, 'New password must be at least 6 characters');
    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated' });
  })
);

module.exports = router;
