require('dotenv').config();
const connectDB = require('./config/db');
const createApp = require('./app');
const { ServiceCategory } = require('./models');
const { CATEGORIES, slug } = require('./config/categories');
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

(async () => {
  await connectDB();
  // a fresh database has no service categories, so the request form would have nothing to pick
  if (!(await ServiceCategory.countDocuments())) {
    for (const c of CATEGORIES) await ServiceCategory.updateOne({ slug: slug(c.name) }, { $set: { ...c, slug: slug(c.name) } }, { upsert: true });
    console.log('Created default service categories (run npm run seed for demo accounts)');
  }
  const port = process.env.PORT || 5000;
  createApp().listen(port, '0.0.0.0', () => console.log(`AutoService API running on port ${port}`));
})().catch((e) => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});