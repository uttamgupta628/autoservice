const router = require('express').Router();
const {
  User, MechanicProfile, Job, Payment, Dispute, AuditLog, ServiceCategory, Setting,
} = require('../models');
const { asyncHandler, ApiError, protect, requireRole } = require('../middleware');
const { getSettings, notify, audit, round2 } = require('../services/helpers');

router.use(protect, requireRole('admin'));
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/* ---------- A-01 Overview ---------- */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 7 * 86400000);
    const [users, mechanics, bookings, revenueAgg, trend, byCat, openDisputes, pendingVerification] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: 'mechanic' }),
      Job.countDocuments({ status: { $in: ['booked', 'in_progress', 'completed'] } }),
      Payment.aggregate([{ $match: { status: 'captured' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Job.find({ createdAt: { $gte: since } }).select('createdAt'),
      Job.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Dispute.countDocuments({ status: { $ne: 'resolved' } }),
      MechanicProfile.countDocuments({ verificationStatus: { $in: ['submitted', 'under_review'] } }),
    ]);
    // fill the last 7 days so the chart has no gaps
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ date: d, count: trend.filter((j) => j.createdAt.toISOString().slice(0, 10) === d).length });
    }
    const totalJobs = byCat.reduce((a, c) => a + c.count, 0) || 1;
    res.json({
      totalUsers: users, mechanics, bookings, revenue: round2(revenueAgg[0]?.total || 0),
      trend: days,
      categories: byCat.map((c) => ({ category: c._id, count: c.count, percent: Math.round((c.count / totalJobs) * 100) })),
      alerts: { openDisputes, pendingVerification },
    });
  })
);

/* ---------- A-02 Verification ---------- */
router.get(
  '/mechanics',
  asyncHandler(async (req, res) => {
    const map = { pending: ['submitted', 'under_review'], approved: ['verified'], rejected: ['rejected'], suspended: ['suspended'], draft: ['draft'] };
    const filter = req.query.status && map[req.query.status] ? { verificationStatus: { $in: map[req.query.status] } } : {};
    const profiles = await MechanicProfile.find(filter).populate('user', 'name email phone avatar').sort('-submittedAt -createdAt').limit(200);
    const counts = {};
    for (const [k, v] of Object.entries(map)) counts[k] = await MechanicProfile.countDocuments({ verificationStatus: { $in: v } });
    res.json({ mechanics: profiles, counts });
  })
);

router.get(
  '/mechanics/:id',
  asyncHandler(async (req, res) => {
    const p = await MechanicProfile.findById(req.params.id).populate('user', 'name email phone avatar status');
    if (!p) throw new ApiError(404, 'Mechanic not found');
    res.json({ mechanic: p });
  })
);

router.post(
  '/mechanics/:id/decision',
  asyncHandler(async (req, res) => {
    const { decision, reason } = req.body; // approve | reject | request_info | suspend
    const p = await MechanicProfile.findById(req.params.id);
    if (!p) throw new ApiError(404, 'Mechanic not found');
    if (['reject', 'request_info', 'suspend'].includes(decision) && !reason) throw new ApiError(400, 'A reason is required');
    const next = { approve: 'verified', reject: 'rejected', request_info: 'under_review', suspend: 'suspended' }[decision];
    if (!next) throw new ApiError(400, 'Unknown decision');
    p.verificationStatus = next;
    p.verificationNote = reason;
    await p.save();
    const msgs = {
      approve: ['You are verified', 'You can now receive paid jobs.'],
      reject: ['Verification rejected', reason],
      request_info: ['More information needed', reason],
      suspend: ['Profile suspended', reason],
    }[decision];
    notify(p.user, msgs[0], msgs[1], 'verification');
    await audit(req, `mechanic.${decision}`, String(p._id), { reason });
    res.json({ mechanic: p });
  })
);

/* ---------- A-03 Jobs ---------- */
router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status === 'ongoing' ? { $in: ['booked', 'in_progress'] } : req.query.status;
    if (req.query.flagged) filter['classificationFlags.status'] = 'open';
    let jobs = await Job.find(filter).populate('owner', 'name').populate('mechanic', 'name').populate('vehicle', 'make model year').populate('classificationFlags.mechanic', 'name').sort('-createdAt').limit(200);
    if (req.query.q) {
      const r = rx(req.query.q);
      jobs = jobs.filter((j) => r.test(j.category) || r.test(j.owner?.name || '') || r.test(j.mechanic?.name || '') || r.test(String(j._id)));
    }
    res.json({ jobs });
  })
);

