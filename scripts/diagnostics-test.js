/**
 * Checks for the symptom diagnostic assistant, customer-supplied parts and the owner/mechanic fees.
 * Needs the API running against a seeded DB:  API=http://localhost:5000/api npm run test:diagnostics
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
const DAY = 2 + Math.floor(Math.random() * 3000);
const at = (h) => { const d = new Date(Date.now() + DAY * 86400000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const loc = { address: '12 MG Road, Bengaluru', city: 'Bengaluru', lat: 12.9757, lng: 77.6011 };

(async () => {
  const owner = await login('aman@autoservice.test');
  const ravi = await login('ravi@autoservice.test');
  const admin = await login('admin@autoservice.test', 'Admin@123');
  const veh = (await call('GET', '/vehicles', owner)).vehicles[0]._id;
  const raviId = (await call('GET', '/auth/me', ravi)).user._id;

  console.log('Catalog and rule engine');
  const cat = await call('GET', '/diagnostics/catalog', owner);
  ok(cat.areas?.length >= 8 && cat.symptoms?.length >= 15, 'catalog lists vehicle areas and searchable symptoms');
  ok(cat.symptoms.every((s) => s.areas.length && s.category), 'every symptom belongs to areas and a category');
  const qs = await call('GET', '/diagnostics/symptoms/no_crank', owner);
  ok(qs.symptom.questions.length >= 3 && qs.symptom.questions.every((q) => q.options.some((o) => o.id === 'unsure')), 'guided questions include a "Not sure" answer');
  ok((await call('GET', '/diagnostics/symptoms/nope', owner)).status === 404, 'unknown symptom is a 404');
  ok((await call('GET', '/diagnostics/catalog')).status === 401, 'diagnostics need a login');

  const noCrank = { symptomId: 'no_crank', areaId: 'engine_bay', answers: { lights: 'dim', sound: 'click', battery: 'no', jump: 'notried' } };
  const r1 = (await call('POST', '/diagnostics/evaluate', owner, noCrank)).result;
  ok(r1.classification === 'diagnostic' && /diagnostic inspection/i.test(r1.serviceName), '"engine does not crank" suggests a starting-system diagnostic inspection', r1);
  ok(!/starter.*replac|replace.*starter/i.test(r1.serviceName + r1.classificationReason), 'it does not tell the customer to replace the starter');
  ok(r1.causes.length >= 2 && r1.causes[0].level && r1.safety.level === 'none', 'possible causes are ranked and no safety warning for this case');
  const r2 = (await call('POST', '/diagnostics/evaluate', owner, { ...noCrank, answers: { ...noCrank.answers, jump: 'yes' } })).result;
  ok(r2.classification === 'repair' && r2.service === 'battery-replacement', 'jump-start works and old battery points to a repair (battery replacement)', r2);
  ok((await call('POST', '/diagnostics/evaluate', owner, { symptomId: 'no_crank', answers: { lights: 'dim' } })).status === 400, 'unanswered questions are rejected');
  ok((await call('POST', '/diagnostics/evaluate', owner, { symptomId: 'no_crank', answers: { ...noCrank.answers, lights: 'bogus' } })).status === 400, 'invalid answers are rejected');

  const brake = { symptomId: 'brake_soft', areaId: 'wheels', answers: { pedal: 'floor', fluid: 'low', leak: 'yes' } };
  const r3 = (await call('POST', '/diagnostics/evaluate', owner, brake)).result;
  ok(r3.safety.level === 'urgent' && /112/.test(r3.safety.advice) && r3.classification === 'diagnostic', 'brake pedal to the floor is flagged urgent with escalation advice');
  const r4 = (await call('POST', '/diagnostics/evaluate', owner, { symptomId: 'install_part', answers: { part: 'battery', sure: 'no', fits: 'yes' } })).result;
  ok(r4.classification === 'diagnostic' && /not sure/i.test(r4.classificationReason), 'unsure about a part to fit: diagnostic recommended instead of installation');
  const r5 = (await call('POST', '/diagnostics/evaluate', owner, { symptomId: 'install_part', answers: { part: 'battery', sure: 'sure', fits: 'yes' } })).result;
  ok(r5.classification === 'installation' && r5.service === 'battery-replacement', 'known part is classified as installation and routed to the right skill', r5);

  console.log('Job generation, matching and mechanic report');
  const body = (extra = {}) => ({ vehicleId: veh, scheduledAt: at(5), location: loc, ...extra });
  ok((await call('POST', '/jobs', owner, body({ diagnosis: { ...brake } }))).status === 400, 'urgent safety warning must be acknowledged before a job is created');
  ok((await call('POST', '/jobs', owner, body({ diagnosis: { symptomId: 'nope', answers: {} } }))).status === 400, 'invalid report cannot create a job');
  const created = await call('POST', '/jobs', owner, body({ diagnosis: { ...brake, acknowledgeSafety: true, ownerNote: 'Happened after the rains' } }));
  ok(created.status === 201 && created.matchedCount >= 1, 'structured repair job is generated and matched to mechanics', created);
  const jobId = created.job._id;
  ok(created.job.category === 'brake-service' && created.job.diagnosis.classification === 'diagnostic' && created.job.diagnosis.safety.level === 'urgent', 'job category, classification and safety come from the server-side rules');
  ok(/Owner note: Happened after the rains/.test(created.job.description), 'structured summary includes the owner note');
  const lead = (await call('GET', '/jobs/requests', ravi)).jobs.find((j) => j._id === jobId);
  ok(lead && lead.diagnosis.symptomLabel && lead.diagnosis.answers.length === 3, 'mechanic receives the full symptom report before quoting');
  const detail = (await call('GET', `/jobs/${jobId}`, ravi)).job;
  ok(detail.diagnosis.causes.length >= 2 && detail.location.approximate, 'report is complete and the address is still approximate');
  const notes = (await call('GET', '/notifications', ravi)).notifications || [];
  ok(notes.some((n) => /URGENT/.test(n.title)), 'urgent leads are announced as URGENT');

  console.log('Mechanic flags the classification');
  ok((await call('POST', `/jobs/${jobId}/flag-classification`, ravi, { recommended: 'diagnostic', note: 'same as now' })).status === 400, 'cannot recommend the current classification');
  ok((await call('POST', `/jobs/${jobId}/flag-classification`, ravi, { recommended: 'repair', note: 'x' })).status === 400, 'a reason is required');
  ok((await call('POST', `/jobs/${jobId}/flag-classification`, owner, { recommended: 'repair', note: 'abcdef' })).status === 403, 'only mechanics can flag');
  const flag = await call('POST', `/jobs/${jobId}/flag-classification`, ravi, { recommended: 'repair', note: 'Pads are the usual cause here, I can quote the repair directly.' });
  ok(flag.status === 201, 'mechanic flags an incorrect classification', flag);
  const ownerView = (await call('GET', `/jobs/${jobId}`, owner)).job;
  const flagId = ownerView.classificationFlags.find((f) => f.status === 'open')?._id;
  ok(flagId && ownerView.classificationFlags[0].mechanic.name, 'owner sees the suggestion with the mechanic name');
  const adminFlagged = (await call('GET', '/admin/jobs?flagged=1', admin)).jobs;
  ok(adminFlagged.some((j) => j._id === jobId), 'admin can list jobs with open classification flags');
  const acc = await call('POST', `/jobs/${jobId}/classification/respond`, owner, { flagId, accept: true });
  ok(acc.job?.diagnosis.classification === 'repair' && /repair/i.test(acc.job.diagnosis.serviceName), 'owner accepts and the classification changes', acc.job?.diagnosis);
  ok((await call('POST', `/jobs/${jobId}/classification/respond`, owner, { flagId, accept: false })).status === 404, 'a suggestion can only be answered once');

  console.log('Customer-supplied parts');
  const part = { name: 'Exide car battery 55Ah', partNumber: 'EX55', brand: 'Exide', quantity: 1, condition: 'new', photos: [] };
  const inst = { symptomId: 'install_part', areaId: 'engine_bay', answers: { part: 'battery', sure: 'sure', fits: 'yes' } };
  ok((await call('POST', '/jobs', owner, body({ diagnosis: inst, parts: { source: 'customer', items: [part] } }))).status === 400, 'parts must be confirmed before checkout');
  ok((await call('POST', '/jobs', owner, body({ diagnosis: inst, parts: { source: 'customer', items: [], confirmed: true } }))).status === 400, 'at least one part is required');
  ok((await call('POST', '/jobs', owner, body({ diagnosis: inst, parts: { source: 'supplier_pickup', items: [part], confirmed: true } }))).status === 400, 'supplier pick-up is blocked until milestone 2 is enabled');
  const pj = await call('POST', '/jobs', owner, body({ diagnosis: inst, parts: { source: 'customer', items: [part], confirmed: true } }));
  ok(pj.status === 201 && pj.job.parts.source === 'customer' && pj.job.parts.customerConfirmed && pj.job.category === 'battery-replacement', 'installation job created with confirmed customer parts', pj.job?.parts);
  const pid = pj.job._id;
  const lead2 = (await call('GET', '/jobs/requests', ravi)).jobs.find((j) => j._id === pid);
  ok(lead2?.parts.items[0].name === part.name, 'mechanic sees the customer parts before quoting');
  const quote = await call('POST', `/jobs/${pid}/quotes`, ravi, { labor: 400, parts: 999, travel: 100 });
  ok(quote.quote?.parts === 0 && quote.quote.total === Math.round((500) * 1.18 * 100) / 100, 'quote carries no parts charge when the customer supplies the parts', quote.quote);
  ok((await call('POST', `/jobs/${pid}/quotes/${quote.quote._id}/accept`, owner, {})).status === 400, 'accepting the quote needs the parts confirmation');
  const book = await call('POST', `/jobs/${pid}/quotes/${quote.quote._id}/accept`, owner, { confirmParts: true });
  ok(book.job?.status === 'booked', 'quote accepted after confirming the parts');
  ok((await call('POST', `/jobs/${pid}/status`, ravi, { status: 'in_progress' })).status === 400, 'mechanic cannot start until the customer confirms the parts are ready');
  ok((await call('POST', `/jobs/${pid}/parts/ready`, ravi, {})).status === 403, 'only the owner can mark parts ready');
  const rd = await call('POST', `/jobs/${pid}/parts/ready`, owner, { note: 'Battery is at the garage gate' });
  ok(rd.job?.parts.ready === true, 'owner confirms parts are ready');
  ok((await call('POST', `/jobs/${pid}/parts/inspect`, ravi, { status: 'mismatch' })).status === 400, 'a mismatch report needs an explanation');
  const mm = await call('POST', `/jobs/${pid}/parts/inspect`, ravi, { status: 'mismatch', note: 'This is a 45Ah battery, the car needs 55Ah' });
  ok(mm.job?.parts.inspection.status === 'mismatch' && mm.job.parts.ready === false, 'mechanic reports a mismatch and readiness is reset');
  ok((await call('POST', `/jobs/${pid}/status`, ravi, { status: 'in_progress' })).status === 400, 'job cannot start while a mismatch is open');
  const upd = await call('PUT', `/jobs/${pid}/parts`, owner, { source: 'customer', items: [{ ...part, name: 'Exide 55Ah (correct one)' }], confirmed: true });
  ok(upd.job?.parts.inspection.status === 'pending' && upd.job.parts.ready === false, 'updating the parts resets inspection and needs confirming again');
  await call('POST', `/jobs/${pid}/parts/ready`, owner, {});
  ok((await call('POST', `/jobs/${pid}/parts/inspect`, ravi, { status: 'ok' })).job?.parts.inspection.status === 'ok', 'mechanic confirms the parts are right');

  console.log('Fees: owner booking fee and mechanic sourcing fee');
  ok((await call('PUT', '/admin/settings', admin, { ownerFeeRate: 0.2 })).status === 400 && (await call('PUT', '/admin/settings', admin, { ownerFeeRate: 0.01 })).status === 400, 'owner booking fee must stay between 5% and 10%');
  const jd = await call('GET', `/jobs/${pid}`, owner);
  ok(Math.abs(jd.fees.ownerFee - jd.job.price * 0.05) < 0.02 && Math.abs(jd.fees.mechanicFee - jd.job.price * 0.1) < 0.02, 'checkout shows a 5% owner fee and 10% mechanic fee', jd.fees);
  ok((await call('PUT', '/admin/settings', admin, { ownerFeeRate: 0.1 })).status === 200, 'admin changes the owner fee to 10%');
  await call('POST', `/jobs/${pid}/status`, ravi, { status: 'in_progress' });
  ok((await call('GET', `/jobs/${pid}`, ravi)).job.status === 'in_progress', 'job starts once parts are ready and checked');
  await call('POST', `/jobs/${pid}/status`, ravi, { status: 'completed' });
  const done = await call('GET', `/jobs/${pid}`, owner);
  ok(done.payment.status === 'captured' && Math.abs(done.payment.ownerFee - done.payment.amount * 0.05) < 0.02, 'the fee rate fixed at booking is used, later policy changes do not apply', done.payment);
  await call('PUT', '/admin/settings', admin, { ownerFeeRate: 0.05 });
  const earn = await call('GET', '/mechanics/me/earnings', ravi);
  ok(earn.fees > 0 && earn.net > 0, 'mechanic earnings show the sourcing fee and net payout');
  const fin = await call('GET', '/admin/finance', admin);
  ok(fin.ownerFees > 0 && fin.mechanicFees > 0 && fin.platformFees >= fin.ownerFees + fin.mechanicFees - 0.05, 'admin finance reports owner and mechanic fees');

  console.log('Instant installation booking with customer parts');
  const inBody = (h, extra) => ({ vehicleId: veh, mechanicId: raviId, services: ['battery-replacement'], scheduledAt: at(h), location: loc, ...extra });
  ok((await call('POST', '/jobs', owner, inBody(8, { parts: { source: 'customer', items: [part] } }))).status === 400, 'instant booking also needs part confirmation');
  const ib = await call('POST', '/jobs', owner, inBody(8, { parts: { source: 'customer', items: [part], confirmed: true } }));
  ok(ib.status === 201 && ib.job.status === 'booked' && ib.job.parts.source === 'customer' && ib.fees.totalCharged > ib.job.price, 'instant booking with customer-supplied parts', ib);
  const ib2 = await call('POST', '/jobs', owner, inBody(12));
  ok(ib2.status === 201 && ib2.job.parts.source === 'mechanic', 'plain instant booking keeps the mechanic as the parts supplier');
  await call('POST', `/jobs/${ib.job._id}/cancel`, owner, { reason: 'test' });
  await call('POST', `/jobs/${ib2.job._id}/cancel`, owner, { reason: 'test' });

  console.log('Milestone 2 switch (supplier pick-up / shipped parts)');
  ok((await call('PUT', '/admin/settings', admin, { supplierIntegrationEnabled: true })).status === 200, 'admin switches supplier integration on');
  const sp = await call('POST', '/jobs', owner, body({ scheduledAt: at(9), diagnosis: inst, parts: { source: 'supplier_pickup', items: [part], confirmed: true } }));
  ok(sp.status === 201 && sp.job.parts.fulfillment.status === 'awaiting_pickup', 'supplier pick-up job can be created once enabled');
  const sq = await call('POST', `/jobs/${sp.job._id}/quotes`, ravi, { labor: 300, parts: 700 });
  ok(sq.quote?.parts === 700, 'with mechanic pick-up the quote may include the parts cost');
  await call('POST', `/jobs/${sp.job._id}/quotes/${sq.quote._id}/accept`, owner, { confirmParts: true });
  ok((await call('POST', `/jobs/${sp.job._id}/status`, ravi, { status: 'in_progress' })).status === 400, 'job waits for the parts pick-up');
  const pk = await call('POST', `/jobs/${sp.job._id}/parts/fulfillment`, ravi, { status: 'picked_up' });
  ok(pk.job?.parts.ready === true && pk.job.parts.fulfillment.status === 'picked_up', 'mechanic marks the parts picked up and the job can start');
  await call('POST', `/jobs/${sp.job._id}/cancel`, ravi, { reason: 'test' });
  await call('PUT', '/admin/settings', admin, { supplierIntegrationEnabled: false });

  console.log('Admin can correct a classification');
  const ac = await call('POST', `/admin/jobs/${jobId}/classification`, admin, { classification: 'diagnostic', note: 'Safety first' });
  ok(ac.job?.diagnosis.classification === 'diagnostic', 'admin overrides the classification');
  await call('POST', `/jobs/${jobId}/cancel`, owner, { reason: 'test' });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });