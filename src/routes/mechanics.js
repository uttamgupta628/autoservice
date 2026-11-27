const router = require('express').Router();
const { MechanicProfile, ServiceCategory, Payment, Review } = require('../models');
const { asyncHandler, ApiError, protect, requireRole } = require('../middleware');
const { distanceKm, score, WEIGHTS } = require('../services/matching');
const { notify } = require('../services/helpers');
const { User } = require('../models');

const publicShape = (p, extra = {}) => ({
  id: p.user._id || p.user,
  profileId: p._id,
  name: p.user.name,
  avatar: p.user.avatar,
  shopName: p.shopName,
  bio: p.bio,
  experienceYears: p.experienceYears,
  vehicleMakes: p.vehicleMakes,
  equipment: p.equipment,
  city: p.city,
  serviceRadiusKm: p.serviceRadiusKm,
  rating: p.rating,
  reviewCount: p.reviewCount,
  completedJobs: p.completedJobs,
  verified: p.verificationStatus === 'verified',
  isOnline: p.isOnline,
  services: p.services.filter((s) => s.enabled),
  startingPrice: p.services.filter((s) => s.enabled).reduce((m, s) => Math.min(m, s.price ?? Infinity), Infinity),
  ...extra,
});

/* ---------- Owner side: browse mechanics (verified only) ---------- */
router.get(
  '/',
  protect,
  asyncHandler(async (req, res) => {
    const { q, category, lat, lng, maxDistance, minRating, maxPrice, vehicleMake, sort } = req.query;
    const filter = { verificationStatus: 'verified' };
    if (category) filter['services.category'] = category;
    if (vehicleMake) filter.$or = [{ vehicleMakes: new RegExp(`^${vehicleMake}$`, 'i') }, { vehicleMakes: { $size: 0 } }];
    if (minRating) filter.rating = { $gte: Number(minRating) };
    let profiles = await MechanicProfile.find(filter).populate('user', 'name avatar status');
    profiles = profiles.filter((p) => p.user && p.user.status === 'active' && (!category || p.services.some((s) => s.category === category && s.enabled)));
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      profiles = profiles.filter((p) => rx.test(p.user.name) || rx.test(p.shopName || '') || rx.test(p.city || '') || p.services.some((s) => rx.test(s.category)));
    }
    const origin = lat && lng ? [Number(lng), Number(lat)] : null;
    let rows = profiles.map((p) => {
      const dist = origin ? Math.round(distanceKm(p.location.coordinates, origin) * 10) / 10 : null;
      return { p, dist, score: score(p, { vehicleMake, dist: dist ?? 0 }) };
    });
    if (maxDistance && origin) rows = rows.filter((r) => r.dist <= Number(maxDistance));
    if (maxPrice) rows = rows.filter((r) => publicShape(r.p).startingPrice <= Number(maxPrice));
    const sorters = {
      distance: (a, b) => (a.dist ?? 0) - (b.dist ?? 0),
      rating: (a, b) => b.p.rating - a.p.rating,
      price: (a, b) => publicShape(a.p).startingPrice - publicShape(b.p).startingPrice,
      relevance: (a, b) => b.score - a.score,
    };
    rows.sort(sorters[sort] || sorters.relevance);
    res.json({
      mechanics: rows.map((r) => publicShape(r.p, { distanceKm: r.dist, relevance: r.score, sponsored: false })),
      weights: WEIGHTS,
    });
  })
);

/* ---------- Mechanic side: my profile ---------- */
router.get(
  '/me/profile',
  protect,
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const profile = await MechanicProfile.findOne({ user: req.user._id });
    const categories = await ServiceCategory.find({ active: true }).sort('name');
    res.json({ profile, categories });
  })
);

const EDITABLE = ['shopName', 'bio', 'experienceYears', 'vehicleMakes', 'equipment', 'serviceRadiusKm', 'city', 'address', 'isOnline', 'workingDays', 'workStart', 'workEnd', 'blockedDates'];
router.put(
  '/me/profile',
  protect,
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const profile = await MechanicProfile.findOne({ user: req.user._id });
    EDITABLE.forEach((k) => req.body[k] !== undefined && (profile[k] = req.body[k]));
    const { lat, lng } = req.body;
    if (lat !== undefined && lng !== undefined) profile.location = { type: 'Point', coordinates: [Number(lng), Number(lat)] };
    if (profile.serviceRadiusKm < 1 || profile.serviceRadiusKm > 200) throw new ApiError(400, 'Service radius must be 1 to 200 km');
    if (!/^\d{2}:\d{2}$/.test(profile.workStart) || !/^\d{2}:\d{2}$/.test(profile.workEnd)) throw new ApiError(400, 'Use HH:MM for working hours');
    await profile.save();
    res.json({ profile });
  })
);

