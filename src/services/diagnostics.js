/**
 * Rule-based symptom diagnostics (no AI, no guessing).
 *
 *   area tapped on the vehicle -> symptom -> guided questions -> possible causes
 *   -> safety screening -> service classification (diagnostic / repair / installation)
 *
 * Everything here is deterministic and lives in plain data, so support can review it and the client can
 * change wording or weights without touching the flow. The result is ALWAYS "possible causes", never a
 * confirmed diagnosis: a mechanic confirms on site.
 */
const { ApiError } = require('../middleware');

/* ---------------- vehicle areas (the highlighted zones on the diagram) ---------------- */
const AREAS = [
  { id: 'engine_bay', label: 'Engine bay / bonnet' },
  { id: 'cooling', label: 'Radiator & cooling' },
  { id: 'wheels', label: 'Wheels, tyres & brakes' },
  { id: 'cabin', label: 'Cabin & dashboard' },
  { id: 'exhaust', label: 'Exhaust' },
  { id: 'underbody', label: 'Underneath the car' },
  { id: 'lights_body', label: 'Lights & bumpers' },
  { id: 'doors_glass', label: 'Doors, glass & mirrors' },
  { id: 'boot', label: 'Boot / rear' },
];

const CLASSES = {
  diagnostic: { label: 'Diagnostic inspection', hint: 'A mechanic inspects and finds the cause first. You then approve any repair.' },
  repair: { label: 'Repair', hint: 'The problem is well understood, so the mechanic can quote the repair directly.' },
  installation: { label: 'Installation', hint: 'A mechanic fits a part you already have (or the mechanic supplies it).' },
};

const URGENT_ADVICE = 'Do not drive the vehicle. Move to a safe place, switch on the hazard lights and call roadside assistance. If anyone is in danger or you see fire or heavy smoke, call emergency services (112).';
const WARNING_ADVICE = 'Avoid long trips and high speeds until a mechanic has inspected it.';

/* ---------------- tiny DSL ---------------- */
const Q = (id, text, options) => ({ id, text, options: options.map(([oid, label, extra]) => ({ id: oid, label, ...(extra || {}) })) });
const C = (label, base, rules = []) => ({ label, base, rules }); // rules: [qId, [optionIds], weight]
const S = (level, q, opts, message) => ({ level, q, opts, message }); // safety rule
const K = (as, q, opts, reason, extra = {}) => ({ as, q, opts, reason, ...extra }); // classification rule
const yn = (id, text) => Q(id, text, [['yes', 'Yes'], ['no', 'No']]);