router.post(
  '/jobs/:id/classification',
  asyncHandler(async (req, res) => {
    const diag = require('../services/diagnostics');
    const job = await Job.findById(req.params.id);
    if (!job?.diagnosis?.classification) throw new ApiError(400, 'This job has no symptom report');
    if (!diag.CLASSES[req.body.classification]) throw new ApiError(400, 'Unknown classification');
    job.diagnosis.classification = req.body.classification;
    job.diagnosis.serviceName = diag.nameFor(job.diagnosis.symptomId, req.body.classification);
    job.diagnosis.classificationReason = `Changed by support${req.body.note ? `: ${req.body.note}` : ''}`;
    if (job.services?.[0]) job.services[0].name = job.diagnosis.serviceName;
    job.classificationFlags.forEach((f) => { if (f.status === 'open') f.status = f.recommended === req.body.classification ? 'accepted' : 'dismissed'; });
    job.history.push({ status: job.status, by: req.user._id, note: `Support set classification to ${req.body.classification}` });
    await job.save();
    [job.owner, job.mechanic].filter(Boolean).forEach((u) => notify(u, 'Job classification updated', `Support changed this job to ${diag.CLASSES[req.body.classification].label}`, 'booking', job._id));
    await audit(req, 'job.classification', String(job._id), { to: req.body.classification, note: req.body.note });
    res.json({ job });
  })
);

router.post(
  '/jobs/:id/cancel',
  asyncHandler(async (req, res) => {
    const job = await Job.findById(req.params.id);
    if (!job || ['completed', 'cancelled'].includes(job.status)) throw new ApiError(400, 'Job cannot be cancelled');
    job.status = 'cancelled';
    job.cancelReason = req.body.reason || 'Cancelled by admin';
    job.history.push({ status: 'cancelled', by: req.user._id, note: job.cancelReason });
    await job.save();
    await require('../services/slots').releaseSlots(job._id);
    await Payment.findOneAndUpdate({ job: job._id, status: 'authorized' }, { status: 'voided' });
    [job.owner, job.mechanic].filter(Boolean).forEach((u) => notify(u, 'Job cancelled by support', job.cancelReason, 'booking', job._id));
    await audit(req, 'job.cancel', String(job._id), { reason: job.cancelReason });
    res.json({ job });
  })
);

/* ---------- A-04 Finance ---------- */
router.get(
  '/finance',
  asyncHandler(async (req, res) => {
    const filter = req.query.status ? { status: req.query.status } : {};
    const payments = await Payment.find(filter).populate('owner', 'name').populate('mechanic', 'name').populate('job', 'category').sort('-createdAt').limit(200);
    const all = await Payment.find();
    const sum = (a, k) => round2(a.reduce((s, p) => s + (p[k] || 0), 0));
    const captured = all.filter((p) => p.status === 'captured');
    res.json({
      totalRevenue: round2(captured.reduce((s, p) => s + (p.totalCharged || p.amount || 0), 0)),
      ownerFees: sum(captured, 'ownerFee'),
      mechanicFees: sum(captured, 'mechanicFee'),
      payouts: sum(captured.filter((p) => p.payoutStatus === 'settled'), 'payout'),
      pendingPayouts: sum(captured.filter((p) => p.payoutStatus === 'pending'), 'payout'),
      platformFees: sum(captured, 'platformFee'),
      refunds: round2(all.filter((p) => p.status === 'refunded').reduce((s, p) => s + (p.totalCharged || p.amount || 0), 0)),
      payments,
    });
  })
);

router.post(
  '/payments/:id/refund',
  asyncHandler(async (req, res) => {
    const p = await Payment.findById(req.params.id);
    if (!p || p.status !== 'captured') throw new ApiError(400, 'Only captured payments can be refunded');
    if (p.payoutStatus === 'settled') throw new ApiError(400, 'Payout already settled, handle this as a payout exception');
    p.status = 'refunded';
    p.payoutStatus = 'none';
    p.refundedAt = new Date();
    await p.save();
    notify(p.owner, 'Refund issued', `₹${p.totalCharged || p.amount} will be returned to your payment method`, 'payment', p.job);
    await audit(req, 'payment.refund', String(p._id), { amount: p.amount, reason: req.body.reason });
    res.json({ payment: p });
  })
);

router.post(
  '/payments/:id/settle',
  asyncHandler(async (req, res) => {
    const p = await Payment.findOneAndUpdate({ _id: req.params.id, status: 'captured', payoutStatus: 'pending' }, { payoutStatus: 'settled', settledAt: new Date() }, { new: true });
    if (!p) throw new ApiError(400, 'No pending payout for this payment');
    notify(p.mechanic, 'Payout settled', `₹${p.payout} has been paid out`, 'payment', p.job);
    await audit(req, 'payment.payout_settled', String(p._id), { payout: p.payout });
    res.json({ payment: p });
  })
);

/* ---------- A-05 Trust & Safety ---------- */
router.get(
  '/disputes',
  asyncHandler(async (req, res) => {
    const filter = req.query.status ? { status: req.query.status } : {};
    const disputes = await Dispute.find(filter).populate('raisedBy', 'name role').populate('against', 'name role').populate('job', 'category').sort('-createdAt').limit(200);
    res.json({ disputes });
  })
);

