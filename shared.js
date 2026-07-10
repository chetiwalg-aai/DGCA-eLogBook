/**
 * shared.js
 */
(function () {
  'use strict';

  const COL = {
    PAGE_IDX: 0, DATE: 1, STATION: 2, ATS_UNIT: 3,
    CTIME_FROM: 4, CTIME_TO: 5, CTIME_TOTAL: 6,
    PNAME: 7, PTIME_FROM: 8, PTIME_TO: 9, PTIME_TOTAL: 10,
    TNAME: 11, TTIME_FROM: 12, TTIME_TO: 13, TTIME_TOTAL: 14,
    NAME_OJTI: 15, OTIME_FROM: 16, OTIME_TO: 17, OTIME_TOTAL: 18,
    OPTIME_FROM: 19, OPTIME_TO: 20, OPTIME_TOTAL: 21,
    NO_DAYS: 22, SIGNATURE: 23, REMARKS: 24,
  };

  const DUTY_TYPE = {
    CONTROLLING: 'controlling',
    OJT_INSTR_PRACTICAL: 'ojt_instr_practical',    // Instructor: Providing OJT/Simulation
    OJT_INSTR_THEORY: 'ojt_instr_theory',       // Instructor: Theory Instruction (Knowledge)
    OJT_TRAINING_THEORY: 'ojt_training_theory',    // Trainee: Theory/Classroom sessions
    OJT_TRAINING_PRACTICAL: 'ojt_training_practical', // Trainee: OJT/Simulation
    SKILL_ASSESSMENT: 'skill_assessment',       // Trainee: Skill Assessment Board (Skill Test)
    EXAMINER_SKILL_TEST: 'examiner_skill_test',    // Examiner: Skill Test
    EXAMINER_PROF_CHECK: 'examiner_prof_check',    // Examiner: Proficiency Check
    EXAMINER_KNOWLEDGE: 'examiner_knowledge',     // Examiner: Knowledge
  };

  const STATION_MAP = {
    'VIJP': '100069',
    // Add new stations here: 'VIDP': '100XXX',
  };

  const RATING_MAP = {
    'ADC': '8000310',
    'APP': '8000311', //Change to 311
    'APP(P)': '8000311',
    'APP(S)': '8000312',
    'ACC(P)': '8000313',
    'ACC': '8000313',
    'ACC(S)': '8000314',
    'APP(P&S)': '8000501',
  };

  const WSO_MAP = {
    'VIJP': {
      WSO: 'OAAIM20210000010242',  // vijpwso
      ATS: 'OAAIM20210000010111',  // VIJP_ATS
      labelWSO: 'vijpwso',
      labelATS: 'VIJP_ATS',
    },
    // 'VIDP': {
    //   WSO:      'OAAIM20210000XXXXXX',
    //   ATS:      'OAAIM20210000YYYYYY',
    //   labelWSO: 'vidpwso',
    //   labelATS: 'VIDP_ATS',
    // },
  };

  const STATION_ATS_UNIT_MAP = {
    'VIJP': {
      'ADC_SMC_CLD': 'ADC1',
      'TWR': 'ADC2',
      'SMC_CLD': 'ADC3',
      'ACC(S)': 'ACC(s)1',
      'ACC': 'ACC1',
      'APP_APP(S)': 'APP(ps)1',
      'APP(S)': 'APP(s)1',
      'APP': 'APP1',
    },
    // 'VIDP': {
    //   'ADC': 'ADC1',
    //   'APP': 'APP1',
    //   'ACC': 'ACC1',
    // },
  };

  const ATS_UNIT_MAP = STATION_ATS_UNIT_MAP['VIJP'];

  const TYPE_OF_DUTY_MAP = {
    [DUTY_TYPE.CONTROLLING]: '1',
    [DUTY_TYPE.OJT_INSTR_PRACTICAL]: '2',  // Instruction (OJT Provided)
    [DUTY_TYPE.OJT_INSTR_THEORY]: '2',  // Instruction + Knowledge
    [DUTY_TYPE.OJT_TRAINING_PRACTICAL]: '3',  // OJT Training
    [DUTY_TYPE.OJT_TRAINING_THEORY]: '5',  // Classroom Theory
    [DUTY_TYPE.SKILL_ASSESSMENT]: '6',  // Skill Test (portal value=6)
    [DUTY_TYPE.EXAMINER_SKILL_TEST]: '4',  // Examiner Functions (duty=4; tick Skill Test checkbox)
    [DUTY_TYPE.EXAMINER_PROF_CHECK]: '4',  // Examiner Functions (duty=4; tick Proficiency Check checkbox)
    [DUTY_TYPE.EXAMINER_KNOWLEDGE]: '4',  // Examiner Functions (duty=4; tick Knowledge checkbox)
  };

  const INSTRUCTOR_ATCOL_MAP = {
    'charan singh': '02647',
    'shivram meena': '00706',
    'mukesh chouhan': '00707',
    'sanjeev agrawal': '00660',
    'sanjay kumar gupta': '00710',
    'virendra kumar singhal': '00128',
    'vishweshar dayal meena': '01659',
    'sugar singh meena': '01352',
    'arvind kumar': '00711',
    'kunji lal meena': '01238',
    'dharmendra kumar meena': '00712',
    'vivek mahajan': '00713',
    'suresh kumar pareek': '00714',
    'krishan mohan sharma': '02360',
    'yogesh kumar jain': '00715',
    'rajesh kumar': '00716',
    'shailndra singh asawat': '00668',
    'sakil pal meena': '02547',
    'suruchi kaushik': '00717',
    'sandeep kumar singh': '03175',
    'tarun kumar': '02550',
    'tirupati choudhary': '01658',
    'sumit mathur': '01383',
    'anuradha sulaniya': '01654',
    'julie sandeep singh': '03547',
    'mukesh kumar sharma': '00200',
    'subhash chander bhardwaj': '01955',
    'deepak agrawal': '02356',
    'raghunath singh': '00718',
    'deepak kumar bageria': '01653',
    'amit srivastava': '00719',
    'rajendra kumar': '00926',
    'deepak kumar meena': '03902',
    'dinesh meena': '02355',
    'ravi meena': '00303',
    'rahul joshi': '03927',
    'sanjay rakhecha': '01849',
    'hitesh bijoliya': '02793',
    'amit kanjoliya': '01860',
    'saroj meena': '01727',
    'deshraj': '02022',
    'mahendra verma': '00671',
    'atul kaswa': '01864',
    'utkarsh agrawal': '01722',
    'sumit kumar': '00685',
    'manoj singh pachera': '01790',
    'komal singh': '01448',
    'manjeet yadav': '02445',
    'meghana kumari parsanidya': '00692',
    'arvind verma': '01291',
    'pawan singh': '01564',
    'jai lakhiani': '01665',
    'tripti gupta': '00727',
    'om prakash sihag': '00729',
    'ajay kumar meena': '01666',
    'praveen kumar jinjawadiya': '03062',
    'jaid mohammad': '02695',
    'bhupender': '03213',
    'ranu goyal': '03639',
    'pradeep kumar': '03446',
    'aditya bhatt': '03886',
    'manvi gupta': '03882',
    'sakshi agarwal': '03919',
    'prerna saini': '03918',
    'aayush marmat': '03792',
    'gaurav chetiwal': '03757',
    'bhawani shankar bunkar': '03917',
    'rahul meena': '03938',
    'satender': '01135',
    'kartik lamba': '01217',
    'chetan sharma': '01191',
    'alka dubey': '00413',
    'deepak saini': '01976',
    'devendra kumar patodiya': '00772',
  };

  const ROW_STATUS = {
    PENDING: 'pending',
    FILLING: 'filling',
    SUBMITTED: 'submitted',
    ERROR: 'error',
    SKIPPED: 'skipped',
  };

  /**
   * Resolve the portal ATS Unit dropdown value from the raw remarks/atsUnit
   * text in the AAI logbook row.
   *
   * @param {string} remarksText  Raw ATS_UNIT or REMARKS cell text.
   * @param {string} [stationCode='VIJP']  ICAO station code — selects the
   *   right per-station map from STATION_ATS_UNIT_MAP.
   * @returns {string} Portal option value (e.g. 'ADC1', 'APP1').
   */
  function resolveAtsUnit(remarksText, stationCode) {
    const r = String(remarksText || '').trim().toUpperCase();

    const stCode = String(stationCode || 'VIJP').trim().toUpperCase();
    const map = STATION_ATS_UNIT_MAP[stCode] || STATION_ATS_UNIT_MAP['VIJP'];

    // Walk the map's own keys in defined order and use includes() for each.
    // includes() naturally covers the exact-match case too (r === key implies
    // r.includes(key)), and also covers a 'MOD_' prefix (e.g. 'MOD_ADC1')
    // without needing to slice it off first — so no separate exact-match
    // step or manual substring ordering is needed; the map's own key order
    // is the priority order (more specific keys should simply be defined
    // earlier in STATION_ATS_UNIT_MAP for a given station).
    for (const key of Object.keys(map)) {
      if (r.includes(key)) return map[key];
    }

    // Return first value in the map as station-specific default
    const firstVal = Object.values(map)[0];
    return firstVal || 'ADC1';
  }

  /**
   * Whether the row's remarks/ATS-unit text marks this as a Simulator entry.
   * Remarks can carry 'SIM' and 'MOD_' independently or combined
   * (e.g. 'SIM', 'MOD_ADC1', 'MOD_SIM') — this just checks for 'SIM' anywhere
   * in the text, regardless of a MOD_ prefix.
   *
   * @param {string} remarksText  Raw ATS_UNIT or REMARKS cell text.
   * @returns {boolean}
   */
  function isSimEntry(remarksText) {
    return String(remarksText || '').trim().toUpperCase().includes('SIM');
  }

  /**
   * Resolve the OJT Environment dropdown value (#ojtOprEnvSmlation) from the
   * raw remarks/atsUnit text in the AAI logbook row.
   *
   * @param {string} remarksText  Raw ATS_UNIT or REMARKS cell text.
   * @returns {string} 'Simulation' or 'Operational Environment'.
   */
  function resolveOjtEnv(remarksText) {
    return isSimEntry(remarksText) ? 'Simulation' : 'Operational Environment';
  }

  function getStationValue(code) {
    return STATION_MAP[String(code || '').trim().toUpperCase()] || '100069';
  }
  function getRatingValue(atsUnit) {
    return RATING_MAP[String(atsUnit || '').trim().toUpperCase()] || '8000310';
  }

  /**
   * Get WSO/EGCA ID for a station.
   * @param {string} code  Station code (e.g. 'VIJP')
   * @param {boolean} useAts  If true, return VIJP_ATS; else return vijpwso
   */
  function getWsoValue(code, useAts = false) {
    const entry = WSO_MAP[String(code || '').trim().toUpperCase()];
    if (!entry) return 'OAAIM20210000010242';
    return useAts ? entry.ATS : entry.WSO;
  }

  function getTypeOfDuty(dutyType) {
    return TYPE_OF_DUTY_MAP[dutyType] || '1';
  }
  function getAtcol(name) {
    if (!name) return '';
    return INSTRUCTOR_ATCOL_MAP[String(name).trim().toLowerCase()] || '';
  }

  function parseDateDMY(dateStr) {
    const [d, m, y] = String(dateStr).trim().split('-').map(Number);
    return { d, m, y };
  }
  function formatDDMMYYYY(d, m, y) {
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  }
  function addOneDay(d, m, y) {
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + 1);
    return { d: date.getDate(), m: date.getMonth() + 1, y: date.getFullYear() };
  }
  function normaliseTime(t) {
    if (!t || t === 'null') return '';
    const s = String(t).trim().split('.')[0];
    if (!s) return '';
    if (s.includes(':')) {
      const [h, mi] = s.split(':');
      return `${String(parseInt(h, 10)).padStart(2, '0')}:${String(parseInt(mi, 10)).padStart(2, '0')}`;
    }
    if (/^\d+$/.test(s)) {
      const val = parseInt(s, 10);
      return `${String(Math.floor(val / 60)).padStart(2, '0')}:${String(val % 60).padStart(2, '0')}`;
    }
    return s;
  }
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  window.__DGCA__ = {
    COL, DUTY_TYPE, ROW_STATUS,
    STATION_MAP, RATING_MAP, WSO_MAP, ATS_UNIT_MAP, STATION_ATS_UNIT_MAP,
    TYPE_OF_DUTY_MAP, INSTRUCTOR_ATCOL_MAP,
    resolveAtsUnit, resolveOjtEnv, isSimEntry, getStationValue, getRatingValue, getWsoValue,
    getTypeOfDuty, getAtcol,
    parseDateDMY, formatDDMMYYYY, addOneDay, normaliseTime, sleep,
  };
})();