/* ---------------- symptoms ---------------- */
const SYMPTOMS = [
  {
    id: 'no_crank', label: "Engine doesn't crank or won't start", category: 'Starting & electrical', areas: ['engine_bay', 'cabin'],
    keywords: ['start', 'crank', 'dead', 'click', 'wont start', "won't start", 'turn over', 'ignition'], service: 'general-service',
    names: { diagnostic: 'Starting-system diagnostic inspection', repair: 'Battery test & replacement' },
    questions: [
      Q('lights', 'When you turn the key or press start, do the dashboard lights come on?', [['bright', 'Yes, normal brightness'], ['dim', 'Yes, but dim or flickering'], ['none', 'No lights at all']]),
      Q('sound', 'What do you hear when you try to start?', [['click', 'Rapid clicking'], ['single', 'One loud click'], ['slow', 'Engine turns over slowly'], ['fast', 'Engine turns normally but will not fire'], ['silent', 'Nothing at all']]),
      Q('battery', 'Has the battery been replaced recently?', [['recent', 'Yes, in the last 6 months'], ['no', 'No']]),
      Q('jump', 'Did a jump-start help?', [['yes', 'Yes, it started'], ['no', 'No, still will not start'], ['notried', 'Not tried']]),
    ],
    causes: [
      C('Weak or discharged battery', 0.1, [['lights', ['dim'], 0.35], ['sound', ['click', 'slow'], 0.3], ['jump', ['yes'], 0.35], ['battery', ['no'], 0.1]]),
      C('Loose or corroded battery terminals', 0.1, [['lights', ['dim'], 0.15], ['sound', ['click'], 0.2], ['battery', ['recent'], 0.25]]),
      C('Starter motor or solenoid fault', 0.1, [['sound', ['single'], 0.45], ['lights', ['bright'], 0.2], ['jump', ['no'], 0.15]]),
      C('Fuel delivery or ignition problem', 0.05, [['sound', ['fast'], 0.6]]),
      C('Alternator / charging system fault', 0.05, [['battery', ['recent'], 0.2], ['jump', ['yes'], 0.1]]),
      C('Immobiliser, key or security fault', 0.05, [['sound', ['silent'], 0.2], ['lights', ['bright'], 0.1]]),
    ],
    safety: [],
    classify: [K('repair', 'jump', ['yes'], 'The engine started after a jump-start and the battery is not new, so a battery test and likely replacement is the most direct fix.', { when2: ['battery', ['no']], service: 'battery-replacement' })],
  },
  {
    id: 'overheating', label: 'Engine overheating or steam', category: 'Engine & cooling', areas: ['engine_bay', 'cooling'],
    keywords: ['overheat', 'hot', 'temperature', 'steam', 'coolant', 'radiator', 'boiling'], service: 'engine-repair',
    names: { diagnostic: 'Cooling-system diagnostic inspection' },
    questions: [
      Q('gauge', 'What does the temperature gauge or warning light show?', [['hot', 'In the red or warning light on'], ['rising', 'Rises slowly in traffic'], ['normal', 'Normal, but I noticed steam or a smell']]),
      Q('steam', 'Do you see steam or smell something sweet?', [['steam', 'Steam from the bonnet'], ['sweet', 'Sweet smell (coolant)'], ['none', 'Neither']]),
      Q('coolant', 'Is the coolant level low?', [['low', 'Yes, low or empty'], ['ok', 'No, it looks fine']]),
      Q('fan', 'Does the radiator fan run when the engine is hot?', [['yes', 'Yes'], ['no', 'No']]),
    ],
    causes: [
      C('Coolant leak (hose or radiator)', 0.15, [['coolant', ['low'], 0.35], ['steam', ['steam'], 0.2], ['steam', ['sweet'], 0.25]]),
      C('Radiator fan or fan relay fault', 0.1, [['fan', ['no'], 0.45]]),
      C('Thermostat stuck closed', 0.1, [['gauge', ['hot', 'rising'], 0.2], ['fan', ['yes'], 0.15]]),
      C('Water pump failure', 0.05, [['gauge', ['hot'], 0.1], ['steam', ['steam'], 0.1]]),
      C('Head gasket problem (less common)', 0.03, [['steam', ['steam'], 0.1], ['coolant', ['low'], 0.1]]),
    ],
    safety: [
      S('urgent', 'gauge', ['hot'], 'Overheating can wreck the engine and cause burns. Switch the engine off and let it cool before doing anything. Never open the radiator cap while hot.'),
      S('urgent', 'steam', ['steam'], 'Steam from the bonnet means the engine is dangerously hot. Stop and switch off now. Keep away from the bonnet.'),
    ],
    classify: [],
  },
  {
    id: 'warning_light', label: 'Check-engine or warning light on', category: 'Engine & cooling', areas: ['cabin', 'engine_bay'],
    keywords: ['light', 'warning', 'check engine', 'dashboard', 'mil', 'oil light', 'battery light'], service: 'engine-repair',
    names: { diagnostic: 'Engine diagnostic scan' },
    questions: [
      Q('light', 'Which light is on?', [['amber', 'Amber check-engine light'], ['flash', 'Check-engine light is flashing'], ['oil', 'Red oil-pressure light'], ['batt', 'Red battery / charging light'], ['other', 'Another warning light']]),
      Q('drive', 'How does the vehicle drive?', [['normal', 'Normally'], ['rough', 'Rough, shaking or losing power'], ['noise', 'Unusual noise']]),
      Q('fuel', 'Did the light come on after refuelling?', [['yes', 'Yes'], ['no', 'No']]),
    ],
    causes: [
      C('Loose or faulty fuel cap', 0.05, [['fuel', ['yes'], 0.45]]),
      C('Faulty engine sensor (oxygen / air-flow)', 0.2, [['drive', ['normal'], 0.2], ['light', ['amber'], 0.15]]),
      C('Ignition coil or spark plug misfire', 0.05, [['light', ['flash'], 0.4], ['drive', ['rough'], 0.35]]),
      C('Low oil level or oil-pressure problem', 0.03, [['light', ['oil'], 0.6]]),
      C('Charging system / alternator fault', 0.03, [['light', ['batt'], 0.6]]),
    ],
    safety: [
      S('urgent', 'light', ['oil'], 'A red oil-pressure light means the engine can be damaged within minutes. Stop and switch the engine off.'),
      S('warning', 'light', ['flash'], 'A flashing check-engine light means a misfire that can damage the exhaust. Reduce speed and load.'),
      S('warning', 'light', ['batt'], 'The vehicle may stop soon because the battery is not charging. Avoid long trips.'),
    ],
    classify: [],
  },
  {
    id: 'rough_running', label: 'Rough running, shaking or loss of power', category: 'Engine & cooling', areas: ['engine_bay'],
    keywords: ['shake', 'misfire', 'power', 'stall', 'jerk', 'hesitate', 'rough idle', 'vibration'], service: 'engine-repair',
    names: { diagnostic: 'Engine performance diagnostic inspection' },
    questions: [
      Q('when', 'When does it happen?', [['idle', 'When stopped or idling'], ['accel', 'When accelerating'], ['always', 'All the time'], ['cold', 'Only on a cold start']]),
      Q('stall', 'Does the engine stall?', [['yes', 'Yes'], ['no', 'No']]),
      Q('smell', 'Do you see smoke or smell fuel?', [['none', 'No'], ['smoke', 'Visible exhaust smoke'], ['fuel', 'Smell of fuel']]),
    ],
    causes: [
      C('Worn spark plugs or ignition coil', 0.15, [['when', ['idle', 'accel'], 0.15]]),
      C('Clogged fuel or air filter', 0.1, [['when', ['accel'], 0.3]]),
      C('Faulty sensor or throttle body', 0.1, [['stall', ['yes'], 0.25]]),
      C('Vacuum / air leak', 0.1, [['when', ['idle'], 0.25]]),
      C('Fuel injector problem', 0.1, [['when', ['always'], 0.2], ['smell', ['fuel'], 0.2]]),
    ],
    safety: [S('urgent', 'smell', ['fuel'], 'A fuel smell is a fire risk. Switch off the engine, keep away from flames and sparks, and do not drive.')],
    classify: [],
  },
  {
    id: 'exhaust_smoke', label: 'Smoke from the exhaust or a burning smell', category: 'Engine & cooling', areas: ['exhaust', 'engine_bay', 'underbody'],
    keywords: ['smoke', 'exhaust', 'burning', 'smell', 'blue smoke', 'white smoke', 'black smoke', 'silencer'], service: 'engine-repair',
    names: { diagnostic: 'Exhaust & emissions diagnostic inspection' },
    questions: [
      Q('colour', 'What do you see or smell?', [['white', 'White or grey vapour'], ['blue', 'Blue smoke'], ['black', 'Black smoke'], ['burning', 'No smoke, but a burning smell']]),
      Q('when', 'When does it happen?', [['startup', 'Only on a cold start'], ['always', 'All the time'], ['accel', 'When accelerating']]),
      Q('loss', 'Has the engine been losing oil or coolant?', [['oil', 'Oil'], ['coolant', 'Coolant'], ['none', 'No']]),
    ],
    causes: [
      C('Normal condensation on a cold start', 0.05, [['colour', ['white'], 0.2], ['when', ['startup'], 0.4]]),
      C('Burning engine oil (worn seals or rings)', 0.05, [['colour', ['blue'], 0.5], ['loss', ['oil'], 0.25]]),
      C('Rich fuel mixture or injector fault', 0.05, [['colour', ['black'], 0.5]]),
      C('Coolant entering the engine (head gasket)', 0.03, [['colour', ['white'], 0.15], ['loss', ['coolant'], 0.4]]),
      C('Exhaust or heat-shield problem', 0.05, [['colour', ['burning'], 0.35]]),
    ],
    safety: [
      S('urgent', 'colour', ['burning'], 'A burning smell can mean an electrical or fuel problem. Stop in a safe place and switch off the engine. Do not keep driving.'),
      S('warning', 'loss', ['coolant', 'oil'], 'The engine is losing fluid. Check the level before driving and top up if needed.'),
    ],
    classify: [],
  },
  {
    id: 'fluid_leak', label: 'Fluid leaking under the car', category: 'Fluids & service', areas: ['underbody', 'engine_bay', 'wheels'],
    keywords: ['leak', 'drip', 'puddle', 'oil', 'fluid', 'coolant', 'wet'], service: 'general-service',
    names: { diagnostic: 'Leak diagnostic inspection' },
    questions: [
      Q('colour', 'What colour is the fluid?', [['dark', 'Dark brown or black'], ['red', 'Red or pink'], ['green', 'Green, orange or blue'], ['clear', 'Clear like water'], ['amber', 'Clear yellow and oily, near a wheel']]),
      Q('size', 'How much is leaking?', [['drip', 'A few drops'], ['puddle', 'A puddle overnight'], ['stream', 'A steady stream']]),
      Q('where', 'Where is the leak?', [['front', 'Front'], ['middle', 'Middle'], ['rear', 'Rear'], ['wheel', 'Near a wheel']]),
    ],
    causes: [
      C('Engine oil leak (gasket or sump)', 0.05, [['colour', ['dark'], 0.5]]),
      C('Transmission or power-steering fluid leak', 0.05, [['colour', ['red'], 0.5]]),
      C('Coolant leak', 0.05, [['colour', ['green'], 0.5]]),
      C('Air-conditioning condensation (normal)', 0.03, [['colour', ['clear'], 0.5], ['size', ['drip'], 0.1]]),
      C('Brake fluid leak (serious)', 0.02, [['colour', ['amber'], 0.45], ['where', ['wheel'], 0.2]]),
    ],
    safety: [
      S('urgent', 'colour', ['amber'], 'A brake-fluid leak can cause brake failure. Do not drive the vehicle.'),
      S('urgent', 'size', ['stream'], 'A steady leak can empty a system quickly and damage the engine or brakes. Do not drive.'),
      S('warning', 'size', ['puddle'], 'Keep an eye on fluid levels and avoid long trips until it is checked.'),
    ],
    classify: [],
  },
  {
    id: 'oil_service', label: 'Oil change due, low oil or oil light', category: 'Fluids & service', areas: ['engine_bay'],
    keywords: ['oil', 'service', 'oil change', 'filter', 'dipstick', 'maintenance'], service: 'oil-change',
    names: { diagnostic: 'Oil-pressure diagnostic inspection', repair: 'Oil & filter change' },
    defaultClass: 'repair',
    questions: [
      Q('reason', 'What is the situation?', [['due', 'Regular service or oil change is due'], ['low', 'The dipstick shows low oil'], ['light', 'The oil warning light is on'], ['dirty', 'The oil looks very dark or gritty']]),
      Q('last', 'When was the last oil change?', [['recent', 'In the last 6 months'], ['mid', '6 to 12 months ago'], ['old', 'More than a year ago or not sure']]),
    ],
    causes: [
      C('Oil and filter are due for replacement', 0.2, [['last', ['mid', 'old'], 0.3], ['reason', ['due', 'dirty'], 0.3]]),
      C('Oil level is low (consumption or a leak)', 0.1, [['reason', ['low', 'light'], 0.4]]),
      C('Oil-pressure sensor or pump problem', 0.03, [['reason', ['light'], 0.3]]),
    ],
    safety: [S('urgent', 'reason', ['light'], 'A red oil-pressure light means the engine can be damaged within minutes. Stop and switch the engine off.')],
    classify: [K('diagnostic', 'reason', ['light'], 'The oil warning light can mean a fault, not just a service, so the mechanic should inspect it first.')],
  },
  {
    id: 'brake_noise', label: 'Squealing or grinding when braking', category: 'Brakes', areas: ['wheels'],
    keywords: ['brake', 'squeal', 'grind', 'screech', 'pads', 'discs', 'noise'], service: 'brake-service',
    names: { diagnostic: 'Brake system diagnostic inspection', repair: 'Brake pad & disc inspection and replacement' },
    questions: [
      Q('noise', 'What does it sound like?', [['squeal', 'High-pitched squeal'], ['grind', 'Metal grinding'], ['thump', 'Clunk or thump']]),
      Q('pedal', 'How does the brake pedal feel?', [['normal', 'Normal'], ['soft', 'Soft or spongy'], ['pulse', 'Pulsing or vibrating']]),
      yn('light', 'Is the brake warning light on?'),
      Q('age', 'When were the brakes last serviced?', [['recent', 'In the last year'], ['old', 'More than a year ago or never']]),
    ],
    causes: [
      C('Worn brake pads', 0.1, [['noise', ['squeal'], 0.35], ['noise', ['grind'], 0.3], ['age', ['old'], 0.2], ['light', ['yes'], 0.15]]),
      C('Worn or scored brake discs', 0.08, [['noise', ['grind'], 0.35], ['pedal', ['pulse'], 0.25]]),
      C('Glazed pads or brake dust (minor)', 0.05, [['noise', ['squeal'], 0.15], ['age', ['recent'], 0.25]]),
      C('Sticking brake caliper', 0.05, [['pedal', ['pulse'], 0.1], ['noise', ['thump'], 0.2]]),
      C('Low brake fluid or a leak', 0.03, [['pedal', ['soft'], 0.35], ['light', ['yes'], 0.2]]),
    ],
    safety: [
      S('urgent', 'pedal', ['soft'], 'A soft brake pedal can mean the brakes are about to fail. Do not drive the vehicle.'),
      S('warning', 'noise', ['grind'], 'Metal-on-metal grinding reduces stopping power. Drive gently and get it checked soon.'),
    ],
    classify: [
      K('repair', 'noise', ['squeal', 'grind'], 'Squealing or grinding on older brakes usually points to worn pads or discs, so the mechanic can quote that directly.', { when2: ['age', ['old']], and: ['pedal', ['normal', 'pulse']] }),
    ],
  },
  {
    id: 'brake_soft', label: 'Brake pedal soft, hard or pulling to one side', category: 'Brakes', areas: ['wheels'],
    keywords: ['brake', 'pedal', 'floor', 'spongy', 'pull', 'stopping', 'abs'], service: 'brake-service',
    names: { diagnostic: 'Brake system diagnostic inspection' },
    baseSafety: S('urgent', null, null, 'Brake faults are a safety risk. Do not drive the vehicle until a mechanic has checked it.'),
    questions: [
      Q('pedal', 'What is wrong with the pedal?', [['floor', 'It goes to the floor'], ['soft', 'Soft or spongy'], ['hard', 'Hard, needs a lot of force'], ['pull', 'The car pulls to one side when braking']]),
      Q('fluid', 'Is the brake fluid level low?', [['low', 'Yes'], ['ok', 'No, it looks fine']]),
      yn('leak', 'Any fluid near the wheels or under the car?'),
    ],
    causes: [
      C('Air in the brake system or low fluid', 0.1, [['pedal', ['soft', 'floor'], 0.3], ['fluid', ['low'], 0.3]]),
      C('Brake fluid leak (hose, caliper or master cylinder)', 0.05, [['leak', ['yes'], 0.4], ['pedal', ['floor'], 0.25]]),
      C('Brake booster or vacuum fault', 0.05, [['pedal', ['hard'], 0.5]]),
      C('Sticking brake caliper', 0.05, [['pedal', ['pull'], 0.5]]),
    ],
    safety: [],
    classify: [],
  },
  {
    id: 'ac_not_cooling', label: 'Air conditioning not cooling', category: 'Air conditioning', areas: ['cabin', 'engine_bay'],
    keywords: ['ac', 'air conditioning', 'cooling', 'warm air', 'blower', 'cold', 'smell'], service: 'ac-service',
    names: { diagnostic: 'AC system diagnostic inspection', repair: 'AC gas refill & leak check' },
    questions: [
      Q('air', 'What happens when the AC is on?', [['warm', 'Blows warm air'], ['weak', 'Cool, but weak airflow'], ['slow', 'Takes a long time to cool'], ['none', 'No air at all']]),
      Q('comp', 'Do you hear the AC compressor click on when you switch it on?', [['yes', 'Yes'], ['no', 'No']]),
      Q('last', 'When was the AC last serviced?', [['recent', 'In the last 2 years'], ['old', 'More than 2 years ago or never']]),
      Q('smell', 'Any smell from the vents?', [['none', 'No'], ['musty', 'Musty or damp'], ['sweet', 'Sweet (possible coolant)']]),
    ],
    causes: [
      C('Low refrigerant (small leak or age)', 0.1, [['air', ['warm'], 0.3], ['last', ['old'], 0.2], ['comp', ['yes'], 0.1]]),
      C('Compressor or clutch fault', 0.08, [['comp', ['no'], 0.4], ['air', ['warm'], 0.1]]),
      C('Blocked cabin filter or blower fault', 0.1, [['air', ['weak'], 0.4], ['air', ['none'], 0.3], ['smell', ['musty'], 0.2]]),
      C('Condenser or condenser-fan problem', 0.08, [['air', ['slow'], 0.3]]),
    ],
    safety: [],
    classify: [K('repair', 'air', ['warm'], 'Warm air with an AC that was not serviced recently usually means low refrigerant, so a gas refill with a leak check is the likely fix.', { when2: ['last', ['old']], and: ['comp', ['yes']] })],
  },
  {
    id: 'battery_dies', label: 'Battery keeps going flat', category: 'Starting & electrical', areas: ['engine_bay', 'cabin'],
    keywords: ['battery', 'flat', 'dead', 'drain', 'charge', 'alternator'], service: 'battery-replacement',
    names: { diagnostic: 'Charging-system diagnostic inspection', repair: 'Battery test & replacement' },
    questions: [
      Q('often', 'How often does it go flat?', [['daily', 'Every few days'], ['once', 'Only once'], ['cold', 'Mainly in cold weather']]),
      Q('age', 'How old is the battery?', [['new', 'Under 2 years'], ['mid', '2 to 4 years'], ['old', 'Over 4 years or not sure']]),
      yn('dim', 'Do the headlights dim or a warning light come on while driving?'),
      yn('acc', 'Is there a dashcam, alarm or other accessory fitted?'),
    ],
    causes: [
      C('Battery has reached the end of its life', 0.1, [['age', ['old'], 0.5], ['age', ['mid'], 0.2], ['often', ['cold'], 0.15]]),
      C('Something drains the battery when parked', 0.1, [['often', ['daily'], 0.25], ['acc', ['yes'], 0.3]]),
      C('Alternator not charging', 0.05, [['dim', ['yes'], 0.45]]),
      C('Loose or corroded terminals', 0.05, [['age', ['new'], 0.2], ['often', ['once'], 0.1]]),
    ],
    safety: [],
    classify: [K('repair', 'age', ['old'], 'The battery is old and the charging system looks normal, so a battery test and replacement is the likely fix.', { when2: ['dim', ['no']] })],
  },
  {
    id: 'flat_tyre', label: 'Flat or low tyre', category: 'Tyres & wheels', areas: ['wheels'],
    keywords: ['tyre', 'tire', 'flat', 'puncture', 'pressure', 'burst', 'wheel'], service: 'tyres-wheels',
    names: { diagnostic: 'Tyre & wheel inspection', repair: 'Tyre puncture repair or replacement' },
    defaultClass: 'repair',
    questions: [
      Q('state', 'What is the tyre like?', [['flat', 'Completely flat'], ['low', 'Losing pressure slowly'], ['damage', 'Cut or bulge on the side']]),
      Q('spare', 'Do you have a usable spare wheel?', [['yes', 'Yes'], ['no', 'No']]),
      Q('where', 'Where is the vehicle?', [['safe', 'Parked in a safe place'], ['road', 'On the road or roadside']]),
    ],
    causes: [
      C('Puncture (nail or screw)', 0.3, [['state', ['low'], 0.3], ['state', ['flat'], 0.2]]),
      C('Valve or rim leak', 0.1, [['state', ['low'], 0.2]]),
      C('Tyre sidewall damage (needs replacement)', 0.05, [['state', ['damage'], 0.6]]),
    ],
    safety: [
      S('urgent', 'state', ['damage'], 'A cut or bulge on the sidewall can cause a blowout. Do not drive on it.'),
      S('urgent', 'where', ['road'], 'Stopped on the road is dangerous. Switch on the hazard lights, move everyone away from traffic and call roadside assistance.'),
    ],
    classify: [],
  },
  {
    id: 'tyre_vibration', label: 'Vibration or pulling to one side', category: 'Tyres & wheels', areas: ['wheels'],
    keywords: ['vibration', 'shake', 'pull', 'alignment', 'balancing', 'uneven wear', 'steering wheel'], service: 'tyres-wheels',
    names: { diagnostic: 'Wheel & tyre diagnostic inspection', repair: 'Wheel balancing & alignment' },
    questions: [
      Q('what', 'What do you notice?', [['vibrate', 'Steering wheel or seat shakes'], ['pull', 'Pulls to one side'], ['uneven', 'Uneven tyre wear']]),
      Q('speed', 'When does it happen?', [['all', 'At all speeds'], ['high', 'Mainly above about 80 km/h'], ['brake', 'Only when braking']]),
      Q('recent', 'Any recent pothole hit or tyre change?', [['pothole', 'Hit a pothole or kerb'], ['change', 'New tyres fitted recently'], ['none', 'Neither']]),
    ],
    causes: [
      C('Wheels need balancing', 0.1, [['what', ['vibrate'], 0.35], ['speed', ['high'], 0.3], ['recent', ['change'], 0.15]]),
      C('Wheel alignment is out', 0.1, [['what', ['pull'], 0.45], ['what', ['uneven'], 0.3], ['recent', ['pothole'], 0.2]]),
      C('Bent wheel or damaged tyre', 0.05, [['recent', ['pothole'], 0.3]]),
      C('Worn suspension or steering parts', 0.05, [['what', ['uneven'], 0.15]]),
      C('Warped brake discs', 0.03, [['speed', ['brake'], 0.5]]),
    ],
    safety: [],
    classify: [K('repair', 'what', ['vibrate'], 'Shaking at highway speed is most often a balancing issue, so a wheel balance and alignment check can be quoted directly.', { when2: ['speed', ['high']], and: ['recent', ['none', 'change']] })],
  },
  {
    id: 'suspension_noise', label: 'Clunking or rattling over bumps', category: 'Suspension & steering', areas: ['wheels', 'underbody'],
    keywords: ['clunk', 'rattle', 'bump', 'suspension', 'shock', 'creak', 'knock'], service: 'general-service',
    names: { diagnostic: 'Suspension diagnostic inspection' },
    questions: [
      Q('noise', 'What kind of noise?', [['clunk', 'Dull clunk or knock'], ['rattle', 'Rattling'], ['creak', 'Creaking or squeaking']]),
      Q('where', 'Where does it come from?', [['front', 'Front'], ['rear', 'Rear']]),
      yn('loose', 'Does the ride or steering feel loose or bouncy?'),
    ],
    causes: [
      C('Worn anti-roll-bar links or bushes', 0.1, [['noise', ['clunk'], 0.35], ['noise', ['creak'], 0.2]]),
      C('Worn shock absorbers', 0.1, [['loose', ['yes'], 0.3]]),
      C('Loose exhaust heat shield', 0.05, [['noise', ['rattle'], 0.35]]),
      C('Worn ball joint or track-rod end', 0.05, [['noise', ['clunk'], 0.2], ['loose', ['yes'], 0.2]]),
    ],
    safety: [S('warning', 'loose', ['yes'], 'A loose or bouncy feel can affect control. Avoid high speeds until it is checked.')],
    classify: [],
  },
  {
    id: 'steering_issue', label: 'Steering heavy, loose or noisy', category: 'Suspension & steering', areas: ['wheels', 'engine_bay', 'cabin'],
    keywords: ['steering', 'heavy', 'loose', 'whine', 'power steering', 'wheel play'], service: 'general-service',
    names: { diagnostic: 'Steering system diagnostic inspection' },
    questions: [
      Q('problem', 'What is the problem?', [['heavy', 'Heavy to turn'], ['loose', 'Loose, with free play'], ['noise', 'Whining or groaning when turning'], ['vib', 'Vibration through the wheel']]),
      Q('when', 'When does it happen?', [['low', 'At low speed or parking'], ['all', 'At all speeds']]),
      yn('fluid', 'Is the power-steering fluid low or leaking?'),
    ],
    causes: [
      C('Low power-steering fluid or a leak', 0.05, [['problem', ['noise'], 0.3], ['fluid', ['yes'], 0.4]]),
      C('Power-steering pump or electric steering fault', 0.1, [['problem', ['heavy'], 0.35]]),
      C('Worn track-rod ends or steering joints', 0.1, [['problem', ['loose'], 0.4]]),
      C('Slipping drive belt', 0.05, [['problem', ['noise'], 0.15], ['when', ['low'], 0.1]]),
    ],
    safety: [
      S('warning', 'problem', ['loose', 'heavy'], 'Steering faults reduce control. Drive slowly and have it inspected soon.'),
    ],
    classify: [],
  },
  {
    id: 'gearbox', label: 'Gearbox or clutch problem', category: 'Transmission', areas: ['engine_bay', 'underbody', 'cabin'],
    keywords: ['gear', 'clutch', 'transmission', 'gearbox', 'slip', 'shift', 'automatic', 'manual'], service: 'general-service',
    names: { diagnostic: 'Transmission diagnostic inspection' },
    questions: [
      Q('type', 'What is wrong?', [['auto', 'Automatic shifts harshly or slips'], ['hard', 'Hard to change gears'], ['slip', 'Clutch slips or revs rise without speed'], ['noise', 'Whining or grinding in gear']]),
      yn('fluid', 'Any red or brown fluid under the car, or a burnt smell?'),
    ],
    causes: [
      C('Low or old transmission fluid', 0.1, [['fluid', ['yes'], 0.35], ['type', ['auto'], 0.15]]),
      C('Worn clutch', 0.05, [['type', ['slip'], 0.5], ['type', ['hard'], 0.2]]),
      C('Shift solenoid or sensor fault', 0.05, [['type', ['auto'], 0.3]]),
      C('Gearbox bearing wear', 0.03, [['type', ['noise'], 0.45]]),
    ],
    safety: [],
    classify: [],
  },
  {
    id: 'lights_electrical', label: 'Light or electrical item not working', category: 'Lights & electrical', areas: ['lights_body', 'cabin', 'doors_glass'],
    keywords: ['light', 'bulb', 'headlight', 'indicator', 'fuse', 'horn', 'window', 'wiper', 'central locking'], service: 'general-service',
    names: { diagnostic: 'Electrical diagnostic inspection', repair: 'Bulb or fuse replacement' },
    questions: [
      Q('what', 'What is not working?', [['head', 'Headlight'], ['tail', 'Tail or brake light'], ['ind', 'Indicator'], ['int', 'Window, central locking, horn or wipers']]),
      Q('count', 'How many items are affected?', [['one', 'Just one'], ['several', 'Several at once']]),
    ],
    causes: [
      C('Blown bulb', 0.1, [['count', ['one'], 0.45], ['what', ['head', 'tail', 'ind'], 0.1]]),
      C('Blown fuse or relay', 0.1, [['count', ['several'], 0.4]]),
      C('Wiring or connector fault', 0.05, [['count', ['several'], 0.2]]),
      C('Faulty switch or motor', 0.05, [['what', ['int'], 0.35]]),
    ],
    safety: [S('warning', 'what', ['tail', 'head'], 'Other drivers may not see you or your brake lights. Avoid night driving until it is fixed.')],
    classify: [K('repair', 'count', ['one'], 'A single failed light is usually a bulb, so a replacement can be quoted directly.', { when2: ['what', ['head', 'tail', 'ind']] })],
  },
  {
    id: 'install_part', label: 'I have a part I want fitted', category: 'Installation', areas: AREAS.map((a) => a.id),
    keywords: ['install', 'fit', 'fitting', 'replace', 'bought', 'part', 'my own part', 'new battery', 'new tyres'], service: 'general-service',
    names: { diagnostic: 'Diagnostic inspection before fitting a part', installation: 'Part installation (customer-supplied part)' },
    defaultClass: 'installation',
    questions: [
      Q('part', 'Which part do you want fitted?', [
        ['battery', 'Battery', { service: 'battery-replacement' }], ['tyres', 'Tyres or wheels', { service: 'tyres-wheels' }],
        ['brake', 'Brake pads or discs', { service: 'brake-service' }], ['ac', 'Air-conditioning part', { service: 'ac-service' }],
        ['filters', 'Oil or air filters', { service: 'oil-change' }], ['other', 'Another part', { service: 'general-service' }],
      ]),
      Q('sure', 'Do you know this part is the right fix?', [['sure', 'Yes, a mechanic or workshop told me'], ['guess', 'I think so'], ['no', 'Not sure']]),
      yn('fits', 'Is the part for your exact vehicle model and year?'),
    ],
    causes: [],
    safety: [],
    classify: [
      K('diagnostic', 'sure', ['no'], 'You are not sure this part is the right fix, so an inspection first avoids paying to fit a part that does not solve the problem.'),
      K('diagnostic', 'fits', ['no'], 'The part may not match your vehicle, so a mechanic should confirm what is needed before fitting anything.'),
    ],
  },
  {
    id: 'other', label: 'Something else', category: 'Other', areas: AREAS.map((a) => a.id),
    keywords: ['other', 'something else', 'unknown', 'noise', 'smell', 'not sure'], service: 'general-service',
    names: { diagnostic: 'General diagnostic inspection' },
    questions: [
      Q('what', 'How would you describe it?', [['noise', 'An unusual noise'], ['smell', 'An unusual smell'], ['vibe', 'A vibration'], ['perf', 'Poor performance or fuel economy'], ['elec', 'An electrical glitch']]),
      Q('when', 'When does it happen?', [['always', 'All the time'], ['start', 'When starting'], ['drive', 'While driving'], ['stop', 'When stopping or turning']]),
    ],
    causes: [],
    safety: [S('warning', 'what', ['smell'], 'An unusual smell can be a sign of an electrical, fuel or fluid problem. If it is a burning or fuel smell, stop driving.')],
    classify: [],
  },
];

