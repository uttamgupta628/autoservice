const router = require('express').Router();
const { Job, Vehicle, ServiceCategory, MechanicProfile, Payment, Review } = require('../models');
const { asyncHandler, ApiError, protect, requireRole } = require('../middleware');
const { findMatches, checkEligibility, distanceKm } = require('../services/matching');
const { reserveSlots, releaseSlots } = require('../services/slots');
const { getSettings, notify, round2, maskLocation, computeFees } = require('../services/helpers');
const diag = require('../services/diagnostics');

router.use(protect);

const OWNER_POP = [
  { path: 'vehicle', select: 'make model year plate photo' },
  { path: 'mechanic', select: 'name avatar phone' },
];
const addHistory = (job, status, by, note) => job.history.push({ status, by, note });
const isMine = (job, user) => String(job.owner) === String(user._id) || String(job.mechanic) === String(user._id);

/* ---------- customer-supplied parts ---------- */
const PART_SOURCES = ['mechanic', 'customer', 'supplier_pickup', 'ship_to_customer'];
const OWNER_SUPPLIES = ['customer', 'ship_to_customer']; // the quote carries no parts charge in these cases
const NEEDS_PARTS_READY = ['customer', 'ship_to_customer', 'supplier_pickup'];
const CLASS_LABEL = Object.fromEntries(Object.entries(diag.CLASSES).map(([k, v]) => [k, v.label]));

/** Validates what the owner entered and returns the parts block to store. Confirmation is mandatory. */
function buildParts(input, settings) {
  const source = input?.source || 'mechanic';
  if (!PART_SOURCES.includes(source)) throw new ApiError(400, 'Unknown parts option');
  if (source === 'mechanic') return { source: 'mechanic', items: [], customerConfirmed: false, ready: false };
  if (['supplier_pickup', 'ship_to_customer'].includes(source) && !settings.supplierIntegrationEnabled) {
    throw new ApiError(400, 'This parts option is not available yet');
  }
  const items = (Array.isArray(input.items) ? input.items : []).map((i) => ({
    name: String(i.name || '').trim().slice(0, 120),
    partNumber: String(i.partNumber || '').trim().slice(0, 60),
    brand: String(i.brand || '').trim().slice(0, 60),
    quantity: Math.max(1, Math.min(20, parseInt(i.quantity, 10) || 1)),
    condition: ['new', 'used', 'refurbished'].includes(i.condition) ? i.condition : 'new',
    notes: String(i.notes || '').trim().slice(0, 300),
    photos: (Array.isArray(i.photos) ? i.photos : []).filter((p) => p?.url).slice(0, 4).map((p) => ({ url: p.url, publicId: p.publicId })),
  }));
  if (!items.length) throw new ApiError(400, 'Add at least one part');
  if (items.some((i) => !i.name)) throw new ApiError(400, 'Every part needs a name');
  if (!input.confirmed) throw new ApiError(400, 'Confirm the part details before checkout');
  return {
    source, items, customerConfirmed: true, confirmedAt: new Date(), ready: false,
    inspection: { status: 'pending' },
    fulfillment: { status: source === 'supplier_pickup' ? 'awaiting_pickup' : 'none' },
  };
}

/** Authorizes the owner's payment with the fee split fixed at booking time. */
async function authorizePayment(job) {
  const f = computeFees(job.price, await getSettings());
  return Payment.create({
    job: job._id, owner: job.owner, mechanic: job.mechanic, amount: job.price,
    ownerFee: f.ownerFee, mechanicFee: f.mechanicFee, ownerFeeRate: f.ownerFeeRate, mechanicFeeRate: f.mechanicFeeRate,
    platformFee: f.platformFee, totalCharged: f.totalCharged,
  });
}

