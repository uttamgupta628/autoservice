const router = require('express').Router();
const { Job, Vehicle, ServiceCategory, MechanicProfile, Payment, Review } = require('../models');
const { asyncHandler, ApiError, protect, requireRole } = require('../middleware');
const { findMatches, checkEligibility, distanceKm } = require('../services/matching');
const { reserveSlots, releaseSlots } = require('../services/slots');
const { getSettings, notify, round2, maskLocation } = require('../services/helpers');

router.use(protect);

const OWNER_POP = [
  { path: 'vehicle', select: 'make model year plate photo' },
  { path: 'mechanic', select: 'name avatar phone' },
];
const addHistory = (job, status, by, note) => job.history.push({ status, by, note });
const isMine = (job, user) => String(job.owner) === String(user._id) || String(job.mechanic) === String(user._id);

/* ============ create (owner) ============ */
router.post(
  '/',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { vehicleId, category, services, description, media, mechanicId, scheduledAt, location, durationMins } = req.body;
    const vehicle = await Vehicle.findOne({ _id: vehicleId, owner: req.user._id });
    if (!vehicle) throw new ApiError(400, 'Choose one of your vehicles');
    const when = new Date(scheduledAt);
    if (isNaN(when) || when < new Date()) throw new ApiError(400, 'Choose a future date and time');
    const coords = location?.lat !== undefined && location?.lng !== undefined ? [Number(location.lng), Number(location.lat)] : null;
    if (!coords || !location?.address) throw new ApiError(400, 'A service location is required');
    const base = {
      owner: req.user._id,
      vehicle: vehicle._id,
      scheduledAt: when,
      durationMins: durationMins || 120,
      location: { address: location.address, city: location.city, coordinates: coords },
      media: media || [],
      description,
    };

    /* ---- instant booking with a chosen mechanic ---- */
    if (mechanicId) {
      const slugs = Array.isArray(services) && services.length ? services : category ? [category] : [];
      if (!slugs.length) throw new ApiError(400, 'Select at least one service');
      const profile = await MechanicProfile.findOne({ user: mechanicId });
      if (!profile) throw new ApiError(404, 'Mechanic not found');
      const cats = await ServiceCategory.find({ slug: { $in: slugs }, active: true });
      if (cats.length !== slugs.length) throw new ApiError(400, 'Unknown service selected');
      const items = [];
      for (const c of cats) {
        const offered = profile.services.find((s) => s.category === c.slug && s.enabled);
        if (!offered) throw new ApiError(400, `${profile.shopName || 'This mechanic'} does not offer ${c.name}`);
        if (!c.instantBook) throw new ApiError(400, `${c.name} needs a quote, use "Request quotes"`);
        items.push({ category: c.slug, name: c.name, price: offered.price ?? c.basePrice });
      }
      for (const c of cats) {
        const r = await checkEligibility(profile, { category: c.slug, coordinates: coords, scheduledAt: when, durationMins: base.durationMins }, c);
        if (!r.ok) throw new ApiError(409, r.reason);
      }
      const job = new Job({
        ...base, type: 'instant', category: items[0].category, services: items, mechanic: mechanicId,
        price: round2(items.reduce((a, s) => a + s.price, 0)), status: 'booked',
      });
      if (!(await reserveSlots(mechanicId, when, base.durationMins, job._id))) throw new ApiError(409, 'That slot was just taken, pick another time');
      addHistory(job, 'booked', req.user._id, 'Instant booking');
      await job.save();
      await Payment.create({ job: job._id, owner: req.user._id, mechanic: mechanicId, amount: job.price }); // authorization
      notify(mechanicId, 'New booking', `${req.user.name} booked ${items.map((s) => s.name).join(', ')}`, 'booking', job._id);
      return res.status(201).json({ job });
    }

    /* ---- open repair request, matched to eligible mechanics ---- */
    if (!category) throw new ApiError(400, 'Choose a service category');
    if (!description || description.trim().length < 5) throw new ApiError(400, 'Describe the issue');
    const cat = await ServiceCategory.findOne({ slug: category, active: true });
    if (!cat) throw new ApiError(400, 'Unknown service category');
    const settings = await getSettings();
    const matches = await findMatches({ category, vehicleMake: vehicle.make, coordinates: coords, scheduledAt: when, durationMins: base.durationMins }, settings.leadLimit);
    const job = await Job.create({
      ...base, type: 'request', category, services: [{ category, name: cat.name, price: 0 }], status: 'requested',
      matchedMechanics: matches.map((m) => m.profile.user._id),
      history: [{ status: 'requested', by: req.user._id }],
    });
    matches.forEach((m) => notify(m.profile.user._id, 'New job lead', `${cat.name} near ${location.city || 'you'} (${m.distanceKm} km)`, 'lead', job._id));
    res.status(201).json({ job, matchedCount: matches.length });
  })
);