const BY_ID = Object.fromEntries(SYMPTOMS.map((s) => [s.id, s]));
const AREA_BY_ID = Object.fromEntries(AREAS.map((a) => [a.id, a]));
const UNSURE = { id: 'unsure', label: 'Not sure' };

/* ---------------- public helpers ---------------- */
const catalog = () => ({
  areas: AREAS,
  classes: CLASSES,
  symptoms: SYMPTOMS.map((s) => ({ id: s.id, label: s.label, category: s.category, areas: s.areas, keywords: s.keywords })),
});

const withUnsure = (q) => ({ ...q, options: [...q.options.map(({ id, label }) => ({ id, label })), UNSURE] });
const symptomQuestions = (id) => {
  const s = BY_ID[id];
  if (!s) throw new ApiError(404, 'Unknown symptom');
  return { id: s.id, label: s.label, category: s.category, questions: s.questions.map(withUnsure) };
};

const nameFor = (symptomId, cls) => {
  const s = BY_ID[symptomId];
  if (!s) return cls === 'installation' ? 'Part installation' : cls === 'repair' ? 'Repair' : 'Diagnostic inspection';
  return s.names?.[cls] || (cls === 'diagnostic' ? `${s.label} diagnostic inspection` : cls === 'installation' ? 'Part installation' : `${s.label} repair`);
};