/* ============ create (owner) ============ */
router.post(
  '/',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const { vehicleId, category, services, description, media, mechanicId, scheduledAt, location, durationMins, diagnosis, parts } = req.body;
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
      const settingsNow = await getSettings();
      const job = new Job({
        ...base, type: 'instant', category: items[0].category, services: items, mechanic: mechanicId,
        price: round2(items.reduce((a, s) => a + s.price, 0)), status: 'booked', parts: buildParts(parts, settingsNow),
      });
      if (!(await reserveSlots(mechanicId, when, base.durationMins, job._id))) throw new ApiError(409, 'That slot was just taken, pick another time');
      addHistory(job, 'booked', req.user._id, 'Instant booking');
      await job.save();
      await authorizePayment(job);
      notify(mechanicId, 'New booking', `${req.user.name} booked ${items.map((s) => s.name).join(', ')}${job.parts.source === 'customer' ? ' (customer supplies the parts)' : ''}`, 'booking', job._id);
      return res.status(201).json({ job, fees: computeFees(job.price, settingsNow) });
    }

    /* ---- open repair request, matched to eligible mechanics ---- */
    const settings = await getSettings();
    const partsBlock = buildParts(parts, settings);
    let reqCategory = category;
    let reqDescription = description;
    let diagnosisDoc;
    if (diagnosis?.symptomId) {
      // the report is always recomputed on the server, so a tampered app cannot change the classification
      const ev = diag.evaluate({ symptomId: diagnosis.symptomId, areaId: diagnosis.areaId, answers: diagnosis.answers });
      if (ev.safety.level === 'urgent' && !diagnosis.acknowledgeSafety) throw new ApiError(400, 'Please confirm you have read the safety warning');
      reqCategory = ev.service;
      const note = String(diagnosis.ownerNote || description || '').trim().slice(0, 500);
      diagnosisDoc = {
        areaId: ev.area?.id, areaLabel: ev.area?.label,
        symptomId: ev.symptom.id, symptomLabel: ev.symptom.label, symptomCategory: ev.symptom.category,
        answers: ev.answers, causes: ev.causes, safety: ev.safety,
        classification: ev.classification, classificationReason: ev.classificationReason, serviceName: ev.serviceName,
        summary: ev.summary, ownerNote: note, generatedAt: new Date(),
      };
      reqDescription = note ? `${ev.summary}\nOwner note: ${note}` : ev.summary;
    } else {
      if (!category) throw new ApiError(400, 'Choose a service category');
      if (!description || description.trim().length < 5) throw new ApiError(400, 'Describe the issue');
    }
    const cat = await ServiceCategory.findOne({ slug: reqCategory, active: true });
    if (!cat) throw new ApiError(400, 'Unknown service category');
    const matches = await findMatches({ category: reqCategory, vehicleMake: vehicle.make, coordinates: coords, scheduledAt: when, durationMins: base.durationMins }, settings.leadLimit);
    const urgent = diagnosisDoc?.safety?.level === 'urgent';
    const job = await Job.create({
      ...base, description: reqDescription, type: 'request', category: reqCategory,
      services: [{ category: reqCategory, name: diagnosisDoc?.serviceName || cat.name, price: 0 }], status: 'requested',
      diagnosis: diagnosisDoc, parts: partsBlock,
      matchedMechanics: matches.map((m) => m.profile.user._id),
      history: [{ status: 'requested', by: req.user._id, note: diagnosisDoc ? `Generated from symptom report: ${diagnosisDoc.symptomLabel}` : undefined }],
    });
    matches.forEach((m) => notify(
      m.profile.user._id, urgent ? 'URGENT job lead' : 'New job lead',
      `${diagnosisDoc ? `${diagnosisDoc.serviceName} (${CLASS_LABEL[diagnosisDoc.classification]})` : cat.name} near ${location.city || 'you'} (${m.distanceKm} km)`, 'lead', job._id
    ));
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
      o.classificationFlags = (o.classificationFlags || []).filter((f) => String(f.mechanic) === String(req.user._id));
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
      .populate('quotes.mechanic', 'name avatar')
      .populate('classificationFlags.mechanic', 'name');
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
      // a mechanic only sees their own classification flags
      out.classificationFlags = (out.classificationFlags || []).filter((f) => String(f.mechanic?._id || f.mechanic) === me);
    }
    const payment = await Payment.findOne({ job: job._id }).select('amount ownerFee mechanicFee ownerFeeRate mechanicFeeRate totalCharged platformFee payout status payoutStatus');
    const settings = await getSettings();
    const feeRates = payment?.ownerFeeRate != null ? { ownerFeeRate: payment.ownerFeeRate, platformFeeRate: payment.mechanicFeeRate } : settings;
    const fees = job.price > 0 ? computeFees(job.price, feeRates) : null;
    const rates = computeFees(0, feeRates); // owner booking fee % and mechanic sourcing fee % that apply to this job
    const review = await Review.findOne({ job: job._id }).select('rating comment');
    res.json({ job: out, review, supplierEnabled: !!settings.supplierIntegrationEnabled, rates: { owner: rates.ownerFeeRate, mechanic: rates.mechanicFeeRate }, fees: isOwner || isAssigned || req.user.role === 'admin' ? fees : undefined, payment: isOwner || isAssigned || req.user.role === 'admin' ? payment : undefined });
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
    const labor = Number(req.body.labor) || 0, travel = Number(req.body.travel) || 0;
    // when the customer brings the parts, the quote cannot include a parts charge
    const parts = OWNER_SUPPLIES.includes(job.parts?.source) ? 0 : Number(req.body.parts) || 0;
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
    // part confirmation happens at checkout: the owner re-confirms the parts they will supply
    if (job.parts?.source && job.parts.source !== 'mechanic' && !req.body.confirmParts) throw new ApiError(400, 'Confirm your parts before checkout');
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
    await authorizePayment(job);
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
    if (status === 'in_progress' && NEEDS_PARTS_READY.includes(job.parts?.source)) {
      if (!job.parts.ready) throw new ApiError(400, 'The customer has not confirmed that the parts are ready yet');
      if (job.parts.inspection?.status === 'mismatch') throw new ApiError(400, 'You reported a parts mismatch. Wait for the customer to update the parts');
    }
    if (status === 'completed') {
      if (job.changeOrders.some((c) => c.status === 'pending')) throw new ApiError(400, 'Waiting for customer approval of additional work');
      const extra = job.changeOrders.filter((c) => c.status === 'approved').reduce((a, c) => a + c.amount, 0);
      job.price = round2(job.price + extra);
      const settings = await getSettings();
      const auth = await Payment.findOne({ job: job._id, status: 'authorized' });
      // fee rates are fixed when the booking is made, later policy changes do not touch it
      const f = computeFees(job.price, { ownerFeeRate: auth?.ownerFeeRate ?? settings.ownerFeeRate, platformFeeRate: auth?.mechanicFeeRate ?? settings.platformFeeRate });
      // capture (idempotent: only an authorized payment can be captured, once)
      await Payment.findOneAndUpdate(
        { job: job._id, status: 'authorized' },
        { amount: job.price, ownerFee: f.ownerFee, mechanicFee: f.mechanicFee, ownerFeeRate: f.ownerFeeRate, mechanicFeeRate: f.mechanicFeeRate, platformFee: f.platformFee, totalCharged: f.totalCharged, payout: f.payout, status: 'captured', payoutStatus: 'pending', capturedAt: new Date() }
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

/* ============ customer-supplied parts (owner edits, mechanic inspects) ============ */
router.put(
  '/:id/parts',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, owner: req.user._id });
    if (!job || !['requested', 'quoted', 'booked'].includes(job.status)) throw new ApiError(400, 'Parts can only be changed before the job starts');
    job.parts = buildParts(req.body, await getSettings()); // resets readiness and inspection, and needs confirmation again
    addHistory(job, job.status, req.user._id, job.parts.source === 'mechanic' ? 'Parts: mechanic will supply' : 'Parts details updated and confirmed');
    await job.save();
    if (job.mechanic) notify(job.mechanic, 'Parts updated', 'The customer changed the parts for this job', 'booking', job._id);
    res.json({ job });
  })
);