router.patch(
  '/disputes/:id',
  asyncHandler(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw new ApiError(404, 'Dispute not found');
    if (!['open', 'in_review', 'resolved'].includes(req.body.status)) throw new ApiError(400, 'Invalid status');
    if (req.body.status === 'resolved' && !req.body.resolution) throw new ApiError(400, 'Add a resolution note');
    d.status = req.body.status;
    if (req.body.resolution) d.resolution = req.body.resolution;
    if (d.status === 'resolved') d.resolvedBy = req.user._id;
    await d.save();
    notify(d.raisedBy, 'Your case was updated', `Status: ${d.status.replace('_', ' ')}`, 'dispute', d.job);
    await audit(req, 'dispute.update', String(d._id), { status: d.status });
    res.json({ dispute: d });
  })
);

/* ---------- A-08 Accounts ---------- */
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.q) filter.$or = [{ name: rx(req.query.q) }, { email: rx(req.query.q) }, { phone: rx(req.query.q) }];
    res.json({ users: await User.find(filter).sort('-createdAt').limit(200) });
  })
);

router.patch(
  '/users/:id/status',
  asyncHandler(async (req, res) => {
    const { status, reason } = req.body;
    if (!['active', 'suspended'].includes(status)) throw new ApiError(400, 'Invalid status');
    if (String(req.params.id) === String(req.user._id)) throw new ApiError(400, 'You cannot suspend yourself');
    if (status === 'suspended' && !reason) throw new ApiError(400, 'A reason is required');
    const u = await User.findById(req.params.id);
    if (!u) throw new ApiError(404, 'User not found');
    u.status = status;
    u.suspensionReason = status === 'suspended' ? reason : undefined;
    await u.save();
    await audit(req, `user.${status === 'suspended' ? 'suspend' : 'reactivate'}`, String(u._id), { reason });
    res.json({ user: u });
  })
);

router.post(
  '/admins',
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) throw new ApiError(400, 'Name, email and a password of 8+ characters are required');
    if (await User.exists({ email: email.toLowerCase() })) throw new ApiError(409, 'Email already in use');
    const u = await User.create({ name, email, password, role: 'admin' });
    await audit(req, 'admin.create', String(u._id), { email });
    res.status(201).json({ user: u });
  })
);

/* ---------- A-06 Configuration ---------- */
router.get('/categories', asyncHandler(async (req, res) => res.json({ categories: await ServiceCategory.find().sort('name') })));

router.post(
  '/categories',
  asyncHandler(async (req, res) => {
    const { name, basePrice, instantBook, requiredEquipment, icon, description } = req.body;
    if (!name) throw new ApiError(400, 'Name is required');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const c = await ServiceCategory.create({ name, slug, basePrice, instantBook, requiredEquipment, icon, description });
    await audit(req, 'category.create', slug);
    res.status(201).json({ category: c });
  })
);

router.put(
  '/categories/:id',
  asyncHandler(async (req, res) => {
    const c = await ServiceCategory.findById(req.params.id);
    if (!c) throw new ApiError(404, 'Category not found');
    ['name', 'basePrice', 'instantBook', 'requiredEquipment', 'icon', 'description', 'active'].forEach((k) => req.body[k] !== undefined && (c[k] = req.body[k]));
    await c.save();
    await audit(req, 'category.update', c.slug, req.body);
    res.json({ category: c });
  })
);

router.get('/settings', asyncHandler(async (req, res) => res.json({ settings: await getSettings() })));
router.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const { platformFeeRate, taxRate, leadLimit, ownerFeeRate, supplierIntegrationEnabled } = req.body;
    if (ownerFeeRate !== undefined) {
      if (ownerFeeRate < 0.05 || ownerFeeRate > 0.1) throw new ApiError(400, 'The owner booking fee must be between 5% and 10%');
      s.ownerFeeRate = ownerFeeRate;
    }
    if (supplierIntegrationEnabled !== undefined) s.supplierIntegrationEnabled = !!supplierIntegrationEnabled;
    if (platformFeeRate !== undefined) {
      if (platformFeeRate < 0 || platformFeeRate > 0.5) throw new ApiError(400, 'Fee must be between 0% and 50%');
      s.platformFeeRate = platformFeeRate;
    }
    if (taxRate !== undefined) {
      if (taxRate < 0 || taxRate > 0.5) throw new ApiError(400, 'Tax must be between 0% and 50%');
      s.taxRate = taxRate;
    }
    if (leadLimit !== undefined) s.leadLimit = Math.max(1, Math.min(50, Number(leadLimit)));
    await s.save();
    await audit(req, 'settings.update', 'platform', req.body);
    res.json({ settings: s });
  })
);

/* ---------- A-07 Audit ---------- */
router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 25;
    const [logs, total] = await Promise.all([
      AuditLog.find().populate('actor', 'name role').sort('-createdAt').skip((page - 1) * limit).limit(limit),
      AuditLog.countDocuments(),
    ]);
    res.json({ logs, page, pages: Math.ceil(total / limit), total });
  })
);

module.exports = router;