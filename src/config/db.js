const dns = require('dns');
const mongoose = require('mongoose');

// Some networks/routers refuse the SRV lookup that mongodb+srv:// needs; use public DNS instead
dns.setServers(['8.8.8.8', '1.1.1.1']);

module.exports = async function connectDB(uri = process.env.MONGODB_URI) {
  if (!uri) throw new Error('MONGODB_URI is not set');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  // make sure the unique indexes (slot reservations, one payment per job) exist before serving traffic
  await mongoose.connection.syncIndexes?.().catch(() => {});
  console.log('MongoDB connected');
};