router.post(
  '/:id/parts/ready',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, owner: req.user._id });
    if (!job || !['booked', 'in_progress'].includes(job.status)) throw new ApiError(400, 'Mark parts ready once the job is booked');
    if (!NEEDS_PARTS_READY.includes(job.parts?.source)) throw new ApiError(400, 'This job has no customer parts');
    if (!job.parts.customerConfirmed) throw new ApiError(400, 'Confirm the part details first');
    const ready = req.body.ready !== false;
    job.parts.ready = ready;
    job.parts.readyAt = ready ? new Date() : undefined;
    job.parts.readyNote = String(req.body.note || '').slice(0, 300);
    addHistory(job, job.status, req.user._id, ready ? 'Customer confirmed parts are ready' : 'Customer marked parts as not ready');
    await job.save();
    if (job.mechanic) notify(job.mechanic, ready ? 'Parts are ready' : 'Parts not ready', job.parts.readyNote || (ready ? 'The customer confirmed the parts are ready' : 'The customer says the parts are not ready yet'), 'booking', job._id);
    res.json({ job });
  })
);

router.post(
  '/:id/parts/inspect',
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, mechanic: req.user._id, status: { $in: ['booked', 'in_progress'] } });
    if (!job) throw new ApiError(404, 'Job not found');
    if (!OWNER_SUPPLIES.includes(job.parts?.source) && job.parts?.source !== 'supplier_pickup') throw new ApiError(400, 'This job has no customer parts');
    const { status, note } = req.body;
    if (!['ok', 'mismatch'].includes(status)) throw new ApiError(400, 'Choose ok or mismatch');
    if (status === 'mismatch' && !String(note || '').trim()) throw new ApiError(400, 'Explain what does not match');
    job.parts.inspection = { status, note: String(note || '').slice(0, 300), at: new Date() };
    if (status === 'mismatch') job.parts.ready = false;
    addHistory(job, job.status, req.user._id, status === 'ok' ? 'Mechanic checked the parts: OK' : `Parts mismatch: ${note}`);
    await job.save();
    notify(job.owner, status === 'ok' ? 'Parts checked' : 'Parts do not match', status === 'ok' ? 'Your mechanic confirmed the parts look right' : note, 'booking', job._id);
    res.json({ job });
  })
);

