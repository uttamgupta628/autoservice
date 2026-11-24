/**
 * End-to-end API check. Needs the API running (npm start) against a seeded DB (npm run seed).
 *   API=http://localhost:5000/api npm run test:flow
 */
const API = process.env.API || 'http://localhost:5000/api';
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { cond ? pass++ : fail++; console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${!cond && extra ? '  -> ' + JSON.stringify(extra) : ''}`); };

async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch {}
  return { status: res.status, ...data };
}
const login = async (identifier, password = 'Password@123') => (await call('POST', '/auth/login', null, { identifier, password })).token;
// each run uses its own future day, so earlier runs' bookings never collide with this one
const DAY = 2 + Math.floor(Math.random() * 3000);
const tomorrowAt = (h) => { const d = new Date(Date.now() + DAY * 86400000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };

(async () => {
  const stamp = Date.now();
  const when = tomorrowAt(6); // 11:30 IST, inside seeded working hours (08:00-21:00 IST)
  const loc = { address: '12 MG Road, Bengaluru', city: 'Bengaluru', lat: 12.9757, lng: 77.6011 };

  console.log('Auth');
  const reg = await call('POST', '/auth/register', null, { name: 'Test Owner', email: `o${stamp}@t.test`, phone: `8${String(stamp).slice(-9)}`, password: 'secret12', role: 'owner' });
  ok(reg.status === 201 && reg.token, 'owner registers');
  ok((await call('POST', '/auth/register', null, { name: 'x', email: `o${stamp}@t.test`, password: 'secret12', role: 'owner' })).status === 409, 'duplicate email rejected');
  ok((await call('POST', '/auth/register', null, { name: 'x', email: 'a@b.c', password: 'secret12', role: 'admin' })).status === 400, 'cannot self-register as admin');
  ok((await call('GET', '/vehicles')).status === 401, 'protected routes need a token');
  const owner = reg.token;
  const mech = await call('POST', '/auth/register', null, { name: 'New Mech', email: `m${stamp}@t.test`, password: 'secret12', role: 'mechanic' });
  ok(mech.user?.mechanic?.verificationStatus === 'draft', 'new mechanic starts as draft');

  console.log('Vehicles');
  ok((await call('POST', '/vehicles', owner, { make: 'Hyundai', model: 'i20', year: 2020, vin: 'BAD' })).status === 400, 'invalid VIN rejected');
  const veh = (await call('POST', '/vehicles', owner, { make: 'Hyundai', model: 'i20', year: 2020, plate: 'ka03ab1234' })).vehicle;
  ok(veh?.isDefault && veh.plate === 'KA03AB1234', 'vehicle added, first one is default');

  console.log('Mechanic verification gate');
  const mt = mech.token;
  ok((await call('POST', '/mechanics/me/submit', mt)).status === 400, 'cannot submit without documents');
  await call('PUT', '/mechanics/me/documents', mt, { documents: [{ type: 'id_proof', url: 'https://x/id.jpg' }, { type: 'shop_photo', url: 'https://x/s.jpg' }] });
  await call('PUT', '/mechanics/me/services', mt, { services: [{ category: 'brake-service', price: 950, enabled: true }] });
  await call('PUT', '/mechanics/me/profile', mt, { shopName: 'New Garage', city: 'Bengaluru', serviceRadiusKm: 20, lat: 12.97, lng: 77.59, workingDays: [0, 1, 2, 3, 4, 5, 6], workStart: '08:00', workEnd: '21:00' });
  ok((await call('POST', '/mechanics/me/submit', mt)).profile?.verificationStatus === 'submitted', 'mechanic submits for verification');
  const sched = await call('POST', '/jobs', owner, { vehicleId: veh._id, category: 'brake-service', description: 'Brakes squeal', scheduledAt: when, location: loc });
  ok(!(sched.job?.matchedMechanics || []).some((id) => id === mech.user._id), 'unverified mechanic is NOT matched');

  console.log('Admin approves');
  const admin = await login('admin@autoservice.test', 'Admin@123');
  ok((await call('GET', '/admin/stats', owner)).status === 403, 'owner blocked from admin API');
  const list = await call('GET', '/admin/mechanics?status=pending', admin);
  const prof = list.mechanics.find((m) => String(m.user._id) === mech.user._id);
  ok(!!prof, 'pending mechanic visible to admin');
  ok((await call('POST', `/admin/mechanics/${prof._id}/decision`, admin, { decision: 'reject' })).status === 400, 'rejection needs a reason');
  ok((await call('POST', `/admin/mechanics/${prof._id}/decision`, admin, { decision: 'approve' })).mechanic?.verificationStatus === 'verified', 'admin approves mechanic');

  await call('PUT', '/admin/settings', admin, { leadLimit: 50 }); // each test run adds a verified mechanic; keep the lead cap out of the way
  console.log('Matching (requires category, radius, availability, equipment)');
  const brake = await call('POST', '/jobs', owner, { vehicleId: veh._id, category: 'brake-service', description: 'Brakes squeal when stopping', scheduledAt: when, location: loc });
  ok(brake.status === 201 && brake.matchedCount >= 4, `brake request matched ${brake.matchedCount} mechanics`);
  const ac = await call('POST', '/jobs', owner, { vehicleId: veh._id, category: 'ac-service', description: 'AC not cooling at all', scheduledAt: when, location: loc });
  ok(ac.matchedCount === 2, `AC request only reaches mechanics with the AC gas kit (got ${ac.matchedCount})`);
  const far = await call('POST', '/jobs', owner, { vehicleId: veh._id, category: 'brake-service', description: 'Brakes squeal when stopping', scheduledAt: when, location: { address: 'Delhi', city: 'Delhi', lat: 28.61, lng: 77.2 } });
  ok(far.matchedCount === 0, 'job outside every travel radius matches nobody');
  const night = await call('POST', '/jobs', owner, { vehicleId: veh._id, category: 'brake-service', description: 'Brakes squeal when stopping', scheduledAt: tomorrowAt(20), location: loc });
  ok(night.matchedCount === 0, 'job outside working hours (01:30 IST) matches nobody');
  ok((await call('POST', '/jobs', owner, { vehicleId: veh._id, category: 'brake-service', description: 'x', scheduledAt: '2020-01-01', location: loc })).status === 400, 'past date rejected');

  console.log('Quote flow');
  const ravi = await login('ravi@autoservice.test');
  const prime = await login('prime@autoservice.test');
  const jobId = brake.job._id;
  const leads = await call('GET', '/jobs/requests', ravi);
  const lead = leads.jobs.find((j) => j._id === jobId);
  ok(!!lead && lead.location.approximate && !/MG Road/.test(JSON.stringify(lead.location)), 'mechanic sees only an approximate location');
  ok((await call('POST', `/jobs/${jobId}/quotes`, ravi, { labor: 0 })).status === 400, 'quote needs labor > 0');
  const q1 = await call('POST', `/jobs/${jobId}/quotes`, ravi, { labor: 800, parts: 400, travel: 100, total: 1 });
  ok(q1.quote?.total === 1534 && q1.quote.tax === 234, 'server calculates total (1300 + 18% tax = 1534), ignores client total', q1);
  const q2 = await call('POST', `/jobs/${jobId}/quotes`, prime, { labor: 700, parts: 300 });
  ok(q2.status === 201, 'second mechanic quotes');
  const q1b = await call('POST', `/jobs/${jobId}/quotes`, ravi, { labor: 750, parts: 400, travel: 100 });
  ok(q1b.quote?.version === 2, 'revised quote keeps version history');
  const seenByRavi = await call('GET', `/jobs/${jobId}`, ravi);
  ok(seenByRavi.job.quotes.length === 1, "mechanic can't see competitors' quotes");
  const detail = await call('GET', `/jobs/${jobId}`, owner);
  ok(detail.job.quotes.length === 2, 'owner compares both quotes');
  const stranger = await login('mk@autoservice.test');
  ok((await call('POST', `/jobs/${jobId}/decline`, stranger)).status === 200, 'matched mechanic can decline');
  ok((await call('GET', `/jobs/${jobId}`, (await call('POST', '/auth/register', null, { name: 'Other', email: `x${stamp}@t.test`, password: 'secret12', role: 'owner' })).token)).status === 403, "other owners can't open the job");

  const accept = await call('POST', `/jobs/${jobId}/quotes/${detail.job.quotes.find((q) => q.mechanic.name === 'Ravi Kumar')._id}/accept`, owner);
  ok(accept.job?.status === 'booked' && accept.job.price === 1475, 'owner accepts quote -> booked at the revised price (750+400+100 = 1250, +18% tax = 1475)', accept.job?.price);
  ok((await call('POST', `/jobs/${jobId}/quotes/${detail.job.quotes[0]._id}/accept`, owner)).status === 400, 'cannot accept twice');

  console.log('Double-booking guard');
  const dup = await call('POST', '/jobs', owner, { vehicleId: veh._id, mechanicId: accept.job.mechanic, services: ['brake-service'], scheduledAt: when, location: loc });
  ok(dup.status === 409, 'same mechanic + same hour is refused', dup);
  const dups = await Promise.all([1, 2].map(() => call('POST', '/jobs', owner, { vehicleId: veh._id, mechanicId: mech.user._id, services: ['brake-service'], scheduledAt: tomorrowAt(7), location: loc })));
  ok(dups.filter((d) => d.status === 201).length === 1, 'two simultaneous bookings for one slot -> exactly one wins', dups.map((d) => d.status));
  const instant = dups.find((d) => d.status === 201);
  ok(instant?.job.type === 'instant' && instant.job.price === 950, 'instant booking uses the mechanic catalog price');
  ok((await call('POST', '/jobs', owner, { vehicleId: veh._id, mechanicId: mech.user._id, services: ['engine-repair'], scheduledAt: tomorrowAt(9), location: loc })).status === 400, 'service the mechanic does not offer is refused');

  console.log('Work order, extra work, payment');
  ok((await call('POST', `/jobs/${jobId}/status`, ravi, { status: 'completed' })).status === 400, 'cannot complete before check-in');
  ok((await call('POST', `/jobs/${jobId}/status`, ravi, { status: 'in_progress' })).job?.status === 'in_progress', 'mechanic checks in');
  const co = await call('POST', `/jobs/${jobId}/change-orders`, ravi, { description: 'Replace brake fluid', amount: 300 });
  ok(co.status === 201, 'mechanic requests extra work');
  ok((await call('POST', `/jobs/${jobId}/status`, ravi, { status: 'completed' })).status === 400, 'cannot complete while extra work awaits approval');
  ok((await call('POST', `/jobs/${jobId}/change-orders/${co.job.changeOrders[0]._id}/respond`, owner, { approve: true })).status === 200, 'owner approves extra work');
  const done = await call('POST', `/jobs/${jobId}/status`, ravi, { status: 'completed' });
  ok(done.job?.status === 'completed' && done.job.price === 1775, `job completed, final price = quote 1475 + approved extra 300 (got ${done.job?.price})`);
  const after = await call('GET', `/jobs/${jobId}`, owner);
  ok(after.payment?.status === 'captured' && Math.abs(after.payment.platformFee - after.payment.amount * 0.1) < 0.02, 'payment captured with 10% platform fee', after.payment);
  const earn = await call('GET', '/mechanics/me/earnings', ravi);
  ok(earn.pendingPayout > 0, 'mechanic sees pending payout');

  console.log('Messaging, review, dispute');
  ok((await call('POST', `/messages/job/${jobId}`, owner, { text: 'Thanks!' })).status === 201, 'owner messages mechanic');
  const conv = await call('GET', '/messages/conversations', ravi);
  ok(conv.conversations.some((c) => c.jobId === jobId && c.unread === 1), 'mechanic sees unread conversation');
  ok((await call('POST', '/reviews', owner, { jobId, rating: 5, comment: 'Great' })).status === 201, 'owner reviews completed job');
  ok((await call('POST', '/reviews', owner, { jobId, rating: 5 })).status === 409, 'only one review per job');
  ok((await call('POST', '/reviews', owner, { jobId: brake.job._id.replace(/.$/, 'f'), rating: 5 })).status >= 400, 'cannot review a job that is not completed');
  const disp = await call('POST', '/disputes', owner, { jobId, subject: 'Overcharged', description: 'Price differs' });
  ok(disp.status === 201, 'owner opens a dispute');

  console.log('Cancel');
  const cancel = await call('POST', `/jobs/${instant.job._id}/cancel`, owner, { reason: 'Changed plans' });
  ok(cancel.job?.status === 'cancelled', 'owner cancels booking');
  ok((await call('POST', '/jobs', owner, { vehicleId: veh._id, mechanicId: mech.user._id, services: ['brake-service'], scheduledAt: tomorrowAt(7), location: loc })).status === 201, 'cancelled slot becomes bookable again');

  console.log('Admin');
  const fin = await call('GET', '/admin/finance', admin);
  const pay = fin.payments.find((p) => p.status === 'captured' && p.job?._id === jobId) || fin.payments.find((p) => p.status === 'captured');
  ok(fin.totalRevenue > 0 && pay, 'finance shows captured revenue');
  ok((await call('POST', `/admin/payments/${pay._id}/settle`, admin)).payment?.payoutStatus === 'settled', 'admin settles payout');
  ok((await call('POST', `/admin/payments/${pay._id}/refund`, admin, {})).status === 400, 'cannot refund after payout settled');
  const dl = await call('GET', '/admin/disputes', admin);
  ok((await call('PATCH', `/admin/disputes/${dl.disputes[0]._id}`, admin, { status: 'resolved' })).status === 400, 'resolving needs a note');
  ok((await call('PATCH', `/admin/disputes/${dl.disputes[0]._id}`, admin, { status: 'resolved', resolution: 'Explained' })).dispute?.status === 'resolved', 'admin resolves dispute');
  const st = await call('GET', '/admin/stats', admin);
  ok(st.totalUsers > 0 && st.trend?.length === 7, 'overview stats', st);
  const usr = await call('GET', `/admin/users?role=owner&q=${stamp}`, admin);
  const target = usr.users.find((u) => u.email === `o${stamp}@t.test`);
  ok((await call('PATCH', `/admin/users/${target._id}/status`, admin, { status: 'suspended', reason: 'test' })).user?.status === 'suspended', 'admin suspends user');
  ok((await call('GET', '/auth/me', owner)).status === 403, 'suspended user is locked out');
  ok((await call('PUT', '/admin/settings', admin, { platformFeeRate: 0.9 })).status === 400, 'fee policy validated');
  const aud = await call('GET', '/admin/audit', admin);
  ok(aud.total >= 5 && aud.logs.some((l) => l.action === 'payment.payout_settled'), 'audit log records admin + financial actions');
  ok((await call('POST', '/uploads', admin)).status === 400, 'upload without file rejected');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
