const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware');
const { uploads, vehicles, categories, notifications, reviews, disputes } = require('./routes/basics');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  const origins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
  app.use(cors({ origin: origins.includes('*') ? true : origins }));
  app.use(express.json({ limit: '1mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  app.get('/', (req, res) => res.json({ name: 'AutoService API', status: 'running', health: '/api/health' }));
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.AUTH_RATE_LIMIT || 50), standardHeaders: true, legacyHeaders: false });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/uploads', uploads);
  app.use('/api/vehicles', vehicles);
  app.use('/api/categories', categories);
  app.use('/api/mechanics', require('./routes/mechanics'));
  app.use('/api/diagnostics', require('./routes/diagnostics'));
  app.use('/api/jobs', require('./routes/jobs'));
  app.use('/api/messages', require('./routes/messages'));
  app.use('/api/notifications', notifications);
  app.use('/api/reviews', reviews);
  app.use('/api/disputes', disputes);
  app.use('/api/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).json({ message: 'Route not found' }));
  app.use(errorHandler);
  return app;
}

module.exports = createApp;