router.put(
  '/me/services',
  protect,
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const { services } = req.body; // [{category, price, enabled}]
    if (!Array.isArray(services)) throw new ApiError(400, 'services must be an array');
    const valid = new Set((await ServiceCategory.find({ active: true })).map((c) => c.slug));
    const clean = services
      .filter((s) => valid.has(s.category))
      .map((s) => ({ category: s.category, price: Math.max(0, Number(s.price) || 0), enabled: !!s.enabled }));
    const profile = await MechanicProfile.findOneAndUpdate({ user: req.user._id }, { services: clean }, { new: true });
    res.json({ profile });
  })
);

router.put(
  '/me/documents',
  protect,
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const { documents } = req.body; // [{type, url, publicId, name}]
    if (!Array.isArray(documents)) throw new ApiError(400, 'documents must be an array');
    const profile = await MechanicProfile.findOneAndUpdate({ user: req.user._id }, { documents }, { new: true });
    res.json({ profile });
  })
);

router.post(
  '/me/submit',
  protect,
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const profile = await MechanicProfile.findOne({ user: req.user._id });
    // under_review means support asked for more information, so the mechanic may resubmit
    if (['verified', 'submitted'].includes(profile.verificationStatus)) throw new ApiError(400, `Already ${profile.verificationStatus}`);
    if (profile.verificationStatus === 'suspended') throw new ApiError(403, 'Your profile is suspended, contact support');
    if (!profile.documents.some((d) => d.type === 'id_proof')) throw new ApiError(400, 'An ID proof is required');
    if (!profile.documents.some((d) => d.type === 'shop_photo')) throw new ApiError(400, 'Add at least one shop / work photo');
    if (!profile.services.some((s) => s.enabled)) throw new ApiError(400, 'Enable at least one service category');
    profile.verificationStatus = 'submitted';
    profile.submittedAt = new Date();
    profile.verificationNote = undefined;
    await profile.save();
    res.json({ profile });
  })
);

router.get(
  '/me/earnings',
  protect,
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const payments = await Payment.find({ mechanic: req.user._id }).populate({ path: 'job', select: 'category services scheduledAt', }).sort('-createdAt').limit(100);
    const sum = (arr, k) => Math.round(arr.reduce((a, p) => a + (p[k] || 0), 0) * 100) / 100;
    const captured = payments.filter((p) => p.status === 'captured');
    const refunded = payments.filter((p) => p.status === 'refunded');
    const profile = await MechanicProfile.findOne({ user: req.user._id }).select('rating reviewCount completedJobs');
    res.json({
      gross: sum(captured, 'amount'),
      fees: Math.round(captured.reduce((a, p) => a + (p.mechanicFee ?? p.platformFee ?? 0), 0) * 100) / 100,
      net: sum(captured, 'payout'),
      refunds: sum(refunded, 'amount'),
      pendingPayout: sum(captured.filter((p) => p.payoutStatus === 'pending'), 'payout'),
      settledPayout: sum(captured.filter((p) => p.payoutStatus === 'settled'), 'payout'),
      rating: profile.rating,
      reviewCount: profile.reviewCount,
      completedJobs: profile.completedJobs,
      payments,
    });
  })
);

/* ---------- single public profile (keep after /me routes) ---------- */
router.get(
  '/:id',
  protect,
  asyncHandler(async (req, res) => {
    const p = await MechanicProfile.findOne({ user: req.params.id, verificationStatus: 'verified' }).populate('user', 'name avatar');
    if (!p) throw new ApiError(404, 'Mechanic not found');
    const reviews = await Review.find({ mechanic: req.params.id }).populate('owner', 'name avatar').sort('-createdAt').limit(10);
    res.json({ mechanic: publicShape(p, { documents: p.documents.filter((d) => d.type !== 'id_proof').map((d) => ({ type: d.type, name: d.name })) }), reviews });
  })
);

module.exports = router;