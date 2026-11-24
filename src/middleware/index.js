const jwt = require('jsonwebtoken');
const multer = require('multer');
const { User } = require('../models');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Not authenticated');
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new ApiError(401, 'Session expired, please log in again');
  }
  const user = await User.findById(payload.id);
  if (!user) throw new ApiError(401, 'Account no longer exists');
  if (user.status === 'suspended') throw new ApiError(403, 'This account has been suspended');
  req.user = user;
  next();
});

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new ApiError(403, 'You do not have access to this resource'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) =>
    /^(image\/|application\/pdf)/.test(file.mimetype) ? cb(null, true) : cb(new ApiError(400, 'Only images or PDF files are allowed')),
});

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || 'Server error';
  if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  } else if (err.name === 'CastError') {
    status = 400;
    message = 'Invalid id';
  } else if (err.code === 11000) {
    status = 409;
    message = 'Already exists: ' + Object.keys(err.keyValue || {}).join(', ');
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    status = 400;
    message = 'File too large (max 8MB)';
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ message });
};

module.exports = { asyncHandler, ApiError, protect, requireRole, upload, errorHandler };