/** Milestone 2 (only when supplier integration is switched on): mechanic pick-up from a supplier, or parts shipped to the customer. */
router.post(
  '/:id/parts/fulfillment',
  asyncHandler(async (req, res) => {
    const job = await Job.findById(req.params.id);
    if (!job || !isMine(job, req.user) || !['booked', 'in_progress'].includes(job.status)) throw new ApiError(404, 'Job not found');
    const { status, tracking } = req.body;
    const src = job.parts?.source;
    const mechanicTurn = req.user.role === 'mechanic' && src === 'supplier_pickup' && status === 'picked_up';
    const ownerTurn = req.user.role === 'owner' && src === 'ship_to_customer' && ['shipped', 'delivered'].includes(status);
    if (!mechanicTurn && !ownerTurn) throw new ApiError(400, 'That update is not available for this parts option');
    job.parts.fulfillment = { status, tracking: String(tracking || '').slice(0, 120), at: new Date() };
    if (status === 'picked_up' || status === 'delivered') {
      job.parts.ready = true;
      job.parts.readyAt = new Date();
    }
    addHistory(job, job.status, req.user._id, `Parts ${status.replace('_', ' ')}`);
    await job.save();
    notify(req.user.role === 'owner' ? job.mechanic : job.owner, 'Parts update', `Parts ${status.replace('_', ' ')}`, 'booking', job._id);
    res.json({ job });
  })
);

/* ============ classification review (mechanic can flag, owner decides) ============ */
router.post(
  '/:id/flag-classification',
  requireRole('mechanic'),
  asyncHandler(async (req, res) => {
    const job = await Job.findById(req.params.id).populate('owner', 'name');
    const me = String(req.user._id);
    const allowed = job && (job.mechanic?.toString() === me || (job.matchedMechanics.map(String).includes(me) && ['requested', 'quoted'].includes(job.status)));
    if (!allowed) throw new ApiError(404, 'Job not found');
    const current = job.diagnosis?.classification;
    if (!current) throw new ApiError(400, 'This job was not created from a symptom report');
    const { recommended, note } = req.body;
    if (!diag.CLASSES[recommended]) throw new ApiError(400, 'Choose diagnostic, repair or installation');
    if (recommended === current) throw new ApiError(400, `The job is already classified as ${CLASS_LABEL[current]}`);
    if (!note || note.trim().length < 5) throw new ApiError(400, 'Tell the customer why you recommend this');
    job.classificationFlags = job.classificationFlags.filter((f) => !(String(f.mechanic) === me && f.status === 'open'));
    job.classificationFlags.push({ mechanic: req.user._id, recommended, note: note.trim().slice(0, 400) });
    addHistory(job, job.status, req.user._id, `Mechanic flagged classification: recommends ${CLASS_LABEL[recommended]}`);
    await job.save();
    notify(job.owner._id, 'Mechanic suggests a change', `${req.user.name} recommends ${CLASS_LABEL[recommended]} instead of ${CLASS_LABEL[current]}`, 'approval', job._id);
    res.status(201).json({ flags: job.classificationFlags.filter((f) => String(f.mechanic) === me) });
  })
);

router.post(
  '/:id/classification/respond',
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, owner: req.user._id });
    const flag = job?.classificationFlags.id(req.body.flagId);
    if (!flag || flag.status !== 'open') throw new ApiError(404, 'Suggestion not found');
    if (!['requested', 'quoted', 'booked'].includes(job.status)) throw new ApiError(400, 'This job can no longer change');
    if (req.body.accept) {
      job.diagnosis.classification = flag.recommended;
      job.diagnosis.serviceName = diag.nameFor(job.diagnosis.symptomId, flag.recommended);
      job.diagnosis.classificationReason = `Changed to ${CLASS_LABEL[flag.recommended]} after a mechanic's review: ${flag.note}`;
      if (job.services?.[0]) job.services[0].name = job.diagnosis.serviceName;
      flag.status = 'accepted';
      job.classificationFlags.forEach((f) => { if (f.status === 'open' && f.recommended !== flag.recommended) f.status = 'dismissed'; });
      addHistory(job, job.status, req.user._id, `Classification changed to ${CLASS_LABEL[flag.recommended]}`);
    } else {
      flag.status = 'dismissed';
      addHistory(job, job.status, req.user._id, 'Customer kept the original classification');
    }
    await job.save();
    notify(flag.mechanic, req.body.accept ? 'Suggestion accepted' : 'Suggestion declined', req.body.accept ? `The job is now a ${CLASS_LABEL[flag.recommended]}. Please review your quote.` : 'The customer kept the original classification', 'approval', job._id);
    res.json({ job });
  })
);

module.exports = router;