/** Seeds categories, settings, an admin, a demo owner and three verified demo mechanics. Safe to re-run. */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { User, Vehicle, ServiceCategory, MechanicProfile, Setting } = require('./models');

const { CATEGORIES, slug } = require('./config/categories');

const MECHANICS = [
  { name: 'Ravi Kumar', email: 'ravi@autoservice.test', phone: '9000000001', shopName: 'Ravi Auto Care', city: 'Bengaluru', lat: 12.9716, lng: 77.5946, years: 8, makes: ['Hyundai', 'Maruti', 'Honda'], equip: ['AC gas kit', 'Diagnostic scanner', 'Wheel balancer'], radius: 15, rating: 4.8, reviews: 128, done: 210 },
  { name: 'MK Mechanic', email: 'mk@autoservice.test', phone: '9000000002', shopName: 'MK Mechanic', city: 'Bengaluru', lat: 12.9352, lng: 77.6245, years: 5, makes: ['Toyota', 'Honda'], equip: ['Diagnostic scanner'], radius: 12, rating: 4.7, reviews: 96, done: 140 },
  { name: 'Prime Garage', email: 'prime@autoservice.test', phone: '9000000003', shopName: 'Prime Garage', city: 'Bengaluru', lat: 13.0358, lng: 77.597, years: 12, makes: [], equip: ['AC gas kit', 'Wheel balancer'], radius: 20, rating: 4.9, reviews: 210, done: 380 },
];

(async () => {
  await connectDB();
  await Setting.findOneAndUpdate({ key: 'platform' }, { $setOnInsert: { key: 'platform' } }, { upsert: true });
  for (const c of CATEGORIES) await ServiceCategory.updateOne({ slug: slug(c.name) }, { $set: { ...c, slug: slug(c.name) } }, { upsert: true });

  const upsertUser = async (data) => (await User.findOne({ email: data.email })) || (await User.create(data));
  await upsertUser({ name: 'Platform Admin', email: 'admin@autoservice.test', password: 'Admin@123', role: 'admin' });
  const owner = await upsertUser({ name: 'Aman Verma', email: 'aman@autoservice.test', phone: '9000000100', password: 'Password@123', role: 'owner' });
  if (!(await Vehicle.exists({ owner: owner._id }))) {
    await Vehicle.create({ owner: owner._id, make: 'Hyundai', model: 'i20', year: 2020, plate: 'KA03AB1234', mileage: 42000, isDefault: true });
  }

  for (const m of MECHANICS) {
    const u = await upsertUser({ name: m.name, email: m.email, phone: m.phone, password: 'Password@123', role: 'mechanic' });
    await MechanicProfile.findOneAndUpdate(
      { user: u._id },
      {
        user: u._id, shopName: m.shopName, bio: `Experienced mechanic with ${m.years}+ years in vehicle service and repair.`, experienceYears: m.years,
        vehicleMakes: m.makes, equipment: m.equip, serviceRadiusKm: m.radius, city: m.city, address: `${m.shopName}, ${m.city}`,
        location: { type: 'Point', coordinates: [m.lng, m.lat] }, isOnline: true, workingDays: [0, 1, 2, 3, 4, 5, 6], workStart: '08:00', workEnd: '21:00',
        services: CATEGORIES.map((c) => ({ category: slug(c.name), price: c.basePrice + (m.years % 3) * 100, enabled: c.requiredEquipment.every((e) => m.equip.includes(e)) })),
        documents: [{ type: 'id_proof', name: 'ID proof (demo)', url: 'https://placehold.co/600x400?text=ID' }, { type: 'shop_photo', name: 'Shop photo (demo)', url: 'https://placehold.co/600x400?text=Shop' }],
        verificationStatus: 'verified', rating: m.rating, reviewCount: m.reviews, completedJobs: m.done,
      },
      { upsert: true }
    );
  }
  console.log('Seed complete.\n  admin    admin@autoservice.test / Admin@123\n  owner    aman@autoservice.test / Password@123\n  mechanic ravi@autoservice.test / Password@123');
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});