const matches = (answers, q, opts) => !!q && Array.isArray(opts) && opts.includes(answers[q]);
const levelOf = (score) => (score >= 0.5 ? 'likely' : score >= 0.3 ? 'possible' : 'less likely');

/**
 * evaluate({ symptomId, areaId, answers: { questionId: optionId } })
 * Every question must be answered ("Not sure" counts). Throws ApiError(400) for an invalid combination.
 */
function evaluate({ symptomId, areaId, answers = {} }) {
  const s = BY_ID[symptomId];
  if (!s) throw new ApiError(400, 'Choose a symptom');
  const area = areaId ? AREA_BY_ID[areaId] : null;
  if (areaId && !area) throw new ApiError(400, 'Unknown vehicle area');

  const readable = [];
  for (const q of s.questions) {
    const a = answers[q.id];
    if (!a) throw new ApiError(400, `Please answer: ${q.text}`);
    const opt = a === 'unsure' ? UNSURE : q.options.find((o) => o.id === a);
    if (!opt) throw new ApiError(400, `Invalid answer for: ${q.text}`);
    readable.push({ question: q.text, answer: opt.label });
  }

  /* possible causes (ranked, never a confirmed diagnosis) */
  const scored = s.causes
    .map((c) => ({ label: c.label, score: Math.min(0.95, c.base + c.rules.reduce((sum, [q, opts, w]) => sum + (matches(answers, q, opts) ? w : 0), 0)) }))
    .sort((a, b) => b.score - a.score);
  let causes = scored.filter((c) => c.score >= 0.15).slice(0, 4);
  if (causes.length < 2) causes = scored.slice(0, 2);
  causes = causes.map((c) => ({ label: c.label, level: levelOf(c.score) }));

  /* safety screening */
  const messages = [];
  let level = 'none';
  const raise = (l, msg) => {
    if (msg && !messages.includes(msg)) messages.push(msg);
    if (l === 'urgent' || (l === 'warning' && level === 'none')) level = l;
  };
  if (s.baseSafety) raise(s.baseSafety.level, s.baseSafety.message);
  s.safety.forEach((r) => matches(answers, r.q, r.opts) && raise(r.level, r.message));
  const advice = level === 'urgent' ? URGENT_ADVICE : level === 'warning' ? WARNING_ADVICE : '';

  /* service classification: diagnostic inspection vs repair vs installation */
  let cls = s.defaultClass || 'diagnostic';
  let reason = cls === 'diagnostic'
    ? 'Several things can cause this, so a mechanic should find the real cause first instead of replacing parts by guesswork.'
    : cls === 'repair' ? 'This is a well-understood problem, so the mechanic can quote the repair directly.' : 'A mechanic fits the part you provide.';
  let service = s.service;
  const chosen = s.questions.flatMap((q) => q.options.filter((o) => o.id === answers[q.id] && o.service));
  if (chosen.length) service = chosen[0].service;
  for (const r of s.classify) {
    const ok = matches(answers, r.q, r.opts) && (!r.when2 || matches(answers, r.when2[0], r.when2[1])) && (!r.and || matches(answers, r.and[0], r.and[1]));
    if (ok) {
      cls = r.as;
      reason = r.reason;
      if (r.service) service = r.service;
      break;
    }
  }
  if (level === 'urgent' && cls === 'repair') {
    cls = 'diagnostic'; // an unsafe vehicle is inspected first, never quoted blind
    reason = 'There is a safety concern, so a mechanic should inspect the vehicle before any repair is quoted.';
  }

  const serviceName = nameFor(s.id, cls);
  const summary = [
    area ? `Problem area: ${area.label}` : null,
    `Reported problem: ${s.label}`,
    ...readable.map((r) => `- ${r.question} ${r.answer}`),
    causes.length ? `Possible causes (not confirmed): ${causes.map((c) => `${c.label} (${c.level})`).join('; ')}` : null,
    `Recommended: ${serviceName} [${CLASSES[cls].label}]`,
    level !== 'none' ? `Safety: ${level.toUpperCase()}. ${messages.join(' ')}` : null,
  ].filter(Boolean).join('\n');

  return {
    symptom: { id: s.id, label: s.label, category: s.category },
    area: area ? { id: area.id, label: area.label } : null,
    answers: readable,
    causes,
    safety: { level, messages, advice },
    classification: cls,
    classificationLabel: CLASSES[cls].label,
    classificationReason: reason,
    service,
    serviceName,
    summary,
  };
}

module.exports = { AREAS, CLASSES, SYMPTOMS, catalog, symptomQuestions, evaluate, nameFor };