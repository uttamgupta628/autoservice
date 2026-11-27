const router = require('express').Router();
const { asyncHandler, protect } = require('../middleware');
const diag = require('../services/diagnostics');
const { getSettings, clampOwnerFee } = require('../services/helpers');

router.use(protect);

/** What the app needs to know about fees and which parts options are switched on. */
const publicConfig = async () => {
  const s = await getSettings();
  return { ownerFeeRate: clampOwnerFee(s.ownerFeeRate), supplierIntegrationEnabled: !!s.supplierIntegrationEnabled };
};
router.get('/config', asyncHandler(async (req, res) => res.json(await publicConfig())));

/** Vehicle areas, classes and the searchable symptom list. */
router.get('/catalog', asyncHandler(async (req, res) => res.json({ ...diag.catalog(), config: await publicConfig() })));

/** One symptom with its guided questions (one question per screen on the app). */
router.get('/symptoms/:id', (req, res) => res.json({ symptom: diag.symptomQuestions(req.params.id) }));

/** Narrow down possible causes, screen for safety and classify the service. Nothing is saved. */
router.post(
  '/evaluate',
  asyncHandler(async (req, res) => {
    const { symptomId, areaId, answers } = req.body;
    res.json({ result: diag.evaluate({ symptomId, areaId, answers }) });
  })
);

module.exports = router;