/* ============ lists ============ */
router.get(
  '/mine',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const open = ['requested', 'quoted', 'booked', 'in_progress'];
    const filter = { owner: req.user._id };
    if (req.query.bucket === 'upcoming') filter.status = { $in: open };
    if (req.query.bucket === 'past') filter.status = { $in: ['completed', 'cancelled'] };
    const jobs = await Job.find(filter).populate(OWNER_POP).sort('-createdAt').limit(100);
    res.json({ jobs });
  })
);

router.get(
  '/requests', // mechanic: leads matched to me
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const profile = await MechanicProfile.findOne({ user: req.user._id });
    if (profile.verificationStatus !== 'verified') return res.json({ jobs: [], notVerified: true });
        // Leads are first matched when posted. A mechanic who was verified / set up afterwards should still see
    // open requests they qualify for, so check the open ones against this mechanic now.
    const open = await Job.find({
      type: 'request', status: { $in: ['requested', 'quoted'] }, scheduledAt: { $gt: new Date() },
      matchedMechanics: { $ne: req.user._id }, declinedBy: { $ne: req.user._id },
    }).populate('vehicle', 'make').limit(50);
    for (const j of open) {
      const cat = await ServiceCategory.findOne({ slug: j.category, active: true });
      if (!cat) continue;
      const ctx = { category: j.category, vehicleMake: j.vehicle?.make, coordinates: j.location.coordinates, scheduledAt: j.scheduledAt, durationMins: j.durationMins || cat.durationMins || 60 };
      const r = await checkEligibility(profile, ctx, cat);
      if (r.ok) await Job.updateOne({ _id: j._id }, { $addToSet: { matchedMechanics: req.user._id } });
    }
    const jobs = await Job.find({
      matchedMechanics: req.user._id,
      declinedBy: { $ne: req.user._id },
      status: { $in: ['requested', 'quoted'] },
      scheduledAt: { $gt: new Date() },
    }).populate('vehicle', 'make model year').populate('owner', 'name').sort('-createdAt');
    const out = jobs.map((j) => {
      const o = maskLocation(j);
      o.distanceKm = Math.round(distanceKm(profile.location.coordinates, j.location.coordinates) * 10) / 10;
      o.myQuote = j.quotes.find((q) => String(q.mechanic) === String(req.user._id)) || null;
      o.quotes = undefined; // never leak competitors' quotes
      delete o.owner.email;
      return o;
    });
    res.json({ jobs: out });
  })
);

router.get(
  '/assigned', // mechanic: my booked / active / completed jobs
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const filter = { mechanic: req.user._id };
    if (req.query.bucket === 'active') filter.status = { $in: ['booked', 'in_progress'] };
    if (req.query.bucket === 'past') filter.status = { $in: ['completed', 'cancelled'] };
    const jobs = await Job.find(filter).populate('vehicle', 'make model year plate').populate('owner', 'name phone').sort('scheduledAt').limit(100);
    res.json({ jobs });
  })
);

router.get(
  '/my-quotes', // mechanic: quotes I submitted
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const jobs = await Job.find({ 'quotes.mechanic': req.user._id }).populate('vehicle', 'make model year').sort('-updatedAt').limit(100);
    res.json({ jobs: jobs.map((j) => ({ ...maskLocation(j), quotes: j.quotes.filter((q) => String(q.mechanic) === String(req.user._id)) })) });
  })
);

/* ============ detail ============ */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = await Job.findById(req.params.id)
      .populate('vehicle', 'make model year plate vin photo mileage')
      .populate('owner', 'name phone avatar')
      .populate('mechanic', 'name phone avatar')
      .populate('quotes.mechanic', 'name avatar');
    if (!job) throw new ApiError(404, 'Job not found');
    const me = String(req.user._id);
    const isOwner = String(job.owner._id) === me;
    const isAssigned = job.mechanic && String(job.mechanic._id) === me;
    const isMatched = job.matchedMechanics.map(String).includes(me);
    if (req.user.role !== 'admin' && !isOwner && !isAssigned && !isMatched) throw new ApiError(403, 'Not your job');
    let out = job.toObject();
    if (!isOwner && req.user.role !== 'admin') {
      out = maskLocation(job);
      if (!isAssigned) {
        out.quotes = out.quotes.filter((q) => String(q.mechanic._id || q.mechanic) === me); // competing quotes are private
        out.owner = { name: job.owner.name };
      }
    }
    const payment = await Payment.findOne({ job: job._id }).select('amount platformFee payout status payoutStatus');
    const review = await Review.findOne({ job: job._id }).select('rating comment');
    res.json({ job: out, review, payment: isOwner || isAssigned || req.user.role === 'admin' ? payment : undefined });
  })
);

/* ============ mechanic: decline / quote ============ */
router.post(
  '/:id/decline',
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, matchedMechanics: req.user._id, status: { $in: ['requested', 'quoted'] } });
    if (!job) throw new ApiError(404, 'Job not found');
    if (!job.declinedBy.includes(req.user._id)) job.declinedBy.push(req.user._id);
    await job.save();
    res.json({ message: 'Declined' });
  })
);

router.post(
  '/:id/quotes',
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, matchedMechanics: req.user._id, status: { $in: ['requested', 'quoted'] } });
    if (!job) throw new ApiError(404, 'This job is no longer open to you');
    const profile = await MechanicProfile.findOne({ user: req.user._id });
    if (profile.verificationStatus !== 'verified') throw new ApiError(403, 'Complete verification before quoting');
    const labor = Number(req.body.labor) || 0, parts = Number(req.body.parts) || 0, travel = Number(req.body.travel) || 0;
    if (labor <= 0) throw new ApiError(400, 'Labor charge must be greater than 0');
    if ([labor, parts, travel].some((n) => n < 0)) throw new ApiError(400, 'Amounts cannot be negative');
    const { taxRate } = await getSettings();
    // totals are always calculated on the server
    const subtotal = labor + parts + travel;
    const tax = round2(subtotal * taxRate);
    const total = round2(subtotal + tax);
    const existing = job.quotes.find((q) => String(q.mechanic) === String(req.user._id));
    const data = { labor, parts, travel, tax, total, note: req.body.note, status: 'pending', validUntil: new Date(Date.now() + (Number(req.body.validHours) || 48) * 3600000) };
    if (existing) {
      if (existing.status !== 'pending') throw new ApiError(400, 'This quote can no longer be revised');
      Object.assign(existing, data, { version: existing.version + 1 });
    } else job.quotes.push({ mechanic: req.user._id, ...data });
    job.status = 'quoted';
    addHistory(job, 'quoted', req.user._id, existing ? 'Quote revised' : 'Quote submitted');
    await job.save();
    notify(job.owner, 'New quote received', `${req.user.name} quoted ₹${total}`, 'quote', job._id);
    res.status(201).json({ quote: job.quotes.find((q) => String(q.mechanic) === String(req.user._id)) });
  })
);

/* ============ owner: accept a quote ============ */
router.post(
  '/:id/quotes/:quoteId/accept',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, owner: req.user._id });
    if (!job || !['requested', 'quoted'].includes(job.status)) throw new ApiError(400, 'This request can no longer accept a quote');
    const quote = job.quotes.id(req.params.quoteId);
    if (!quote || quote.status !== 'pending') throw new ApiError(404, 'Quote not found');
    if (quote.validUntil && quote.validUntil < new Date()) throw new ApiError(400, 'This quote has expired, ask for a new one');
    if (job.scheduledAt < new Date()) throw new ApiError(400, 'The preferred time has passed, post a new request');
    const profile = await MechanicProfile.findOne({ user: quote.mechanic });
    if (!profile || profile.verificationStatus !== 'verified') throw new ApiError(400, 'This mechanic is no longer available');
    if (!(await reserveSlots(quote.mechanic, job.scheduledAt, job.durationMins, job._id))) throw new ApiError(409, 'That mechanic just got booked for this time');
    job.quotes.forEach((q) => (q.status = String(q._id) === String(quote._id) ? 'accepted' : 'rejected'));
    job.mechanic = quote.mechanic;
    job.price = quote.total;
    job.status = 'booked';
    addHistory(job, 'booked', req.user._id, 'Quote accepted');
    await job.save();
    await Payment.create({ job: job._id, owner: job.owner, mechanic: job.mechanic, amount: job.price });
    notify(job.mechanic, 'Quote accepted', `${req.user.name} accepted your quote of ₹${quote.total}`, 'booking', job._id);
    job.quotes.filter((q) => q.status === 'rejected').forEach((q) => notify(q.mechanic, 'Quote not selected', 'The customer chose another mechanic', 'quote', job._id));
    res.json({ job });
  })
);

/* ============ cancel ============ */
router.post(
  '/:id/cancel',
  requireRole('owner', 'mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findById(req.params.id);
    if (!job || !isMine(job, req.user)) throw new ApiError(404, 'Job not found');
    if (!['requested', 'quoted', 'booked'].includes(job.status)) throw new ApiError(400, 'This job can no longer be cancelled');
    if (req.user.role === 'mechanic' && job.status !== 'booked') throw new ApiError(400, 'Use decline for open requests');
    job.status = 'cancelled';
    job.cancelledBy = req.user._id;
    job.cancelReason = req.body.reason;
    addHistory(job, 'cancelled', req.user._id, req.body.reason);
    await job.save();
    await releaseSlots(job._id);
    await Payment.findOneAndUpdate({ job: job._id, status: 'authorized' }, { status: 'voided' });
    if (job.mechanic) {
      if (req.user.role === 'mechanic') await MechanicProfile.updateOne({ user: req.user._id }, { $inc: { cancelledJobs: 1 } });
      notify(req.user.role === 'owner' ? job.mechanic : job.owner, 'Booking cancelled', req.body.reason || 'The booking was cancelled', 'booking', job._id);
    }
    res.json({ job });
  })
);

/* ============ mechanic: status (check in / complete) ============ */
router.post(
  '/:id/status',
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, mechanic: req.user._id });
    if (!job) throw new ApiError(404, 'Job not found');
    const { status } = req.body;
    const allowed = { booked: 'in_progress', in_progress: 'completed' };
    if (allowed[job.status] !== status) throw new ApiError(400, `Cannot move a ${job.status.replace('_', ' ')} job to ${status}`);
    if (status === 'completed') {
      if (job.changeOrders.some((c) => c.status === 'pending')) throw new ApiError(400, 'Waiting for customer approval of additional work');
      const extra = job.changeOrders.filter((c) => c.status === 'approved').reduce((a, c) => a + c.amount, 0);
      job.price = round2(job.price + extra);
      const { platformFeeRate } = await getSettings();
      const fee = round2(job.price * platformFeeRate);
      // capture (idempotent: only an authorized payment can be captured, once)
      await Payment.findOneAndUpdate(
        { job: job._id, status: 'authorized' },
        { amount: job.price, platformFee: fee, payout: round2(job.price - fee), status: 'captured', payoutStatus: 'pending', capturedAt: new Date() }
      );
      await MechanicProfile.updateOne({ user: req.user._id }, { $inc: { completedJobs: 1 } });
    }
    job.status = status;
    addHistory(job, status, req.user._id, req.body.note);
    await job.save();
    notify(job.owner, status === 'completed' ? 'Job completed' : 'Mechanic checked in', status === 'completed' ? 'Please review the invoice and rate the service' : `${req.user.name} has started your job`, 'job', job._id);
    res.json({ job });
  })
);

/* ============ change orders (extra work needs explicit approval) ============ */
router.post(
  '/:id/change-orders',
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, mechanic: req.user._id, status: 'in_progress' });
    if (!job) throw new ApiError(400, 'Additional work can only be requested on a job in progress');
    const amount = Number(req.body.amount);
    if (!req.body.description || !(amount > 0)) throw new ApiError(400, 'Describe the extra work and give an amount');
    job.changeOrders.push({ description: req.body.description, amount });
    await job.save();
    notify(job.owner, 'Approval needed', `Extra work: ${req.body.description} (₹${amount})`, 'approval', job._id);
    res.status(201).json({ job });
  })
);

router.post(
  '/:id/change-orders/:coId/respond',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, owner: req.user._id });
    const co = job?.changeOrders.id(req.params.coId);
    if (!co || co.status !== 'pending') throw new ApiError(404, 'Request not found');
    co.status = req.body.approve ? 'approved' : 'rejected';
    await job.save();
    notify(job.mechanic, 'Extra work ' + co.status, co.description, 'approval', job._id);
    res.json({ job });
  })
);

module.exports = router;
