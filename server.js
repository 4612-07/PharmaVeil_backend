/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  PharmaVeil — Backend API (fichier unique)                       ║
 * ║  Version 1.0.0 — pharmaveil.eu                                   ║
 * ║                                                                  ║
 * ║  Stack : Node.js + Express + sql.js + Claude API (Anthropic)     ║
 * ║  Deploy: Railway (npm start) ou local (node server.js)           ║
 * ║                                                                  ║
 * ║  Variables d'environnement requises (.env) :                     ║
 * ║    ANTHROPIC_API_KEY  — clé API Anthropic                        ║
 * ║    PORT               — port HTTP (défaut: 3001)                 ║
 * ║    NODE_ENV           — development | production                 ║
 * ║    DB_PATH            — chemin SQLite (défaut: ./pharmaveil.db)  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Routes disponibles :
 *   GET  /health
 *   POST /api/cases/intake          (email | form | manual)
 *   POST /api/cases/intake/pdf      (upload fichier PDF)
 *   GET  /api/cases                 (liste paginée)
 *   GET  /api/cases/:id             (détail cas)
 *   PATCH /api/cases/:id/validate   (validation humaine)
 *   GET  /api/cases/:id/meddra      (lookup MedDRA)
 *   GET  /api/cases/:id/export/pdf  (CIOMS I PDF)
 *   GET  /api/cases/:id/export/e2b  (E2B R3 XML)
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
//  0. DÉPENDANCES
// ═══════════════════════════════════════════════════════════════════

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const multer    = require('multer');
const pdfParse  = require('pdf-parse');
const PDFDoc    = require('pdfkit');
const { z }     = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

// ═══════════════════════════════════════════════════════════════════
//  1. BASE DE DONNÉES (sql.js — SQLite pur JS)
// ═══════════════════════════════════════════════════════════════════

const DB_PATH = path.resolve(process.env.DB_PATH || './pharmaveil.db');
let _db = null;

async function getDb() {
  if (_db) return _db;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
    _initSchema(_db);
    _saveDb();
  }
  return _db;
}

function _saveDb() {
  if (!_db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

function _initSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS icsr_cases (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'pending_validation',
      source_type TEXT NOT NULL,
      raw_content TEXT,
      received_at TEXT NOT NULL,
      deadline_7 TEXT, deadline_15 TEXT, deadline_90 TEXT,
      seriousness TEXT,
      report_type TEXT NOT NULL DEFAULT 'spontaneous',
      reporter_qualification TEXT,
      duplicate_flag INTEGER DEFAULT 0,
      processed_at TEXT, validated_at TEXT, validated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS extracted_fields (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL UNIQUE,
      patient_age TEXT, patient_sex TEXT, patient_weight TEXT,
      reporter_name TEXT, reporter_type TEXT, reporter_country TEXT,
      drug_name TEXT, drug_dose TEXT, drug_route TEXT, drug_start_date TEXT,
      adr_description TEXT, adr_onset_date TEXT, adr_outcome TEXT,
      seriousness TEXT,
      meddra_search_term TEXT, meddra_pt_code TEXT, meddra_pt_name TEXT,
      meddra_llt_code TEXT, meddra_llt_name TEXT,
      narrative TEXT,
      suspect_drugs TEXT,
      confidence_score REAL DEFAULT 0,
      confidence_flag TEXT DEFAULT 'red',
      raw_llm_output TEXT,
      gvp_valid INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES icsr_cases(id)
    );
    CREATE TABLE IF NOT EXISTS validation_audit (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      field_changed TEXT, old_value TEXT, new_value TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      trigger_at TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meddra_terms (
      id TEXT PRIMARY KEY,
      pt_code TEXT NOT NULL, pt_name TEXT NOT NULL,
      llt_code TEXT NOT NULL UNIQUE, llt_name TEXT NOT NULL,
      soc_name TEXT NOT NULL, soc_code TEXT NOT NULL,
      hlt_name TEXT,
      pt_name_lower TEXT, llt_name_lower TEXT,
      ime_flag INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pt_lower  ON meddra_terms(pt_name_lower);
    CREATE INDEX IF NOT EXISTS idx_llt_lower ON meddra_terms(llt_name_lower);
    CREATE INDEX IF NOT EXISTS idx_ime ON meddra_terms(ime_flag);
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      mode TEXT NOT NULL DEFAULT 'export_xml',
      authority TEXT DEFAULT 'EMA',
      user_id TEXT,
      file_hash TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      ack_status TEXT DEFAULT NULL,
      version INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES icsr_cases(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sub_case  ON submissions(case_id);
    CREATE INDEX IF NOT EXISTS idx_sub_org   ON submissions(org_id);
    CREATE INDEX IF NOT EXISTS idx_sub_date  ON submissions(created_at);
  `);
  _seedMeddra(db);
}

// ─── Migration: ajouter table submissions si absente (upgrade) ─────────────
async function _migrateSubmissions() {
  const db = await getDb();
  try {
    db.run(`CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      mode TEXT NOT NULL DEFAULT 'export_xml',
      authority TEXT DEFAULT 'EMA',
      user_id TEXT,
      file_hash TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      ack_status TEXT DEFAULT NULL,
      version INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL
    )`);
    try { db.run('CREATE INDEX IF NOT EXISTS idx_sub_case ON submissions(case_id)'); } catch {}
    try { db.run('CREATE INDEX IF NOT EXISTS idx_sub_org  ON submissions(org_id)');  } catch {}
    _saveDb();
    console.log('[MIGRATIONS] submissions table OK');
  } catch (err) { console.warn('[MIGRATIONS] submissions:', err.message); }
}
_migrateSubmissions();



function _seedMeddra(db) {
  const terms = [
    ['10028813','Nausea',              '10028817','Nausea',                    'Gastrointestinal disorders',                    'GI01','Nausea and vomiting symptoms'],
    ['10047700','Vomiting',            '10047700','Vomiting',                  'Gastrointestinal disorders',                    'GI01','Nausea and vomiting symptoms'],
    ['10013946','Diarrhoea',           '10012727','Diarrhea',                  'Gastrointestinal disorders',                    'GI01','Diarrhoea NEC'],
    ['10000060','Abdominal pain',      '10000060','Abdominal pain',            'Gastrointestinal disorders',                    'GI01','GI signs and symptoms'],
    ['10037087','Rash',                '10037087','Rash',                      'Skin and subcutaneous tissue disorders',         'SK01','Rashes NEC'],
    ['10011224','Dermatitis allergic', '10011224','Allergic dermatitis',       'Skin and subcutaneous tissue disorders',         'SK01','Dermatitis'],
    ['10019211','Urticaria',           '10019211','Urticaria',                 'Skin and subcutaneous tissue disorders',         'SK01','Urticarias'],
    ['10002198','Angioedema',          '10002198','Angioedema',                'Skin and subcutaneous tissue disorders',         'SK01','Angioedemas'],
    ['10061592','Atrial fibrillation', '10061592','Atrial fibrillation',       'Cardiac disorders',                             'CA01','Supraventricular arrhythmias'],
    ['10019280','Hypertension',        '10020772','Hypertension',              'Vascular disorders',                            'VA01','Vascular hypertensive disorders'],
    ['10019524','Hypotension',         '10021097','Hypotension',               'Vascular disorders',                            'VA01','Vascular hypotensive disorders'],
    ['10006093','Bradycardia',         '10006093','Bradycardia',               'Cardiac disorders',                             'CA01','Rate and rhythm disorders NEC'],
    ['10040639','Tachycardia',         '10040639','Tachycardia',               'Cardiac disorders',                             'CA01','Rate and rhythm disorders NEC'],
    ['10019461','Headache',            '10019461','Headache',                  'Nervous system disorders',                      'NS01','Headaches'],
    ['10013573','Dizziness',           '10013573','Dizziness',                 'Nervous system disorders',                      'NS01','Neurological signs and symptoms'],
    ['10015832','Fatigue',             '10015832','Fatigue',                   'General disorders',                             'GE01','Asthenic conditions'],
    ['10044565','Tremor',              '10044565','Tremor',                    'Nervous system disorders',                      'NS01','Movement disorders'],
    ['10010874','Confusional state',   '10010881','Confusional state',         'Psychiatric disorders',                         'PS01','Deliria'],
    ['10013968','Dyspnoea',            '10013968','Dyspnoea',                  'Respiratory disorders',                         'RE01','Breathing abnormalities'],
    ['10011224','Cough',               '10058234','Cough',                     'Respiratory disorders',                         'RE01','Coughing symptoms'],
    ['10028461','Pulmonary embolism',  '10037377','Pulmonary embolism',        'Vascular disorders',                            'VA01','Embolic events'],
    ['10019150','Haematoma',           '10019150','Haematoma',                 'Injury and procedural complications',           'IN01','Injuries NEC'],
    ['10018873','Haemorrhage',         '10018873','Haemorrhage',               'Vascular disorders',                            'VA01','Haemorrhages NEC'],
    ['10037549','Anaemia',             '10002272','Anemia',                    'Blood and lymphatic system disorders',           'BL01','Anaemias NEC'],
    ['10023439','Lactic acidosis',     '10023439','Lactic acidosis',           'Metabolism and nutrition disorders',             'ME01','Acidosis'],
    ['10019692','Hepatitis',           '10019692','Hepatitis',                 'Hepatobiliary disorders',                       'HE01','Hepatitis NEC'],
    ['10038435','Renal failure',       '10038435','Renal failure',             'Renal and urinary disorders',                   'RN01','Renal failure'],
    ['10002218','Anaphylactic reaction','10002198','Anaphylaxis',              'Immune system disorders',                       'IM01','Allergic conditions NEC'],
    ['10020751','Hypersensitivity',    '10020751','Hypersensitivity',          'Immune system disorders',                       'IM01','Allergic conditions NEC'],
    ['10048580','INR increased',       '10048580','INR increased',             'Investigations',                                'IV01','Coagulation investigations'],
    ['10033371','Pain',                '10033371','Pain',                      'General disorders',                             'GE01','Pain NEC'],
    ['10066354','Gastrointestinal haemorrhage','10066354','GI bleeding',       'Gastrointestinal disorders',                    'GI01','GI haemorrhages NEC'],
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO meddra_terms
      (id, pt_code, pt_name, llt_code, llt_name, soc_name, soc_code, hlt_name, pt_name_lower, llt_name_lower)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const seen = new Set();
  for (const [ptc,ptn,lltc,lltn,soc,socc,hlt] of terms) {
    if (seen.has(lltc)) continue;
    seen.add(lltc);
    stmt.run([crypto.randomUUID(), ptc, ptn, lltc, lltn, soc, socc, hlt, ptn.toLowerCase(), lltn.toLowerCase()]);
  }
  stmt.free();
  _seedImeList(db);
}

// ─── IME List EMA (Important Medical Events) ─────────────────────────────────

function _seedImeList(db) {
  // EMA IME List v27.0 — subset des termes les plus critiques
  // Source : https://www.ema.europa.eu/en/human-regulatory/post-authorisation/pharmacovigilance/eudravigilance/important-medical-event-terms-list
  const imePtCodes = [
    '10000381','10000567','10001367','10001551','10001718','10002026','10002218',
    '10002855','10003011','10003030','10003550','10003564','10003735','10004002',
    '10004055','10004468','10005184','10005187','10005261','10005364','10005543',
    '10006093','10006482','10006585','10007052','10007200','10007559','10007785',
    '10007900','10008111','10008145','10008190','10009192','10009253','10009802',
    '10010276','10010468','10010628','10010730','10010741','10010827','10010915',
    '10011006','10011033','10011224','10011460','10011762','10012174','10012218',
    '10012305','10012378','10012735','10013034','10013442','10013573','10013900',
    '10013968','10014082','10014199','10014523','10014617','10014625','10014698',
    '10015090','10015150','10015218','10015277','10015832','10016512','10016782',
    '10017533','10017636','10017947','10018043','10018044','10018065','10018220',
    '10018293','10018295','10018550','10018873','10019047','10019150','10019211',
    '10019280','10019524','10019692','10019755','10019799','10019855','10020100',
    '10020112','10020425','10020580','10020631','10020659','10020751','10020803',
    '10020850','10021097','10021137','10021143','10021151','10021881','10022298',
    '10022595','10023198','10023215','10023439','10023567','10023848','10024119',
    '10024378','10024866','10025233','10026749','10027175','10027433','10027656',
    '10028080','10028130','10028461','10028524','10028596','10028813','10029240',
    '10029370','10029603','10030302','10030708','10030813','10031264','10031282',
    '10031528','10031579','10031801','10032240','10032310','10033371','10033425',
    '10033547','10033620','10033677','10034295','10034580','10034836','10034989',
    '10035020','10035087','10035523','10036402','10036444','10037087','10037175',
    '10037198','10037549','10038359','10038435','10038738','10038748','10039003',
    '10039069','10039087','10039101','10039509','10039628','10040583','10040639',
    '10041244','10041633','10041633','10042033','10042434','10042545','10042772',
    '10043458','10043890','10044177','10044565','10044583','10044688','10045065',
    '10046306','10046914','10047025','10047115','10047228','10047700','10048294',
    '10048461','10048545','10048580','10049100','10049441','10050068','10051592',
    '10052015','10052109','10053467','10053565','10055599','10058084','10059094',
    '10061192','10061592','10062268','10065773','10066354',
    // PTs présents dans notre seed MedDRA
    '10028813','10047700','10013946','10000060','10037087','10011224','10019211',
    '10002198','10061592','10019280','10019524','10006093','10040639','10019461',
    '10013573','10015832','10044565','10010874','10013968','10028461','10019150',
    '10018873','10037549','10023439','10019692','10038435','10002218','10020751',
    '10048580','10033371','10066354',
  ];
  const imeSet = new Set(imePtCodes);
  try {
    // Tenter ALTER TABLE pour ajouter ime_flag si colonne manquante (migration)
    try { db.run('ALTER TABLE meddra_terms ADD COLUMN ime_flag INTEGER DEFAULT 0'); } catch {}
    const stmt = db.prepare('UPDATE meddra_terms SET ime_flag=1 WHERE pt_code=?');
    for (const code of imeSet) { try { stmt.run([code]); } catch {} }
    stmt.free();
  } catch (err) { console.warn('[IME_SEED]', err.message); }
}

// ═══════════════════════════════════════════════════════════════════
//  3. PROMPT SYSTÈME CLAUDE
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Tu es un agent expert en pharmacovigilance, spécialisé dans l'extraction
de données d'Individual Case Safety Reports (ICSRs) selon GVP Module VI et ICH E2B(R3).

MISSION : Extraire depuis le texte fourni les données structurées d'un cas d'effet indésirable.

RÈGLES :
1. Extraire UNIQUEMENT ce qui est explicitement présent dans le texte source
2. Ne jamais inventer ni déduire des données absentes
3. Si un champ est absent ou ambigu : utiliser null
4. Pour seriousness : appliquer les critères ICH E2B(R3)
5. confidence_score : 0.9-1.0 = tous champs présents, 0.7-0.89 = ambiguïtés mineures, < 0.5 = données insuffisantes
6. meddra_search_term : terme médical normalisé en anglais pour lookup MedDRA

CHAMPS GVP OBLIGATOIRES (gvp_valid = false si l'un manque) :
- patient identifiable (âge, sexe ou initiales)
- rapporteur identifiable
- médicament suspect
- effet indésirable décrit

FORMAT : Répondre UNIQUEMENT avec du JSON valide. Aucun texte avant ou après.`;

function buildUserPrompt(sourceText, sourceType) {
  const label = { email:'email', pdf:'formulaire PDF', form:'formulaire web', manual:'texte' }[sourceType] || 'document';
  return `Analyse ce ${label} et extrais les données ICSR.

SOURCE :
${'─'.repeat(60)}
${sourceText.substring(0, 8000)}
${'─'.repeat(60)}

Réponds avec ce JSON (null si champ absent) :
{
  "patient":    { "age": null, "sex": null, "weight": null, "initials": null },
  "reporter":   { "name": null, "type": null, "email": null, "country": null, "institution": null },
  "drug":       { "name": null, "active_ingredient": null, "dose": null, "route": null, "frequency": null, "start_date": null, "stop_date": null, "indication": null },
  "adr":        { "description": null, "onset_date": null, "duration": null, "outcome": null, "rechallenge": null, "dechallenge": null },
  "seriousness":{ "is_serious": false, "criteria": [], "explanation": null },
  "meddra_search_term": null,
  "report_type": "spontaneous",
  "language_detected": "fr",
  "confidence_score": 0.0,
  "confidence_notes": null,
  "gvp_valid": false
}`;
}

function buildDuplicatePrompt(newCase, recentCases) {
  return `Vérifie si ce nouveau cas ICSR est un doublon probable parmi les cas récents.

NOUVEAU CAS : ${JSON.stringify(newCase, null, 2)}

CAS RÉCENTS (30j) : ${JSON.stringify(recentCases.slice(0, 20).map(c => ({
  id: c.case_id, patient: `${c.patient_age}/${c.patient_sex}`, drug: c.drug_name,
  adr: c.adr_description?.substring(0, 80)
})), null, 2)}

Critères doublon : même patient (âge+sexe), même médicament, même effet, fenêtre < 30j.

Réponds UNIQUEMENT avec :
{ "is_duplicate": boolean, "duplicate_case_id": "uuid ou null", "confidence": 0.0-1.0, "reason": "string" }`;
}

// ═══════════════════════════════════════════════════════════════════
//  4. SERVICE NLP — Extraction Claude
// ═══════════════════════════════════════════════════════════════════

function getAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}const CONF_GREEN  = parseFloat(process.env.CONFIDENCE_THRESHOLD_GREEN  || '0.85');
const CONF_ORANGE = parseFloat(process.env.CONFIDENCE_THRESHOLD_ORANGE || '0.60');

function _parseJson(raw) {
  let text = raw.trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('Aucun JSON trouvé dans la réponse Claude');
  return JSON.parse(text.slice(s, e + 1));
}

function _confFlag(score) {
  return score >= CONF_GREEN ? 'green' : score >= CONF_ORANGE ? 'orange' : 'red';
}

function _calcDeadlines(isSerious, criteria = []) {
  const now = new Date();
  const add = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
  if (!isSerious) return { deadline7: null, deadline15: null, deadline90: add(90) };
  const fatal = criteria.some(c => ['fatal','life_threatening'].includes(c));
  return {
    deadline7:  fatal ? add(7)  : null,
    deadline15: !fatal ? add(15) : null,
    deadline90: add(90),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  4c. RÈGLES DE SOUMISSION PAR AUTORITÉ (F9)
// ═══════════════════════════════════════════════════════════════════

const AUTHORITY_RULES = {
  EMA: {
    name: 'European Medicines Agency',
    region: 'Europe',
    portal: 'EudraVigilance',
    deadlines: { fatal: 7, life_threatening: 7, serious: 15, non_serious: 90 },
    validity_rules: {
      patient_required: true,        // Patient identifiable obligatoire
      reporter_required: true,       // Rapporteur identifiable obligatoire
      drug_required: true,
      adr_required: true,
      anonymous_patient_valid: false, // Patient anonyme = cas INVALIDE
      consumer_report_valid: true,
    },
    submission_format: 'E2B(R3)',
    language: 'any',
    notes: 'GVP Module VI — patient non identifiable = cas invalide',
  },
  ANSM: {
    name: 'Agence Nationale de Sécurité du Médicament',
    region: 'France',
    portal: 'EudraVigilance (via MAH)',
    deadlines: { fatal: 7, life_threatening: 7, serious: 15, non_serious: 90 },
    validity_rules: {
      patient_required: true,
      reporter_required: true,
      drug_required: true,
      adr_required: true,
      anonymous_patient_valid: false,
      consumer_report_valid: true,
    },
    submission_format: 'E2B(R3)',
    language: 'fr',
    notes: 'Aligne sur EMA GVP — soumission via EudraVigilance',
  },
  FDA: {
    name: 'Food and Drug Administration',
    region: 'USA',
    portal: 'FAERS / MedWatch',
    deadlines: { fatal: 7, life_threatening: 7, serious: 15, non_serious: 90 },
    validity_rules: {
      patient_required: false,       // Patient non identifiable = cas VALIDE aux USA
      reporter_required: true,
      drug_required: true,
      adr_required: true,
      anonymous_patient_valid: true, // Différence clé vs EMA
      consumer_report_valid: true,
    },
    submission_format: 'E2B(R3) via ESG',
    language: 'en',
    notes: '21 CFR 314.81 — patient anonyme accepté contrairement à EMA',
  },
  HEALTH_CANADA: {
    name: 'Health Canada / Santé Canada',
    region: 'Canada',
    portal: 'Canada Vigilance',
    deadlines: { fatal: 7, life_threatening: 7, serious: 15, non_serious: 90 },
    validity_rules: {
      patient_required: false,       // Même règle que FDA — patient anonyme valide
      reporter_required: true,
      drug_required: true,
      adr_required: true,
      anonymous_patient_valid: true,
      consumer_report_valid: true,
    },
    submission_format: 'E2B(R3)',
    language: 'en_fr',
    notes: 'Bilingual EN/FR — patient anonyme accepté',
  },
  SAHPRA: {
    name: 'South African Health Products Regulatory Authority',
    region: 'South Africa',
    portal: 'VigiFlow / SAHPRA portal',
    deadlines: { fatal: 7, life_threatening: 7, serious: 15, non_serious: 90 },
    validity_rules: {
      patient_required: true,
      reporter_required: true,
      drug_required: true,
      adr_required: true,
      anonymous_patient_valid: false,
      consumer_report_valid: true,
    },
    submission_format: 'E2B(R3) / VigiFlow',
    language: 'en',
    notes: 'Aligne ICH/EMA — même délais 7/15/90j — soumission via VigiFlow ou portail SAHPRA',
  },
  MHRA: {
    name: 'Medicines and Healthcare products Regulatory Agency',
    region: 'UK',
    portal: 'MHRA Sentinel / Yellow Card',
    deadlines: { fatal: 7, life_threatening: 7, serious: 15, non_serious: 90 },
    validity_rules: {
      patient_required: true,
      reporter_required: true,
      drug_required: true,
      adr_required: true,
      anonymous_patient_valid: false,
      consumer_report_valid: true,
    },
    submission_format: 'E2B(R3)',
    language: 'en',
    notes: 'Post-Brexit — soumission indépendante de EudraVigilance depuis 2021',
  },
};

// ─── Règles GVP par type de rapport ─────────────────────────────────────────

const REPORT_TYPES = {
  spontaneous: {
    label: 'Spontané',
    description: 'Signalement spontané (médecin, pharmacien, patient, infirmière)',
    reporters: ['physician','pharmacist','patient','nurse','other_hcp','consumer'],
    deadline_serious_fatal: 7,
    deadline_serious: 15,
    deadline_non_serious: 90,
    requires: ['patient','reporter','drug','adr'],
    gvp_module: 'GVP Module VI',
    susar: false,
  },
  literature: {
    label: 'Littérature',
    description: "Cas issu d'une publication scientifique ou abstract",
    reporters: ['author','journal'],
    deadline_serious_fatal: 15,
    deadline_serious: 15,
    deadline_non_serious: 90,
    requires: ['drug','adr','reference'],
    gvp_module: 'GVP Module VI — Section VI.C.2',
    susar: false,
    extra_fields: ['reference_author','reference_journal','reference_year','reference_doi'],
  },
  clinical_study: {
    label: 'Étude clinique (SUSAR)',
    description: 'Suspected Unexpected Serious Adverse Reaction en essai clinique',
    reporters: ['investigator','sponsor','cro'],
    deadline_serious_fatal: 7,
    deadline_serious: 7,
    deadline_non_serious: 15,
    requires: ['patient','reporter','drug','adr','study_number','protocol'],
    gvp_module: 'GVP Module VI + ICH E2A',
    susar: true,
    extra_fields: ['study_number','protocol_number','investigator_name','sponsor_name'],
  },
  post_market: {
    label: 'Post-Market (PASS/PAES)',
    description: "Étude post-autorisation de sécurité ou d'efficacité",
    reporters: ['investigator','physician'],
    deadline_serious_fatal: 7,
    deadline_serious: 15,
    deadline_non_serious: 90,
    requires: ['patient','reporter','drug','adr','study_number'],
    gvp_module: 'GVP Module VIII',
    susar: false,
    extra_fields: ['study_number','pass_paes_type'],
  },
  revised: {
    label: 'Cas révisé',
    description: "Mise à jour d'un cas déjà soumis (follow-up report)",
    reporters: ['physician','pharmacist','patient','other_hcp'],
    deadline_serious_fatal: 7,
    deadline_serious: 15,
    deadline_non_serious: 90,
    requires: ['patient','reporter','drug','adr','original_case_id'],
    gvp_module: 'GVP Module VI — Follow-up',
    susar: false,
    extra_fields: ['original_case_id','revision_reason'],
  },
  compassionate: {
    label: 'Usage compassionnel / ATU',
    description: "Autorisation Temporaire d'Utilisation ou compassionate use",
    reporters: ['physician'],
    deadline_serious_fatal: 7,
    deadline_serious: 15,
    deadline_non_serious: 90,
    requires: ['patient','reporter','drug','adr'],
    gvp_module: 'GVP Module VI + réglementation nationale',
    susar: false,
  },
};

function getReportTypeRules(reportType) {
  return REPORT_TYPES[reportType] || REPORT_TYPES.spontaneous;
}

function getAuthorityRules(authorityCode) {
  return AUTHORITY_RULES[authorityCode?.toUpperCase()] || AUTHORITY_RULES.EMA;
}

function validateCaseForAuthority(extracted, authorityCode) {
  const rules = getAuthorityRules(authorityCode);
  const errors = [];
  const warnings = [];

  // Vérifier validité selon règles de l'autorité
  if (rules.validity_rules.patient_required && !extracted.patientAge && !extracted.patientSex) {
    if (!rules.validity_rules.anonymous_patient_valid) {
      errors.push(`Patient non identifiable — cas INVALIDE pour ${rules.name}`);
    } else {
      warnings.push(`Patient anonyme — cas valide pour ${rules.name} (différent de EMA)`);
    }
  }
  if (rules.validity_rules.reporter_required && !extracted.reporterName && !extracted.reporterType) {
    errors.push(`Rapporteur non identifiable — cas INVALIDE pour ${rules.name}`);
  }
  if (rules.validity_rules.drug_required && !extracted.drugName) {
    errors.push(`Médicament suspect manquant — cas INVALIDE pour ${rules.name}`);
  }
  if (rules.validity_rules.adr_required && !extracted.adrDescription) {
    errors.push(`Effet indésirable non décrit — cas INVALIDE pour ${rules.name}`);
  }

  // Calcul délai selon sériosité
  const isSerious = extracted.seriousness && extracted.seriousness !== 'non-serious';
  const isFatal = extracted.seriousness?.includes('fatal') || extracted.seriousness?.includes('life_threatening');
  const deadlineDays = isFatal ? rules.deadlines.fatal
    : isSerious ? rules.deadlines.serious
    : rules.deadlines.non_serious;

  return {
    authority: rules.name,
    portal: rules.portal,
    region: rules.region,
    valid: errors.length === 0,
    errors,
    warnings,
    deadline_days: deadlineDays,
    submission_format: rules.submission_format,
    language: rules.language,
    notes: rules.notes,
  };
}

function _calcDeadlinesForAuthority(isSerious, criteria = [], authorityCode = 'EMA') {
  const rules = getAuthorityRules(authorityCode);
  const now = new Date();
  const add = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
  if (!isSerious) return { deadline7: null, deadline15: null, deadline90: add(rules.deadlines.non_serious) };
  const fatal = criteria.some(c => ['fatal','life_threatening'].includes(c));
  return {
    deadline7:  fatal ? add(rules.deadlines.fatal) : null,
    deadline15: !fatal ? add(rules.deadlines.serious) : null,
    deadline90: add(rules.deadlines.non_serious),
  };
}

async function extractIcsrData(sourceText, sourceType) {
  if (!sourceText || sourceText.trim().length < 20)
    throw new Error('Texte source trop court (< 20 caractères)');

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildUserPrompt(sourceText, sourceType) },
      { role: 'assistant', content: '{' },
    ],
  });

  const rawText = response.content[0]?.type === 'text' ? response.content[0].text : null;
  if (!rawText) throw new Error('Réponse Claude vide');
  const raw = '{' + rawText;

  const data = _parseJson(raw);
  const score = typeof data.confidence_score === 'number' ? data.confidence_score : 0;
  const deadlines = _calcDeadlines(data.seriousness?.is_serious, data.seriousness?.criteria);

  // Build extracted object
  const extracted = {
    patientAge:       data.patient?.age      ?? null,
    patientSex:       data.patient?.sex      ?? null,
    patientWeight:    data.patient?.weight   ?? null,
    reporterName:     data.reporter?.name    ?? null,
    reporterType:     data.reporter?.type    ?? null,
    reporterCountry:  data.reporter?.country ?? null,
    drugName:         data.drug?.name        ?? null,
    drugDose:         data.drug?.dose        ?? null,
    drugRoute:        data.drug?.route       ?? null,
    drugStartDate:    data.drug?.start_date  ?? null,
    adrDescription:   data.adr?.description  ?? null,
    adrOnsetDate:     data.adr?.onset_date   ?? null,
    adrOutcome:       data.adr?.outcome      ?? null,
    seriousness:      data.seriousness?.is_serious
                        ? (data.seriousness.criteria?.join(',') || 'serious')
                        : 'non-serious',
    meddraSearchTerm: data.meddra_search_term  ?? null,
    suspectDrugs:     Array.isArray(data.suspect_drugs) && data.suspect_drugs.length > 0
                        ? data.suspect_drugs
                        : (data.drug?.name ? [{ ...data.drug, suspect_or_concomitant: 'suspect' }] : null),
    confidenceScore:  score,
    confidenceFlag:   _confFlag(score),
    gvpValid:         data.gvp_valid           ?? false,
    rawLlmOutput:     raw,
    confidenceNotes:  data.confidence_notes    ?? null,
    reportType:       data.report_type         ?? 'unknown',
    languageDetected: data.language_detected   ?? 'fr',
  };

  // Generate clinical narrative (second Claude call)
  extracted.narrative = await generateNarrative(extracted);

  return { extracted, deadlines };
}

// ═══════════════════════════════════════════════════════════════════
//  4b. GÉNÉRATION NARRATIVE CLINIQUE (Auto-narratif)
// ═══════════════════════════════════════════════════════════════════

async function generateNarrative(extracted) {
  try {
    const client = getAnthropicClient();
    const { patientAge, patientSex, patientWeight, reporterName, reporterType,
            drugName, drugDose, drugRoute, drugStartDate,
            adrDescription, adrOnsetDate, adrOutcome, seriousness,
            meddraSearchTerm, suspectDrugs } = extracted;

    const drugsText = suspectDrugs && suspectDrugs.length > 0
      ? suspectDrugs.map(d =>
          `${d.name || drugName}${d.dose ? ' ' + d.dose : ''}${d.route ? ' via ' + d.route : ''}${d.start_date ? ' from ' + d.start_date : ''}${d.stop_date ? ' to ' + d.stop_date : ''} [${d.suspect_or_concomitant || 'suspect'}]`
        ).join('; ')
      : `${drugName || 'unknown drug'}${drugDose ? ' ' + drugDose : ''}${drugRoute ? ' via ' + drugRoute : ''}${drugStartDate ? ' since ' + drugStartDate : ''}`;

    const prompt = `You are a pharmacovigilance expert. Write a concise clinical narrative for this ICSR case following ICH E2B(R3) and CIOMS I standards.

Case data:
- Patient: ${patientAge || 'unknown age'} ${patientSex || 'unknown sex'}${patientWeight ? ', ' + patientWeight : ''}
- Reporter: ${reporterName || 'unknown'} (${reporterType || 'unknown'})
- Drug(s): ${drugsText}
- Adverse reaction: ${adrDescription || 'not described'}
- Onset date: ${adrOnsetDate || 'unknown'}
- Outcome: ${adrOutcome || 'unknown'}
- Seriousness: ${seriousness || 'unknown'}
- MedDRA term: ${meddraSearchTerm || 'pending coding'}

Write a professional clinical narrative in English (3-5 sentences). Structure:
1. Patient description + drug(s) exposure with doses and dates
2. Adverse reaction description and onset
3. Actions taken (dechallenge, hospitalisation, etc.) and outcome
4. Brief causality comment if inferable

Respond ONLY with the narrative text. No labels, no JSON, no preamble.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0]?.text?.trim() || null;
  } catch (err) {
    console.error('[NARRATIVE]', err.message);
    return null;
  }
}

async function checkDuplicate(extracted, recentCases) {
  if (!recentCases?.length)
    return { isDuplicate: false, duplicateCaseId: null, confidence: 0, reason: 'Aucun cas récent' };
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      messages: [{ role: 'user', content: buildDuplicatePrompt(extracted, recentCases) }],
    });
    const r = _parseJson(res.content[0]?.text || '{}');
    return { isDuplicate: r.is_duplicate ?? false, duplicateCaseId: r.duplicate_case_id ?? null, confidence: r.confidence ?? 0, reason: r.reason ?? '' };
  } catch { return { isDuplicate: false, duplicateCaseId: null, confidence: 0, reason: 'Vérification impossible' }; }
}

// ═══════════════════════════════════════════════════════════════════
//  5. MedDRA LOOKUP
// ═══════════════════════════════════════════════════════════════════

async function meddraLookup(searchTerm, topK = 3) {
  if (!searchTerm?.trim()) return { results: [], top: null, confidence: 'none' };

  const db   = await getDb();
  const term = searchTerm.toLowerCase().trim();
  const words = term.split(/\s+/).filter(w => w.length > 2);
  const results = [];

  // Recherche exacte
  const exact = db.prepare('SELECT pt_code,pt_name,llt_code,llt_name,soc_name,hlt_name FROM meddra_terms WHERE pt_name_lower=? OR llt_name_lower=? LIMIT ?');
  exact.bind([term, term, topK]);
  while (exact.step()) results.push({ ...exact.getAsObject(), score: 1.0, match_type: 'exact' });
  exact.free();

  // Recherche LIKE
  if (results.length < topK) {
    for (const word of words.slice(0, 3)) {
      const like = db.prepare('SELECT pt_code,pt_name,llt_code,llt_name,soc_name,hlt_name FROM meddra_terms WHERE pt_name_lower LIKE ? OR llt_name_lower LIKE ? LIMIT ?');
      like.bind([`%${word}%`, `%${word}%`, topK * 2]);
      while (like.step()) {
        const row = like.getAsObject();
        if (!results.find(r => r.llt_code === row.llt_code)) {
          results.push({ ...row, score: Math.min(0.92, word.length / Math.max(row.pt_name.length, 1) + 0.3), match_type: 'partial' });
        }
      }
      like.free();
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results[0] || null;

  // Vérifier IME flag pour le terme sélectionné
  let imeFlag = false;
  if (top?.pt_code) {
    const db2 = await getDb();
    const imeCheck = db2.prepare('SELECT ime_flag FROM meddra_terms WHERE pt_code=? LIMIT 1');
    imeCheck.bind([top.pt_code]);
    if (imeCheck.step()) { imeFlag = imeCheck.getAsObject().ime_flag === 1; }
    imeCheck.free();
  }

  return {
    results: results.slice(0, topK).map(r => ({ ...r, ime_flag: r.ime_flag === 1 })),
    top: top ? {
      pt_code: top.pt_code, pt_name: top.pt_name,
      llt_code: top.llt_code, llt_name: top.llt_name,
      soc_name: top.soc_name,
      ime_flag: imeFlag
    } : null,
    confidence: top ? (top.score >= CONF_GREEN ? 'green' : top.score >= CONF_ORANGE ? 'orange' : 'red') : 'none',
    score: top?.score || 0,
    ime_alert: imeFlag ? '⚠ IME — Important Medical Event (EMA list)' : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  6. NORMALISATION TEXTE
// ═══════════════════════════════════════════════════════════════════

function normalizeSource(content, sourceType) {
  const asStr = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content || '');
  if (sourceType === 'email') {
    return asStr
      .replace(/^(From|To|Cc|Subject|Date|Message-ID|MIME-Version|Content-Type|Content-Transfer-Encoding):.*$/gim, '')
      .replace(/Ce (message|courriel).*confidentiel[\s\S]*?$/im, '')
      .replace(/This (message|email).*confidential[\s\S]*?$/im, '')
      .replace(/^[-=_*]{3,}$/gm, '')
      .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  }
  if (sourceType === 'pdf') {
    return asStr
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .replace(/\n{3,}/g, '\n\n').replace(/^\s*\d+\s*$/gm, '')
      .replace(/[ \t]+/g, ' ').trim();
  }
  return asStr.trim();
}

function validateSource(text) {
  if (!text || text.trim().length === 0) return { valid: false, reason: 'Contenu vide' };
  if (text.trim().length < 30) return { valid: false, reason: 'Contenu trop court (< 30 caractères)' };
  if (text.length > 20000)    return { valid: false, reason: 'Contenu trop long (> 20 000 caractères)' };
  return { valid: true, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════
//  7. GÉNÉRATEUR CIOMS I PDF
// ═══════════════════════════════════════════════════════════════════

async function generateCiomsIPdf(caseData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDoc({ size: 'A4', margins: { top:35, bottom:35, left:40, right:40 } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const f   = caseData.fields || caseData;
      const now = new Date().toLocaleDateString('fr-FR');
      const ref = caseData.id?.substring(0, 8).toUpperCase() || 'DRAFT';
      const serious = (f.seriousness || caseData.seriousness || '').toLowerCase() !== 'non-serious';
      let y = 35;

      // Header
      doc.rect(40, y, 515, 48).fill('#0c1120');
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#00d4aa').text('PharmaVeil', 50, y + 8);
      doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.7)').text('pharmaveil.eu — IA Pharmacovigilance', 50, y + 28);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text('CIOMS FORM I', 390, y + 14, { align:'right', width:155 });
      y += 60;

      // Ref + Badge
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0c1120').text(`Réf. PV-${ref}`, 40, y);
      doc.font('Helvetica').fontSize(8).fillColor('#555e7a').text(`Généré le ${now}`, 40, y + 12);
      doc.rect(390, y, 165, 34).fill(serious ? '#d32f2f' : '#2e7d32');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(serious ? 'CAS SÉRIEUX' : 'CAS NON SÉRIEUX', 390, y + 10, { align:'center', width:165 });
      y += 50;

      // Helper — gestion dépassement de page
      const PAGE_H = doc.page.height - 60;
      const checkPage = (needed = 40) => {
        if (y + needed > PAGE_H) {
          doc.addPage();
          y = 40;
        }
      };
      const section = (title) => {
        checkPage(30);
        doc.rect(40, y, 515, 18).fill('#0c1120');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(title.toUpperCase(), 48, y + 4);
        y += 24;
      };
      const field = (label, value, x, w, h = 28, alt = false) => {
        checkPage(h + 4);
        if (alt) doc.rect(x, y, w, h).fill('#f7f8fc');
        doc.rect(x, y, w, h).stroke('#d0d5e0');
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#555e7a').text(label, x + 4, y + 3, { width: w - 8 });
        doc.font('Helvetica').fontSize(8.5).fillColor('#0c1120').text(value || '—', x + 4, y + 12, { width: w - 8 });
      };

      // A. Patient
      section('A. Patient');
      field('Âge',    f.patient_age    || f.patientAge,    40,  170);
      field('Sexe',   f.patient_sex    || f.patientSex,    215, 160);
      field('Poids',  f.patient_weight || f.patientWeight, 380, 175);
      y += 34;

      // B. Rapporteur
      section('B. Rapporteur');
      field('Nom',     f.reporter_name    || f.reporterName,    40,  260);
      field('Fonction',f.reporter_type    || f.reporterType,    305, 250);
      y += 34;
      field('Pays',    f.reporter_country || f.reporterCountry, 40,  260, 26, true);
      y += 32;

      // C. Médicament
      section('C. Médicament suspect');
      field('Nom / DCI', f.drug_name  || f.drugName,  40,  260);
      field('Dose',      f.drug_dose  || f.drugDose,  305, 130);
      field('Voie',      f.drug_route || f.drugRoute, 440, 115);
      y += 34;
      field('Début traitement', f.drug_start_date || f.drugStartDate, 40, 260, 26, true);
      y += 32;

      // D. Effet indésirable
      section('D. Effet indésirable (ADR)');
      const desc = f.adr_description || f.adrDescription || '—';
      const dh = Math.max(38, Math.ceil(desc.length / 62) * 12 + 16);
      doc.rect(40, y, 515, dh).stroke('#d0d5e0');
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#555e7a').text('Description', 44, y + 3);
      doc.font('Helvetica').fontSize(8.5).fillColor('#0c1120').text(desc, 44, y + 13, { width: 507 });
      y += dh + 6;
      field('Date d\'apparition', f.adr_onset_date || f.adrOnsetDate, 40,  260, 26);
      field('Évolution',          f.adr_outcome    || f.adrOutcome,   305, 250, 26);
      y += 32;

      // E. MedDRA
      section('E. Codage MedDRA');
      field('Terme PT',  f.meddra_pt_name || f.meddraPtName || f.meddra_search_term || f.meddraSearchTerm, 40,  360);
      field('Code PT',   f.meddra_pt_code || f.meddraPtCode, 405, 150);
      y += 34;

      // IME Alert
      const ptCode = f.meddra_pt_code || f.meddraPtCode;
      if (ptCode) {
        const imeTerms = new Set(['10000381','10002218','10006093','10028461','10019150','10018873',
          '10037549','10023439','10019692','10038435','10002218','10020751','10061592',
          '10019280','10019524','10013968','10033371','10066354','10048580','10028813',
          '10047700','10013946','10019211','10002198','10040639']);
        if (imeTerms.has(String(ptCode))) {
          doc.rect(40, y, 515, 22).fill('#fff3e0').stroke('#f57c00');
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#e65100')
            .text('⚠ IME — Important Medical Event (EMA list) — Attention sériosité "médicalement significatif"', 48, y + 7, { width: 499 });
          y += 28;
        }
      }

      // F. Médicaments suspects (multi-drugs)
      const suspectDrugsRaw = f.suspect_drugs || f.suspectDrugs;
      if (suspectDrugsRaw) {
        let drugs = [];
        try { drugs = typeof suspectDrugsRaw === 'string' ? JSON.parse(suspectDrugsRaw) : suspectDrugsRaw; } catch {}
        if (drugs && drugs.length > 1) {
          section('F. Médicaments suspects / Concomitants');
          drugs.forEach((d, i) => {
            const dLabel = `${i+1}. ${d.name || '—'} [${d.suspect_or_concomitant || 'suspect'}]`;
            const dDetail = [d.dose, d.route, d.start_date ? `début: ${d.start_date}` : null, d.stop_date ? `arrêt: ${d.stop_date}` : null].filter(Boolean).join(' · ');
            const dh2 = 28;
            doc.rect(40, y, 515, dh2).stroke('#d0d5e0');
            doc.font('Helvetica-Bold').fontSize(8).fillColor('#0c1120').text(dLabel, 44, y + 4, { width: 507 });
            doc.font('Helvetica').fontSize(7.5).fillColor('#555e7a').text(dDetail || '—', 44, y + 16, { width: 507 });
            y += dh2 + 4;
          });
        }
      }

      // G. Narrative clinique (auto-générée par IA)
      const narrativeText = f.narrative || f.narrativeText;
      if (narrativeText) {
        const nh = Math.max(55, Math.ceil(narrativeText.length / 72) * 12 + 20);
        checkPage(nh + 30);
        section('G. Narrative clinique (IA — à valider)');
        doc.rect(40, y, 515, nh).fill('#f0fdf8').stroke('#00d4aa');
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#00796b').text('NARRATIVE (draft IA — Human review required)', 44, y + 4, { width: 507 });
        doc.font('Helvetica').fontSize(8.5).fillColor('#0c1120').text(narrativeText, 44, y + 16, { width: 507 });
        y += nh + 8;
      }

      // H. Sériosité + Délais
      section('H. Sériosité et délais réglementaires');
      field('Cas sérieux', serious ? 'OUI — Cas sérieux' : 'NON — Cas non sérieux', 40, 260);
      const dl = caseData.deadline_7 || caseData.deadline7;
      const dl15 = caseData.deadline_15 || caseData.deadline15;
      const dl90 = caseData.deadline_90 || caseData.deadline90;
      const dlText = dl ? `7j : ${new Date(dl).toLocaleDateString('fr-FR')}` : dl15 ? `15j : ${new Date(dl15).toLocaleDateString('fr-FR')}` : dl90 ? `90j : ${new Date(dl90).toLocaleDateString('fr-FR')}` : '—';
      field('Délai réglementaire', dlText, 305, 250);
      y += 34;

      // G. Confiance IA
      const score = f.confidence_score || f.confidenceScore || 0;
      const flag  = f.confidence_flag  || f.confidenceFlag  || 'red';
      const flagColor = flag === 'green' ? '#2e7d32' : flag === 'orange' ? '#e65100' : '#d32f2f';
      doc.font('Helvetica').fontSize(8).fillColor('#555e7a').text(`Score confiance IA : `, 44, y);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(flagColor).text(`${(score*100).toFixed(0)}% (${flag})`, 165, y);
      doc.font('Helvetica').fontSize(8).fillColor('#555e7a').text(`GVP valide : ${f.gvp_valid||f.gvpValid ? 'OUI' : 'NON'}`, 280, y);
      y += 12;
      doc.font('Helvetica').fontSize(8).fillColor('#555e7a').text(`Source : ${caseData.source_type||caseData.sourceType||'—'}  |  Reçu : ${caseData.received_at ? new Date(caseData.received_at).toLocaleString('fr-FR') : '—'}`, 44, y);
      y += 20;

      // Footer
      checkPage(30);
      const fh = doc.page.height - 50;
      doc.strokeColor('#d0d5e0').lineWidth(0.5).moveTo(40, fh).lineTo(555, fh).stroke();
      doc.font('Helvetica').fontSize(7).fillColor('#888').text(
        `Généré par PharmaVeil (pharmaveil.eu) • ${now} • Réf: PV-${ref} • Confidentiel — Usage PV uniquement`,
        40, fh + 6, { align:'center', width:515 }
      );

      doc.end();
    } catch (e) { reject(e); }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  8. HELPERS DB
// ═══════════════════════════════════════════════════════════════════

async function dbInsertCase(data) {
  const db = await getDb();
  db.run(`INSERT INTO icsr_cases (id,org_id,status,source_type,raw_content,received_at,deadline_7,deadline_15,deadline_90,seriousness,report_type,reporter_qualification,processed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.id, data.orgId||'default', data.status, data.sourceType, (data.rawContent||'').substring(0,50000),
     data.receivedAt||new Date().toISOString(), data.deadline7||null, data.deadline15||null, data.deadline90||null, data.seriousness||null,
     data.reportType||'spontaneous', data.reporterQualification||null, new Date().toISOString()]);
  _saveDb();
}

async function dbInsertFields(data) {
  const db = await getDb();
  db.run(`INSERT INTO extracted_fields (id,case_id,patient_age,patient_sex,patient_weight,reporter_name,reporter_type,reporter_country,drug_name,drug_dose,drug_route,drug_start_date,adr_description,adr_onset_date,adr_outcome,seriousness,meddra_search_term,narrative,suspect_drugs,confidence_score,confidence_flag,raw_llm_output,gvp_valid,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.id, data.caseId, data.patientAge, data.patientSex, data.patientWeight,
     data.reporterName, data.reporterType, data.reporterCountry,
     data.drugName, data.drugDose, data.drugRoute, data.drugStartDate,
     data.adrDescription, data.adrOnsetDate, data.adrOutcome, data.seriousness,
     data.meddraSearchTerm, data.narrative || null,
     data.suspectDrugs ? JSON.stringify(data.suspectDrugs) : null,
     data.confidenceScore, data.confidenceFlag, data.rawLlmOutput,
     data.gvpValid ? 1 : 0, new Date().toISOString()]);
  _saveDb();
}

async function dbInsertAudit(caseId, action, ip, userId = null) {
  const db = await getDb();
  db.run(`INSERT INTO validation_audit (id,case_id,user_id,action,ip_address,created_at) VALUES (?,?,?,?,?,?)`,
    [crypto.randomUUID(), caseId, userId, action, ip, new Date().toISOString()]);
  _saveDb();
}

async function dbInsertAlerts(caseId, deadlines) {
  const db  = await getDb();
  const now = new Date();
  const add = (type, deadline, daysBefore) => {
    if (!deadline) return;
    const t = new Date(deadline.getTime() - daysBefore * 86400000);
    if (t > now) db.run(`INSERT INTO alerts (id,case_id,alert_type,trigger_at,created_at) VALUES (?,?,?,?,?)`,
      [crypto.randomUUID(), caseId, type, t.toISOString(), now.toISOString()]);
  };
  add('7j_D-3',  deadlines.deadline7,  3); add('7j_D-1',  deadlines.deadline7,  1);
  add('15j_D-3', deadlines.deadline15, 3); add('15j_D-1', deadlines.deadline15, 1);
  add('90j_D-7', deadlines.deadline90, 7);
  _saveDb();
}

async function dbGetCase(id) {
  const db   = await getDb();
  const stmt = db.prepare('SELECT * FROM icsr_cases WHERE id=?');
  const row  = stmt.getAsObject([id]);
  stmt.free();
  return row.id ? row : null;
}

async function dbGetFields(caseId) {
  const db   = await getDb();
  const stmt = db.prepare('SELECT * FROM extracted_fields WHERE case_id=?');
  const row  = stmt.getAsObject([caseId]);
  stmt.free();
  return row.id ? row : null;
}

async function dbGetRecentFields(orgId, excludeId) {
  const db    = await getDb();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const stmt  = db.prepare(`
    SELECT ef.* FROM extracted_fields ef
    JOIN icsr_cases ic ON ef.case_id=ic.id
    WHERE ic.org_id=? AND ic.received_at>=? AND ef.case_id!=? LIMIT 50`);
  stmt.bind([orgId||'default', since, excludeId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
//  9. EXPRESS APP
// ═══════════════════════════════════════════════════════════════════

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
  ? ['https://pharmaveil.eu', 'https://pharmaveil.fr', 'https://en.pharmaveil.eu', 'https://app.pharmaveil.eu', 'https://delightful-haupia-395e44.netlify.app', 'https://leafy-cuchufli-51f277.netlify.app', 'https://aquamarine-chaja-6f97f3.netlify.app']
  : '*',
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
// Middleware XML — doit être AVANT express.json()
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (req.path === '/api/cases/intake/xml' && (ct.includes('xml') || ct.includes('text/plain'))) {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { req.body = data; next(); });
  } else { next(); }
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '10') * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'application/xml', 'text/xml'];
    if (allowed.includes(file.mimetype) || file.originalname?.endsWith('.xml')) {
      cb(null, true);
    } else {
      cb(new Error('PDF ou XML uniquement'), false);
    }
  },
});

// ─── Auth — Codes d'accès beta ───────────────────────────────────────────────

const ACCESS_CODES = {
  'PV-DEMO-2026':       { org_id: 'demo',        org_name: 'PharmaVeil Demo',           role: 'demo' },
  'PV-ENOVALIFE-2026':  { org_id: 'enovalife',   org_name: 'Enovalife',                 role: 'beta' },
  'PV-DELITYS-2026':    { org_id: 'delitys',     org_name: 'DELITYS Conseil',            role: 'beta' },
  'PV-EXCELYA-2026':    { org_id: 'excelya',     org_name: 'Excelya',                   role: 'beta' },
  'PV-NOVAGEN-2026':    { org_id: 'novagen',     org_name: 'Novagen South Africa',       role: 'beta' },
  'PV-BIOVAC-2026':     { org_id: 'biovac',      org_name: 'Biovac Institute',           role: 'beta' },
  'PV-ROCHE-SA-2026':   { org_id: 'roche_sa',    org_name: 'Roche South Africa',        role: 'beta' },
  'PV-ADMIN-2026':      { org_id: 'pharmaveil',  org_name: 'PharmaVeil Admin',           role: 'admin' },
};

app.post('/api/auth/login', (req, res) => {
  const { access_code } = req.body;
  if (!access_code) return res.status(400).json({ error: 'Code requis' });
  const org = ACCESS_CODES[access_code.toUpperCase()];
  if (!org) return res.status(401).json({ error: 'Code invalide' });
  return res.json({
    success: true,
    org_id: org.org_id,
    org_name: org.org_name,
    role: org.role,
    message: `Bienvenue ${org.org_name}`,
  });
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) =>
  res.json({ status:'ok', service:'PharmaVeil API', version:'1.1.0', timestamp: new Date().toISOString() })
);

// ─── GET /api/report-types ───────────────────────────────────────────────────

app.get('/api/report-types', (req, res) => {
  const list = Object.entries(REPORT_TYPES).map(([code, r]) => ({
    code,
    label: r.label,
    description: r.description,
    deadline_serious: r.deadline_serious,
    deadline_fatal: r.deadline_serious_fatal,
    is_susar: r.susar,
    gvp_module: r.gvp_module,
    extra_fields: r.extra_fields || [],
  }));
  return res.json({ report_types: list, total: list.length });
});

// ─── GET /api/authorities ─────────────────────────────────────────────────────

app.get('/api/authorities', (req, res) => {
  const list = Object.entries(AUTHORITY_RULES).map(([code, r]) => ({
    code,
    name: r.name,
    region: r.region,
    portal: r.portal,
    deadlines: r.deadlines,
    submission_format: r.submission_format,
    anonymous_patient_valid: r.validity_rules.anonymous_patient_valid,
    notes: r.notes,
  }));
  return res.json({ authorities: list, total: list.length });
});

// ─── GET /api/cases/:id/validate-authority ────────────────────────────────────

app.get('/api/cases/:id/validate-authority', async (req, res) => {
  try {
    const { authority = 'EMA' } = req.query;
    const f = await dbGetFields(req.params.id);
    if (!f) return res.status(404).json({ error: 'Cas non trouvé' });

    const extracted = {
      patientAge: f.patient_age, patientSex: f.patient_sex,
      reporterName: f.reporter_name, reporterType: f.reporter_type,
      drugName: f.drug_name, adrDescription: f.adr_description,
      seriousness: f.seriousness,
    };

    // Valider pour l'autorité demandée
    const validation = validateCaseForAuthority(extracted, authority);

    // Valider pour toutes les autorités si demandé
    let allAuthorities = null;
    if (req.query.all === 'true') {
      allAuthorities = Object.keys(AUTHORITY_RULES).map(code => ({
        code,
        ...validateCaseForAuthority(extracted, code),
      }));
    }

    return res.json({
      case_id: req.params.id,
      authority,
      validation,
      all_authorities: allAuthorities,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur validation autorité', details: err.message });
  }
});

// ─── POST /api/cases/intake ───────────────────────────────────────────────────

app.post('/api/cases/intake', async (req, res) => {
  const t0 = Date.now();
  try {
    const { source_type } = req.body;
    if (!['email','form','manual'].includes(source_type))
      return res.status(400).json({ error: 'source_type requis : email | form | manual' });

    const rawContent = source_type === 'email' ? req.body.raw_email
                     : source_type === 'form'  ? req.body.form_data
                     : req.body.manual_text;

    if (!rawContent) return res.status(400).json({ error: `Champ requis manquant pour source_type=${source_type}` });

    const orgId  = req.body.org_id || 'default';
    const reportType = req.body.report_type || 'spontaneous';
    const reporterQualification = req.body.reporter_qualification || null;
    const normalized = normalizeSource(rawContent, source_type);
    const cv = validateSource(normalized);
    if (!cv.valid) return res.status(422).json({ error: cv.reason });

    const { extracted, deadlines } = await extractIcsrData(normalized, source_type);
    const caseId = crypto.randomUUID();
    const rawStr = typeof rawContent === 'object' ? JSON.stringify(rawContent) : rawContent;

    await dbInsertCase({
      id: caseId, orgId, status: 'pending_validation', sourceType: source_type,
      rawContent: rawStr, receivedAt: new Date().toISOString(),
      deadline7:  deadlines.deadline7?.toISOString()  || null,
      deadline15: deadlines.deadline15?.toISOString() || null,
      deadline90: deadlines.deadline90?.toISOString() || null,
      seriousness: extracted.seriousness,
      reportType,
      reporterQualification,
    });
    await dbInsertFields({ id: crypto.randomUUID(), caseId, ...extracted });
    await dbInsertAlerts(caseId, deadlines);
    await dbInsertAudit(caseId, 'case_created', req.ip);

    let duplicateInfo = { isDuplicate: false, duplicateCaseId: null };
    try {
      const recent = await dbGetRecentFields(orgId, caseId);
      duplicateInfo = await checkDuplicate(extracted, recent);
      if (duplicateInfo.isDuplicate) {
        const db = await getDb();
        db.run('UPDATE icsr_cases SET duplicate_flag=1 WHERE id=?', [caseId]);
        _saveDb();
      }
    } catch { /* ne bloque pas */ }

    const warn = [
      ...(duplicateInfo.isDuplicate ? [`Doublon potentiel (${duplicateInfo.duplicateCaseId})`] : []),
      ...(!extracted.gvpValid ? ['ATTENTION: cas GVP invalide — champs obligatoires manquants'] : []),
    ];

    return res.status(201).json({
      case_id: caseId, status: 'pending_validation',
      report_type: reportType,
      reporter_qualification: reporterQualification,
      processing_ms: Date.now() - t0,
      validation_payload: {
        fields: {
          patient:    { age: { value: extracted.patientAge,    flag: extracted.confidenceFlag }, sex: { value: extracted.patientSex, flag: extracted.confidenceFlag }, weight: { value: extracted.patientWeight, flag: extracted.confidenceFlag } },
          reporter:   { name: { value: extracted.reporterName, flag: extracted.confidenceFlag }, type: { value: extracted.reporterType, flag: extracted.confidenceFlag }, country: { value: extracted.reporterCountry, flag: extracted.confidenceFlag } },
          drug:       { name: { value: extracted.drugName, flag: extracted.confidenceFlag }, dose: { value: extracted.drugDose, flag: extracted.confidenceFlag }, route: { value: extracted.drugRoute, flag: extracted.confidenceFlag }, start_date: { value: extracted.drugStartDate, flag: extracted.confidenceFlag } },
          adr:        { description: { value: extracted.adrDescription, flag: extracted.confidenceFlag }, onset_date: { value: extracted.adrOnsetDate, flag: extracted.confidenceFlag }, outcome: { value: extracted.adrOutcome, flag: extracted.confidenceFlag } },
          seriousness:{ value: extracted.seriousness, flag: extracted.confidenceFlag },
          meddra:     { search_term: extracted.meddraSearchTerm, pt_code: null, pt_name: null, flag: 'pending_lookup' },
        },
        confidence:  { score: extracted.confidenceScore, flag: extracted.confidenceFlag, notes: extracted.confidenceNotes, gvp_valid: extracted.gvpValid },
        deadlines:   { received_at: new Date().toISOString(), deadline_7: deadlines.deadline7?.toISOString()||null, deadline_15: deadlines.deadline15?.toISOString()||null, deadline_90: deadlines.deadline90?.toISOString()||null },
        warnings:    warn,
        duplicate_flag: duplicateInfo.isDuplicate, duplicate_case_id: duplicateInfo.duplicateCaseId||null,
      },
    });
  } catch (err) {
    console.error('[INTAKE]', err.message);
    if (err.message?.includes('Anthropic') || err.message?.includes('API'))
      return res.status(503).json({ error: 'Service IA indisponible', details: err.message });
    return res.status(500).json({ error: 'Erreur interne', details: process.env.NODE_ENV==='development' ? err.message : undefined });
  }
});

// ─── POST /api/cases/intake/pdf ───────────────────────────────────────────────

app.post('/api/cases/intake/pdf', upload.single('file'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier PDF requis (champ: file)' });

    let pdfText;
    try {
      const d = await pdfParse(req.file.buffer);
      pdfText = d.text;
    } catch (parseErr) {
      console.error('[PDF_INTAKE] pdf-parse error:', parseErr.message);
      return res.status(422).json({ error: 'PDF illisible ou protégé', details: parseErr.message });
    }

    if (!pdfText?.trim() || pdfText.trim().length < 30)
      return res.status(422).json({ error: 'PDF vide ou non-textuel (< 30 caractères extraits)' });

    const orgId = req.body?.org_id || 'default';
    const reportType = req.body?.report_type || 'spontaneous';
    const reporterQualification = req.body?.reporter_qualification || null;

    const normalized = normalizeSource(pdfText, 'pdf');
    const cv = validateSource(normalized);
    if (!cv.valid) return res.status(422).json({ error: cv.reason });

    const { extracted, deadlines } = await extractIcsrData(normalized, 'pdf');
    const caseId = crypto.randomUUID();

    await dbInsertCase({
      id: caseId, orgId, status: 'pending_validation', sourceType: 'pdf',
      rawContent: pdfText.substring(0, 50000),
      receivedAt: new Date().toISOString(),
      deadline7:  deadlines.deadline7?.toISOString()  || null,
      deadline15: deadlines.deadline15?.toISOString() || null,
      deadline90: deadlines.deadline90?.toISOString() || null,
      seriousness: extracted.seriousness,
      reportType, reporterQualification,
    });
    await dbInsertFields({ id: crypto.randomUUID(), caseId, ...extracted });
    await dbInsertAlerts(caseId, deadlines);
    await dbInsertAudit(caseId, 'case_created_pdf', req.ip);

    let duplicateInfo = { isDuplicate: false, duplicateCaseId: null };
    try {
      const recent = await dbGetRecentFields(orgId, caseId);
      duplicateInfo = await checkDuplicate(extracted, recent);
      if (duplicateInfo.isDuplicate) {
        const db = await getDb();
        db.run('UPDATE icsr_cases SET duplicate_flag=1 WHERE id=?', [caseId]);
        _saveDb();
      }
    } catch {}

    return res.status(201).json({
      case_id: caseId,
      status: 'pending_validation',
      source_type: 'pdf',
      processing_ms: Date.now() - t0,
      narrative_generated: !!extracted.narrative,
      gvp_valid: extracted.gvpValid,
      seriousness: extracted.seriousness,
      duplicate_flag: duplicateInfo.isDuplicate,
    });
  } catch (err) {
    console.error('[PDF_INTAKE]', err.message, err.stack);
    return res.status(500).json({ error: 'Erreur traitement PDF', details: err.message });
  }
});

// ─── POST /api/cases/intake/xml (F1 — Import E2B R3) ─────────────────────────

function parseE2bXml(xmlText) {
  // Parser E2B(R3) XML entrant — extraction des champs ICH
  const get = (tag) => {
    const m = xmlText.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const getAll = (tag) => {
    const results = [];
    const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xmlText)) !== null) results.push(m[1].trim());
    return results;
  };

  // Patient
  const patientSexRaw = get('patientsex');
  const patientSex = patientSexRaw === '1' ? 'M' : patientSexRaw === '2' ? 'F' : null;
  const patientAgeRaw = get('patientonsetage') || get('patientage');

  // Drug(s) — peut y en avoir plusieurs
  const drugBlocks = xmlText.match(/<drug[\s\S]*?<\/drug>/gi) || [];
  const drugs = drugBlocks.map(block => {
    const getName = (t) => { const m = block.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, 'i')); return m ? m[1].trim() : null; };
    return {
      name: getName('medicinalproduct'),
      dose: getName('drugdosagetext') || getName('drugdosage'),
      route: getName('drugroute'),
      start_date: getName('drugstartdate'),
      stop_date: getName('drugenddate'),
      suspect_or_concomitant: getName('drugcharacterization') === '1' ? 'suspect' : 'concomitant',
    };
  }).filter(d => d.name);

  // Reaction
  const adrDescription = get('primarysourcereaction') || get('reportercomment');
  const meddrapt       = get('reactionmeddrapt');
  const adrOnset       = get('reactionstartdate');
  const adrOutcome     = get('reactionoutcome');

  // Seriousness
  const seriousRaw = get('serious');
  const isSerious  = seriousRaw === '1';
  const criteria   = [];
  if (get('seriousnessdeath') === '1')           criteria.push('fatal');
  if (get('seriousnesslifethreatening') === '1') criteria.push('life_threatening');
  if (get('seriousnesshospitalization') === '1') criteria.push('hospitalization');
  if (get('seriousnessdisabling') === '1')       criteria.push('disability');
  if (get('seriousnesscongenitalanomali') === '1') criteria.push('congenital_anomaly');
  if (get('seriousnessother') === '1')           criteria.push('other');

  // Reporter
  const reporterType = get('primarysourcereportertype') || get('reportertype');

  // Transmission date
  const txDate = get('transmissiondate') || get('receiptdate');
  const receivedAt = txDate && txDate.length === 8
    ? `${txDate.slice(0,4)}-${txDate.slice(4,6)}-${txDate.slice(6,8)}T00:00:00.000Z`
    : new Date().toISOString();

  // Safety report ID (pour référence)
  const safetyReportId = get('safetyreportid') || get('messagenumb');

  return {
    patientAge:      patientAgeRaw,
    patientSex,
    patientWeight:   get('patientweight'),
    reporterName:    get('reportername') || get('primarysourcereporter'),
    reporterType:    reporterType === '1' ? 'physician' : reporterType === '2' ? 'pharmacist' : reporterType === '3' ? 'other_health_professional' : reporterType === '5' ? 'patient' : reporterType,
    reporterCountry: get('primarysourcecountry') || get('reportercountry'),
    drugName:        drugs[0]?.name || null,
    drugDose:        drugs[0]?.dose || null,
    drugRoute:       drugs[0]?.route || null,
    drugStartDate:   drugs[0]?.start_date || null,
    suspectDrugs:    drugs.length > 0 ? drugs : null,
    adrDescription,
    adrOnsetDate:    adrOnset && adrOnset.length === 8
                       ? `${adrOnset.slice(0,4)}-${adrOnset.slice(4,6)}-${adrOnset.slice(6,8)}`
                       : adrOnset,
    adrOutcome:      adrOutcome === '1' ? 'recovered' : adrOutcome === '2' ? 'recovering' : adrOutcome === '3' ? 'not_recovered' : adrOutcome === '5' ? 'fatal' : adrOutcome === '0' ? 'unknown' : adrOutcome,
    seriousness:     isSerious ? (criteria.join(',') || 'serious') : 'non-serious',
    meddraSearchTerm: meddrapt || adrDescription,
    meddraSearchPt:   meddrapt,
    confidenceScore:  0.95,
    confidenceFlag:   'green',
    gvpValid:         !!(drugs[0]?.name && adrDescription),
    rawLlmOutput:     null,
    narrative:        null,
    safetyReportId,
    receivedAt,
    isSerious,
    criteria,
  };
}

app.post('/api/cases/intake/xml', async (req, res) => {
  const t0 = Date.now();
  try {
    let xmlText = '';

    // Accepter XML en body text/xml ou application/xml ou champ xml_content
    if (typeof req.body === 'string' && req.body.trim().startsWith('<')) {
      xmlText = req.body;
    } else if (req.body?.xml_content) {
      xmlText = req.body.xml_content;
    } else {
      return res.status(400).json({ error: 'XML requis — body XML ou champ xml_content' });
    }

    const orgId = (typeof req.body === 'object' ? req.body?.org_id : null) || 'default';
    const xmlLower = xmlText.toLowerCase();

    // Détection format E2B(R3) ICH
    const isE2b = xmlLower.includes('ichicsr') ||
                  xmlLower.includes('safetyreport') ||
                  xmlLower.includes('medicinalproduct') ||
                  xmlLower.includes('primarysourcereaction') ||
                  (xmlLower.includes('<drug') && xmlLower.includes('<reaction'));

    // Détection HL7 v3 (MCCI_IN200100UV, HL7 CDA, etc.)
    const isHL7 = xmlLower.includes('mcci_in') || xmlLower.includes('hl7') ||
                  xmlLower.includes('controlactprocess') || xmlLower.includes('cda') ||
                  xmlLower.includes('clinicaldocument');

    let extracted;

    if (isE2b) {
      // Parsing structuré E2B(R3) natif
      extracted = parseE2bXml(xmlText);
    } else {
      // Format non-E2B (HL7 v3, CDA, propriétaire, etc.) → extraction Claude NLP
      console.log('[XML_INTAKE] Non-E2B format detected (HL7/CDA/other), routing to Claude NLP');
      const sourceType = isHL7 ? 'hl7_v3' : 'xml_other';
      // Nettoyer le XML pour Claude (supprimer balises techniques, garder le contenu médical)
      const cleanedXml = xmlText
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*xsi:[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .substring(0, 8000);

      extracted = await extractIcsrData(
        `[XML ${sourceType.toUpperCase()} — auto-converted for NLP extraction]\n${cleanedXml}`,
        'xml_other'
      );
      extracted.sourceType = sourceType;
    }

    // Calculer les délais
    const deadlines = _calcDeadlines(
      extracted.seriousness !== 'non-serious',
      extracted.criteria || []
    );

    // Générer narrative si données suffisantes
    if (extracted.gvpValid || extracted.adrDescription) {
      try { extracted.narrative = await generateNarrative(extracted); } catch {}
    }

    const caseId = crypto.randomUUID();

    await dbInsertCase({
      id: caseId, orgId, status: 'pending_validation',
      sourceType: extracted.sourceType || (isE2b ? 'xml_e2b' : 'xml_other'),
      rawContent: xmlText.substring(0, 50000),
      receivedAt: extracted.receivedAt || new Date().toISOString(),
      deadline7:  deadlines.deadline7?.toISOString()  || null,
      deadline15: deadlines.deadline15?.toISOString() || null,
      deadline90: deadlines.deadline90?.toISOString() || null,
      seriousness: extracted.seriousness,
    });
    await dbInsertFields({ id: crypto.randomUUID(), caseId, ...extracted });
    await dbInsertAlerts(caseId, deadlines);
    await dbInsertAudit(caseId, 'case_created_xml', req.ip);

    // Vérif doublons
    let duplicateInfo = { isDuplicate: false, duplicateCaseId: null };
    try {
      const recent = await dbGetRecentFields(orgId, caseId);
      duplicateInfo = await checkDuplicate(extracted, recent);
      if (duplicateInfo.isDuplicate) {
        const db = await getDb();
        db.run('UPDATE icsr_cases SET duplicate_flag=1 WHERE id=?', [caseId]);
        _saveDb();
      }
    } catch {}

    return res.status(201).json({
      case_id: caseId,
      status: 'pending_validation',
      source_type: extracted.sourceType || (isE2b ? 'xml_e2b' : 'xml_other'),
      xml_format: isE2b ? 'E2B(R3)' : isHL7 ? 'HL7 v3 (NLP extraction)' : 'XML other (NLP extraction)',
      source_reference: extracted.safetyReportId || null,
      processing_ms: Date.now() - t0,
      drugs_detected: extracted.suspectDrugs?.length || 1,
      narrative_generated: !!(extracted.narrative),
      confidence_score: extracted.confidenceScore || 0,
      confidence_flag: extracted.confidenceFlag || 'red',
      gvp_valid: extracted.gvpValid || false,
      duplicate_flag: duplicateInfo.isDuplicate,
    });!extracted.narrative,
      duplicate_flag: duplicateInfo.isDuplicate,
      gvp_valid: extracted.gvpValid,
      seriousness: extracted.seriousness,
      deadlines: {
        deadline_7:  deadlines.deadline7?.toISOString()  || null,
        deadline_15: deadlines.deadline15?.toISOString() || null,
        deadline_90: deadlines.deadline90?.toISOString() || null,
      },
    });
  } catch (err) {
    console.error('[INTAKE_XML]', err.message);
    return res.status(500).json({ error: 'Erreur import XML', details: process.env.NODE_ENV==='development' ? err.message : undefined });
  }
});

// ─── POST /api/cases/consolidate (F2 — Consolidation multi-sources) ─────────────

app.post('/api/cases/consolidate', async (req, res) => {
  const t0 = Date.now();
  try {
    const { sources, org_id } = req.body;
    // sources = [{ type: 'email'|'manual'|'xml', content: '...' }, ...]
    if (!Array.isArray(sources) || sources.length < 2) {
      return res.status(400).json({ error: 'Au moins 2 sources requises pour la consolidation' });
    }
    if (sources.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 sources par consolidation' });
    }

    const orgId = org_id || 'default';

    // Étape 1 — Extraire les données de chaque source
    const extractedSources = [];
    for (const src of sources) {
      let data = null;
      try {
        if (src.type === 'xml') {
          data = parseE2bXml(src.content);
          data._sourceType = 'xml_e2b';
        } else {
          const normalized = normalizeSource(src.content, src.type);
          const result = await extractIcsrData(normalized, src.type);
          data = result.extracted;
          data._sourceType = src.type;
        }
        extractedSources.push(data);
      } catch (err) {
        console.warn('[CONSOLIDATE] Source extraction failed:', err.message);
      }
    }

    if (extractedSources.length === 0) {
      return res.status(422).json({ error: "Aucune source extraite avec succès" });
    }

    // Étape 2 — Consolidation intelligente par Claude
    const client = getAnthropicClient();
    const sourcesText = extractedSources.map((s, i) => {
      const summary = {
        patient: { age: s.patientAge, sex: s.patientSex },
        reporter: { name: s.reporterName, type: s.reporterType },
        drug: s.drugName, adr: s.adrDescription,
        seriousness: s.seriousness, meddra: s.meddraSearchTerm,
        suspectDrugs: s.suspectDrugs,
      };
      return 'Source ' + (i+1) + ' (' + (s._sourceType || 'unknown') + '): ' + JSON.stringify(summary, null, 1);
    }).join('\n\n');

    const consolidatePrompt = 'Tu es un expert pharmacovigilance. Consolide ces ' + extractedSources.length + ' extractions de sources differentes du MEME cas ICSR en un seul enregistrement unifie.\n\n'
      + 'REGLES:\n1. Prioriser les donnees les plus completes\n2. Priorite: XML E2B > Email > Manuel\n3. Fusionner descriptions ADR complementaires\n4. Conserver tous medicaments suspects\n\n'
      + 'SOURCES:\n' + sourcesText + '\n\n'
      + 'Reponds UNIQUEMENT avec ce JSON:\n'
      + '{"patientAge":null,"patientSex":null,"patientWeight":null,"reporterName":null,"reporterType":null,"reporterCountry":null,'
      + '"drugName":null,"drugDose":null,"drugRoute":null,"drugStartDate":null,"adrDescription":null,"adrOnsetDate":null,"adrOutcome":null,'
      + '"seriousness":null,"meddraSearchTerm":null,"suspectDrugs":null,"consolidation_notes":null,"confidence_score":0.0,"gvp_valid":false}';

    const consolidateResp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: consolidatePrompt }],
    });

    const consolidated = _parseJson(consolidateResp.content[0]?.text || '{}');
    const score = consolidated.confidence_score || 0.9;

    // Étape 3 — Calculer les délais
    const isSerious = consolidated.seriousness && consolidated.seriousness !== 'non-serious';
    const criteria = consolidated.seriousness?.split(',') || [];
    const deadlines = _calcDeadlines(isSerious, criteria);

    // Étape 4 — Générer la narrative
    const narrativeData = {
      patientAge: consolidated.patientAge,
      patientSex: consolidated.patientSex,
      reporterName: consolidated.reporterName,
      reporterType: consolidated.reporterType,
      drugName: consolidated.drugName,
      drugDose: consolidated.drugDose,
      drugRoute: consolidated.drugRoute,
      drugStartDate: consolidated.drugStartDate,
      adrDescription: consolidated.adrDescription,
      adrOnsetDate: consolidated.adrOnsetDate,
      adrOutcome: consolidated.adrOutcome,
      seriousness: consolidated.seriousness,
      meddraSearchTerm: consolidated.meddraSearchTerm,
      suspectDrugs: consolidated.suspectDrugs,
    };
    consolidated.narrative = await generateNarrative(narrativeData);

    // Étape 5 — Sauvegarder
    const caseId = crypto.randomUUID();
    const sourcesSummary = sources.map(s => s.type).join('+');

    await dbInsertCase({
      id: caseId, orgId, status: 'pending_validation',
      sourceType: `consolidated_${sourcesSummary}`,
      rawContent: JSON.stringify(sources.map(s => ({ type: s.type, preview: s.content?.substring(0,200) }))),
      receivedAt: new Date().toISOString(),
      deadline7:  deadlines.deadline7?.toISOString()  || null,
      deadline15: deadlines.deadline15?.toISOString() || null,
      deadline90: deadlines.deadline90?.toISOString() || null,
      seriousness: consolidated.seriousness,
    });

    await dbInsertFields({
      id: crypto.randomUUID(), caseId,
      patientAge:      consolidated.patientAge,
      patientSex:      consolidated.patientSex,
      patientWeight:   consolidated.patientWeight,
      reporterName:    consolidated.reporterName,
      reporterType:    consolidated.reporterType,
      reporterCountry: consolidated.reporterCountry,
      drugName:        consolidated.drugName,
      drugDose:        consolidated.drugDose,
      drugRoute:       consolidated.drugRoute,
      drugStartDate:   consolidated.drugStartDate,
      adrDescription:  consolidated.adrDescription,
      adrOnsetDate:    consolidated.adrOnsetDate,
      adrOutcome:      consolidated.adrOutcome,
      seriousness:     consolidated.seriousness,
      meddraSearchTerm: consolidated.meddraSearchTerm,
      narrative:       consolidated.narrative,
      suspectDrugs:    consolidated.suspectDrugs ? JSON.stringify(consolidated.suspectDrugs) : null,
      confidenceScore: score,
      confidenceFlag:  _confFlag(score),
      gvpValid:        consolidated.gvp_valid || false,
      rawLlmOutput:    JSON.stringify(consolidated),
    });

    await dbInsertAlerts(caseId, deadlines);
    await dbInsertAudit(caseId, 'case_consolidated', req.ip);

    return res.status(201).json({
      case_id: caseId,
      status: 'pending_validation',
      source_type: `consolidated_${sourcesSummary}`,
      sources_count: extractedSources.length,
      consolidation_notes: consolidated.consolidation_notes,
      narrative_generated: !!consolidated.narrative,
      processing_ms: Date.now() - t0,
      deadlines: {
        deadline_7:  deadlines.deadline7?.toISOString()  || null,
        deadline_15: deadlines.deadline15?.toISOString() || null,
        deadline_90: deadlines.deadline90?.toISOString() || null,
      },
    });
  } catch (err) {
    console.error('[CONSOLIDATE]', err.message);
    return res.status(500).json({ error: 'Erreur consolidation', details: process.env.NODE_ENV==='development' ? err.message : undefined });
  }
});

// ─── GET /api/cases ───────────────────────────────────────────────────────────

app.get('/api/cases', async (req, res) => {
  try {
    const { status, org_id, limit = 20, offset = 0 } = req.query;
    const db = await getDb();
    let q = 'SELECT ic.*,ef.confidence_score,ef.confidence_flag,ef.drug_name,ef.adr_description FROM icsr_cases ic LEFT JOIN extracted_fields ef ON ic.id=ef.case_id WHERE 1=1';
    const p = [];
    if (status)  { q += ' AND ic.status=?';  p.push(status); }
    if (org_id)  { q += ' AND ic.org_id=?';  p.push(org_id); }
    q += ' ORDER BY ic.received_at DESC LIMIT ? OFFSET ?';
    p.push(parseInt(limit), parseInt(offset));
    const stmt = db.prepare(q); stmt.bind(p);
    const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free();
    return res.json({ cases: rows, total: rows.length });
  } catch (err) { return res.status(500).json({ error: 'Erreur DB', details: err.message }); }
});

// ─── GET /api/cases/:id ───────────────────────────────────────────────────────

app.get('/api/cases/:id', async (req, res) => {
  try {
    const c = await dbGetCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'Cas non trouvé' });
    const f = await dbGetFields(req.params.id);
    return res.json({ ...c, fields: f });
  } catch (err) { return res.status(500).json({ error: 'Erreur DB' }); }
});

// ─── GET /api/cases/:id/meddra ────────────────────────────────────────────────

app.get('/api/cases/:id/meddra', async (req, res) => {
  try {
    const f = await dbGetFields(req.params.id);
    if (!f) return res.status(404).json({ error: 'Cas non trouvé' });
    const term = req.query.query || f.meddra_search_term;
    if (!term) return res.status(400).json({ error: 'Terme de recherche manquant' });
    const result = await meddraLookup(term, 5);
    return res.json({ case_id: req.params.id, search_term: term, ...result });
  } catch (err) { return res.status(500).json({ error: 'Erreur MedDRA', details: err.message }); }
});

// ─── PATCH /api/cases/:id/validate ───────────────────────────────────────────

app.patch('/api/cases/:id/validate', async (req, res) => {
  try {
    const c = await dbGetCase(req.params.id);
    if (!c)                         return res.status(404).json({ error: 'Cas non trouvé' });
    if (c.status === 'validated')   return res.status(409).json({ error: 'Cas déjà validé' });

    const data = req.body;
    const db   = await getDb();
    const now  = new Date().toISOString();

    const cols = ['patient_age','patient_sex','patient_weight','reporter_name','reporter_type','reporter_country',
                  'drug_name','drug_dose','drug_route','drug_start_date','adr_description','adr_onset_date',
                  'adr_outcome','seriousness','meddra_pt_code','meddra_pt_name'];
    const sets = [], vals = [];
    for (const col of cols) {
      const key = col.replace(/_([a-z])/g, (_, l) => l.toUpperCase()); // snake → camel fallback
      const val = data[col] ?? data[key];
      if (val !== undefined) { sets.push(`${col}=?`); vals.push(val); }
    }
    if (sets.length) { vals.push(req.params.id); db.run(`UPDATE extracted_fields SET ${sets.join(',')} WHERE case_id=?`, vals); }

    db.run('UPDATE icsr_cases SET status=?,validated_at=?,validated_by=? WHERE id=?',
      ['validated', now, data.validated_by||'system', req.params.id]);
    _saveDb();
    await dbInsertAudit(req.params.id, 'case_validated', req.ip, data.validated_by||null);

    // Auto-lookup MedDRA si PT non renseigné
    let meddraResult = null;
    if (!data.meddra_pt_code) {
      const f = await dbGetFields(req.params.id);
      if (f?.meddra_search_term) {
        meddraResult = await meddraLookup(f.meddra_search_term);
        if (meddraResult.top) {
          db.run('UPDATE extracted_fields SET meddra_pt_code=?,meddra_pt_name=? WHERE case_id=?',
            [meddraResult.top.pt_code, meddraResult.top.pt_name, req.params.id]);
          _saveDb();
        }
      }
    }

    return res.json({
      case_id: req.params.id, status: 'validated', validated_at: now,
      meddra_resolved: meddraResult?.top || null,
      next_steps: [
        `CIOMS I PDF : GET /api/cases/${req.params.id}/export/pdf`,
        `E2B(R3) XML : GET /api/cases/${req.params.id}/export/e2b`,
      ],
    });
  } catch (err) {
    console.error('[VALIDATE]', err.message);
    return res.status(500).json({ error: 'Erreur validation', details: process.env.NODE_ENV==='development' ? err.message : undefined });
  }
});

// ─── GET /api/cases/:id/export/pdf ───────────────────────────────────────────

app.get('/api/cases/:id/export/pdf', async (req, res) => {
  try {
    const c = await dbGetCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'Cas non trouvé' });
    const f = await dbGetFields(req.params.id);
    if (!f) return res.status(404).json({ error: 'Champs du cas introuvables' });

    // Sanitiser les champs pour éviter les crashs PDFKit
    const safeFields = {};
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === 'string') {
        // Remplacer caractères non supportés par PDFKit
        safeFields[k] = v.replace(/[ --]/g, '').substring(0, 2000);
      } else {
        safeFields[k] = v;
      }
    }

    const buf = await generateCiomsIPdf({ ...c, fields: safeFields });
    const name = `PharmaVeil_CIOMS-I_PV-${req.params.id.substring(0,8).toUpperCase()}_${new Date().toISOString().slice(0,10)}.pdf`;
    res.set({ 'Content-Type':'application/pdf', 'Content-Disposition':`attachment; filename="${name}"`, 'Content-Length': buf.length });
    return res.send(buf);
  } catch (err) {
    console.error('[PDF]', err.message, err.stack);
    return res.status(500).json({ error: 'Erreur génération PDF', details: err.message });
  }
});

// ─── F8: Validation XML E2B avant export ─────────────────────────────────────

function validateE2bXml(xmlString) {
  const errors = [];
  const warnings = [];

  // Vérifications structurelles obligatoires ICH E2B(R3)
  const required = [
    { tag: 'ichicsrmessageheader', label: 'Message header' },
    { tag: 'messagetype',          label: 'Message type' },
    { tag: 'messageformatversion', label: 'Message format version' },
    { tag: 'messagenumb',          label: 'Message number' },
    { tag: 'safetyreport',         label: 'Safety report' },
    { tag: 'safetyreportid',       label: 'Safety report ID' },
    { tag: 'serious',              label: 'Seriousness flag' },
    { tag: 'patient',              label: 'Patient block' },
    { tag: 'drug',                 label: 'Drug block' },
    { tag: 'reaction',             label: 'Reaction block' },
    { tag: 'medicinalproduct',     label: 'Medicinal product name' },
    { tag: 'primarysourcereaction',label: 'Primary source reaction' },
    { tag: 'reactionmeddrapt',     label: 'MedDRA PT term' },
    { tag: 'transmissiondate',     label: 'Transmission date' },
  ];

  for (const { tag, label } of required) {
    if (!xmlString.includes(`<${tag}>`)) {
      errors.push(`Missing required element: <${tag}> (${label})`);
    }
  }

  // Vérification valeurs seriousness (doit être 1 ou 2)
  const seriousMatch = xmlString.match(/<serious>(\d+)<\/serious>/);
  if (seriousMatch && !['1','2'].includes(seriousMatch[1])) {
    errors.push(`Invalid seriousness value: ${seriousMatch[1]} (must be 1 or 2)`);
  }

  // Vérification date format (YYYYMMDD)
  const dateMatches = xmlString.matchAll(/<transmissiondate>(\d+)<\/transmissiondate>/g);
  for (const m of dateMatches) {
    if (m[1].length !== 8) warnings.push(`Transmission date format may be invalid: ${m[1]}`);
  }

  // Vérification messageformatversion
  if (!xmlString.includes('<messageformatversion>2.1</messageformatversion>')) {
    warnings.push('Message format version should be 2.1 for E2B(R3)');
  }

  // Vérification encoding
  if (!xmlString.includes('encoding="UTF-8"')) {
    warnings.push('XML encoding should be UTF-8');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    score: Math.max(0, 100 - (errors.length * 20) - (warnings.length * 5)),
  };
}

// ─── GET /api/cases/:id/export/e2b ───────────────────────────────────────────

app.get('/api/cases/:id/export/e2b', async (req, res) => {
  try {
    const { create } = require('xmlbuilder2');
    const c = await dbGetCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'Cas non trouvé' });
    const f = await dbGetFields(req.params.id);
    const ref = req.params.id.substring(0, 8).toUpperCase();
    const serious = (c.seriousness && c.seriousness !== 'non-serious') ? '1' : '2';

    const xml = create({ version:'1.0', encoding:'UTF-8' })
      .ele('ichicsr', { 'xmlns':'urn:hl7-org:v3', schemaVersion:'2.1' })
        .ele('ichicsrmessageheader')
          .ele('messagetype').txt('ichicsr').up()
          .ele('messageformatversion').txt('2.1').up()
          .ele('messagenumb').txt(`PV-${ref}`).up()
          .ele('messagesenderidentifier').txt('pharmaveil.eu').up()
          .ele('messagereceiveridentifier').txt('EV').up()
          .ele('messagedate').txt(new Date().toISOString().replace(/[-:T.Z]/g,'').substring(0,14)).up()
        .up()
        .ele('safetyreport')
          .ele('safetyreportid').txt(`PV-${ref}`).up()
          .ele('primarysourcecountry').txt(f?.reporter_country||'FR').up()
          .ele('transmissiondate').txt(new Date().toISOString().slice(0,10).replace(/-/g,'')).up()
          .ele('reporttype').txt('1').up()
          .ele('serious').txt(serious).up()
          .ele('patient')
            .ele('patientsex').txt(f?.patient_sex==='M'?'1':f?.patient_sex==='F'?'2':'0').up()
            .ele('patientonsetage').txt(f?.patient_age?.replace(/[^\d]/g,'')||'').up()
            .ele('drug')
              .ele('drugcharacterization').txt('1').up()
              .ele('medicinalproduct').txt(f?.drug_name||'').up()
              .ele('drugdosagetext').txt([f?.drug_dose,f?.drug_route].filter(Boolean).join(' — ')).up()
            .up()
            .ele('reaction')
              .ele('primarysourcereaction').txt(f?.adr_description||'').up()
              .ele('reactionmeddraversionllt').txt('27.0').up()
              .ele('reactionmeddrapt').txt(f?.meddra_pt_name||f?.meddra_search_term||'').up()
            .up()
          .up()
        .up()
      .end({ prettyPrint: true });

    // F8 — Validation XML avant export
    const validation = validateE2bXml(xml);
    const name = `PharmaVeil_E2B-R3_PV-${ref}_${new Date().toISOString().slice(0,10)}.xml`;

    // Si erreurs critiques et mode strict, bloquer l'export
    if (!validation.valid && req.query.strict === 'true') {
      return res.status(422).json({
        error: 'E2B XML validation failed',
        validation,
      });
    }

    // Ajouter rapport de validation en commentaire XML
    const validationComment = `
<!-- PharmaVeil E2B(R3) Validation Report
     Valid: ${validation.valid}
     Score: ${validation.score}/100
     Errors: ${validation.errors.length > 0 ? validation.errors.join('; ') : 'none'}
     Warnings: ${validation.warnings.length > 0 ? validation.warnings.join('; ') : 'none'}
     Generated: ${new Date().toISOString()}
-->`;
    const xmlWithValidation = xml.replace('<?xml version="1.0" encoding="UTF-8"?>', `<?xml version="1.0" encoding="UTF-8"?>${validationComment}`);

    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-PharmaVeil-Validation-Score': String(validation.score),
      'X-PharmaVeil-Validation-Valid': String(validation.valid),
      'X-PharmaVeil-Validation-Errors': String(validation.errors.length),
    });
    return res.send(xmlWithValidation);
  } catch (err) {
    return res.status(500).json({ error: 'Erreur export E2B', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  MLM — Screening Littérature (Literature Monitoring)
// ═══════════════════════════════════════════════════════════════════

// Table MLM — créer si inexistante
async function _initMlmTable() {
  const db = await getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS mlm_batches (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      molecule TEXT,
      keywords TEXT,
      articles_submitted INTEGER DEFAULT 0,
      articles_relevant INTEGER DEFAULT 0,
      cases_detected INTEGER DEFAULT 0,
      status TEXT DEFAULT 'processing',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mlm_articles (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      title TEXT,
      content TEXT,
      relevant INTEGER DEFAULT 0,
      relevance_score REAL DEFAULT 0,
      relevance_reason TEXT,
      cases_count INTEGER DEFAULT 0,
      cases_extracted TEXT,
      processed_at TEXT,
      FOREIGN KEY (batch_id) REFERENCES mlm_batches(id)
    );
  `);
  _saveDb();
}

// Analyser un article pour détecter des cas PV
async function analyzeArticleForPV(articleText, molecule, keywords) {
  const client = getAnthropicClient();

  const molTarget = molecule || "toute molecule";
  const kwTarget = keywords || "effets indesirables, adverse event, adverse drug reaction";
  const articleSnippet = articleText.substring(0, 6000);
  const prompt = [
    "Tu es un expert en pharmacovigilance specialise dans le Medical Literature Monitoring (MLM) selon GVP Module VI.",
    "",
    "MISSION : Analyser cet article scientifique pour detecter des cas de pharmacovigilance valides.",
    "",
    "MOLECULE CIBLE : " + molTarget,
    "MOTS-CLES : " + kwTarget,
    "",
    "ARTICLE :",
    articleSnippet,
    "",
    "CRITERES CAS VALIDE (ICH E2A) :",
    "1. Patient identifiable (age, sexe ou initiales)",
    "2. Rapporteur identifiable (auteur, medecin)",
    "3. Medicament suspect mentionne",
    "4. Effet indesirable decrit",
    "",
    'Reponds UNIQUEMENT avec ce JSON :',
    '{"relevant":false,"relevance_score":0.0,"relevance_reason":"","cases_count":0,"cases":[]}',
    "",
    "Si relevant=true, inclure dans cases[] :",
    '[{"patient_age":null,"patient_sex":null,"drug_name":null,"drug_dose":null,"adr_description":null,"adr_outcome":null,"reporter_name":null,"meddra_term":null,"seriousness":"non-serious"}]',
  ].join("\n");

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0]?.text || '{}';
  return _parseJson(raw);
}

// POST /api/mlm/screen — Soumettre un lot d'articles
app.post('/api/mlm/screen', async (req, res) => {
  const t0 = Date.now();
  try {
    await _initMlmTable();
    const { articles, molecule, keywords, org_id } = req.body;

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'articles[] requis — array de {title, content}' });
    }
    if (articles.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 articles par batch' });
    }

    const orgId = org_id || 'default';
    const batchId = crypto.randomUUID();
    const db = await getDb();

    // Créer le batch
    db.run(
      'INSERT INTO mlm_batches (id,org_id,molecule,keywords,articles_submitted,status,created_at) VALUES (?,?,?,?,?,?,?)',
      [batchId, orgId, molecule||null, keywords||null, articles.length, 'processing', new Date().toISOString()]
    );
    _saveDb();

    // Analyser chaque article en parallèle (max 5 simultanés)
    let relevantCount = 0;
    let casesCount = 0;
    const results = [];

    for (let i = 0; i < articles.length; i += 5) {
      const batch = articles.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(async (article) => {
        const articleId = crypto.randomUUID();
        let analysis = { relevant: false, relevance_score: 0, relevance_reason: 'Erreur analyse', cases_count: 0, cases: [] };

        try {
          analysis = await analyzeArticleForPV(article.content || article.text || '', molecule, keywords);
        } catch (err) {
          console.warn('[MLM] Article analysis failed:', err.message);
        }

        db.run(
          'INSERT INTO mlm_articles (id,batch_id,title,content,relevant,relevance_score,relevance_reason,cases_count,cases_extracted,processed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [articleId, batchId, article.title||'Sans titre', (article.content||'').substring(0,5000),
           analysis.relevant?1:0, analysis.relevance_score||0, analysis.relevance_reason||'',
           analysis.cases_count||0, analysis.cases?.length>0?JSON.stringify(analysis.cases):null,
           new Date().toISOString()]
        );
        _saveDb();

        if (analysis.relevant) { relevantCount++; casesCount += analysis.cases_count||0; }

        return {
          article_id: articleId,
          title: article.title || 'Sans titre',
          relevant: analysis.relevant,
          relevance_score: analysis.relevance_score,
          relevance_reason: analysis.relevance_reason,
          cases_count: analysis.cases_count || 0,
          cases: analysis.cases || [],
        };
      }));
      results.push(...batchResults);
    }

    // Mettre à jour le batch
    db.run(
      'UPDATE mlm_batches SET articles_relevant=?,cases_detected=?,status=? WHERE id=?',
      [relevantCount, casesCount, 'completed', batchId]
    );
    _saveDb();

    return res.status(201).json({
      batch_id: batchId,
      status: 'completed',
      molecule,
      keywords,
      stats: {
        submitted: articles.length,
        relevant: relevantCount,
        not_relevant: articles.length - relevantCount,
        cases_detected: casesCount,
        detection_rate: Math.round((relevantCount / articles.length) * 100) + '%',
      },
      articles: results,
      processing_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[MLM_SCREEN]', err.message);
    return res.status(500).json({ error: 'Erreur screening', details: err.message });
  }
});

// POST /api/mlm/import-cases — Importer les cas détectés dans PharmaVeil
app.post('/api/mlm/import-cases', async (req, res) => {
  const t0 = Date.now();
  try {
    await _initMlmTable();
    const { batch_id, article_ids, org_id } = req.body;
    if (!batch_id) return res.status(400).json({ error: 'batch_id requis' });

    const orgId = org_id || 'default';
    const db = await getDb();

    // Récupérer les articles du batch avec des cas
    let query = 'SELECT * FROM mlm_articles WHERE batch_id=? AND relevant=1 AND cases_extracted IS NOT NULL';
    const params = [batch_id];
    if (article_ids?.length > 0) {
      query += ' AND id IN (' + article_ids.map(() => '?').join(',') + ')';
      params.push(...article_ids);
    }

    const stmt = db.prepare(query);
    stmt.bind(params);
    const articles = [];
    while (stmt.step()) articles.push(stmt.getAsObject());
    stmt.free();

    if (articles.length === 0) {
      return res.status(404).json({ error: 'Aucun article avec des cas trouvé' });
    }

    const importedCases = [];

    for (const article of articles) {
      let cases = [];
      try { cases = JSON.parse(article.cases_extracted || '[]'); } catch {}

      for (const c of cases) {
        const caseId = crypto.randomUUID();
        const deadlines = _calcDeadlines(
          c.seriousness && c.seriousness !== 'non-serious',
          []
        );

        await dbInsertCase({
          id: caseId, orgId, status: 'pending_validation',
          sourceType: 'literature_mlm',
          rawContent: ('Article: ' + (article.title||'') + ' | ' + (article.content||'').substring(0,1000)),
          receivedAt: new Date().toISOString(),
          deadline7:  deadlines.deadline7?.toISOString()  || null,
          deadline15: deadlines.deadline15?.toISOString() || null,
          deadline90: deadlines.deadline90?.toISOString() || null,
          seriousness: c.seriousness || 'non-serious',
          reportType: 'literature',
          reporterQualification: 'author',
        });

        // Générer narrative
        let narrative = null;
        try { narrative = await generateNarrative({ ...c, reporterType: 'author' }); } catch {}

        await dbInsertFields({
          id: crypto.randomUUID(), caseId,
          patientAge: c.patient_age, patientSex: c.patient_sex,
          reporterName: c.reporter_name || article.title,
          reporterType: 'author',
          drugName: c.drug_name, drugDose: c.drug_dose,
          adrDescription: c.adr_description,
          adrOutcome: c.adr_outcome,
          seriousness: c.seriousness || 'non-serious',
          meddraSearchTerm: c.meddra_term || c.adr_description,
          narrative,
          confidenceScore: 0.75,
          confidenceFlag: 'orange',
          gvpValid: !!(c.drug_name && c.adr_description),
          rawLlmOutput: null,
        });

        await dbInsertAudit(caseId, 'case_created_mlm', 'system');
        importedCases.push({ case_id: caseId, drug: c.drug_name, adr: c.adr_description });
      }
    }

    return res.status(201).json({
      imported: importedCases.length,
      cases: importedCases,
      processing_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[MLM_IMPORT]', err.message);
    return res.status(500).json({ error: 'Erreur import cas', details: err.message });
  }
});

// GET /api/mlm/batches — Historique des batches MLM
app.get('/api/mlm/batches', async (req, res) => {
  try {
    await _initMlmTable();
    const { org_id } = req.query;
    const db = await getDb();
    const stmt = db.prepare(
      'SELECT * FROM mlm_batches WHERE org_id=? ORDER BY created_at DESC LIMIT 20'
    );
    stmt.bind([org_id || 'default']);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return res.json({ batches: rows, total: rows.length });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur MLM', details: err.message });
  }
});

// GET /api/mlm/batches/:id — Détail d'un batch
app.get('/api/mlm/batches/:id', async (req, res) => {
  try {
    await _initMlmTable();
    const db = await getDb();
    const batchStmt = db.prepare('SELECT * FROM mlm_batches WHERE id=?');
    const batch = batchStmt.getAsObject([req.params.id]);
    batchStmt.free();
    if (!batch.id) return res.status(404).json({ error: 'Batch non trouvé' });

    const artStmt = db.prepare('SELECT * FROM mlm_articles WHERE batch_id=? ORDER BY relevance_score DESC');
    artStmt.bind([req.params.id]);
    const articles = [];
    while (artStmt.step()) articles.push(artStmt.getAsObject());
    artStmt.free();

    return res.json({ ...batch, articles });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur MLM', details: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
//  REGINTEL — PharmaVeil Regulatory Intelligence
// ═══════════════════════════════════════════════════════════════════

// Sources réglementaires surveillées
const REGINTEL_SOURCES = {
  EMA: {
    name: 'European Medicines Agency',
    region: 'Europe',
    url: 'https://www.ema.europa.eu/en/news/whats-new',
    focus: ['GVP', 'pharmacovigilance', 'safety', 'guideline', 'ICSR'],
    color: '#0066cc',
  },
  ANSM: {
    name: 'Agence Nationale de Sécurité du Médicament',
    region: 'France',
    url: 'https://ansm.sante.fr/actualites',
    focus: ['pharmacovigilance', 'sécurité', 'décision', 'guideline'],
    color: '#003189',
  },
  FDA: {
    name: 'Food and Drug Administration',
    region: 'USA',
    url: 'https://www.fda.gov/drugs/news-events-human-drugs',
    focus: ['pharmacovigilance', 'safety', 'guidance', 'FAERS', 'MedWatch'],
    color: '#cc0000',
  },
  SAHPRA: {
    name: 'South African Health Products Regulatory Authority',
    region: 'South Africa',
    url: 'https://www.sahpra.org.za/news',
    focus: ['pharmacovigilance', 'safety', 'guideline', 'circular'],
    color: '#007a4d',
  },
  ICH: {
    name: 'International Council for Harmonisation',
    region: 'International',
    url: 'https://www.ich.org/page/news',
    focus: ['E2A', 'E2B', 'E2C', 'E2D', 'guideline', 'pharmacovigilance'],
    color: '#6600cc',
  },
  MHRA: {
    name: 'Medicines and Healthcare products Regulatory Agency',
    region: 'UK',
    url: 'https://www.gov.uk/drug-safety-update',
    focus: ['pharmacovigilance', 'safety', 'yellow card', 'guideline'],
    color: '#00205b',
  },
};

// Table RegIntel — version étendue (spec Marie-Adrienne)
async function _initRegIntelTable() {
  const db = await getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS regintel_updates (
      id TEXT PRIMARY KEY,
      org_id TEXT DEFAULT 'global',
      source_code TEXT NOT NULL,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      published_date TEXT,
      raw_content TEXT,
      summary TEXT,
      impact_action TEXT,
      source_page TEXT,
      impact_score TEXT DEFAULT 'info',
      impact_reason TEXT,
      vigilance_type TEXT DEFAULT 'pv',
      keywords TEXT,
      relevant_for TEXT,
      affects_deadlines INTEGER DEFAULT 0,
      affects_meddra INTEGER DEFAULT 0,
      affects_e2b INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS regintel_digests (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      week_start TEXT NOT NULL,
      content TEXT,
      updates_count INTEGER DEFAULT 0,
      critical_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS regintel_profiles (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL UNIQUE,
      countries TEXT DEFAULT '["FR","EU"]',
      vigilance_types TEXT DEFAULT '["pv"]',
      therapeutic_classes TEXT DEFAULT '[]',
      dci_list TEXT DEFAULT '[]',
      alert_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS regintel_tasks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      update_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      priority TEXT DEFAULT 'important',
      assigned_to TEXT,
      due_date TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS regintel_task_audit (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ri_org   ON regintel_updates(org_id);
    CREATE INDEX IF NOT EXISTS idx_ri_score ON regintel_updates(impact_score);
    CREATE INDEX IF NOT EXISTS idx_ri_vtype ON regintel_updates(vigilance_type);
    CREATE INDEX IF NOT EXISTS idx_task_org ON regintel_tasks(org_id);
  `);
  // Migrations colonnes pour DB existantes
  const cols = ['vigilance_type','impact_action','source_page','org_id','status',
    'affects_deadlines','affects_meddra','affects_e2b'];
  for (const col of cols) {
    try {
      const type = col.startsWith('affects_') ? 'INTEGER DEFAULT 0'
        : col==='org_id' ? "TEXT DEFAULT 'global'"
        : col==='status' ? "TEXT DEFAULT 'new'"
        : col==='vigilance_type' ? "TEXT DEFAULT 'pv'"
        : 'TEXT';
      db.run(`ALTER TABLE regintel_updates ADD COLUMN ${col} ${type}`);
    } catch {}
  }
  _saveDb();
}

// Analyser un update réglementaire avec Claude — version enrichie Marie-Adrienne
async function analyzeRegulatoryUpdate(title, content, source) {
  try {
    const client = getAnthropicClient();
    const prompt = [
      "You are a senior pharmacovigilance regulatory expert (QPPV level).",
      "Analyze this regulatory update and provide a structured assessment in JSON.",
      "",
      "SOURCE: " + source,
      "TITLE: " + title,
      "CONTENT: " + (content || title).substring(0, 4000),
      "",
      "Provide ONLY this JSON (no text before/after):",
      JSON.stringify({
        summary: "Executive summary in 5-8 lines maximum — plain language, factual",
        impact_action: "→ SO WHAT: Exact operational impact for PV teams. Be specific: 'Submission deadline for non-serious cases changes from 90 to X days in Y country from DATE.' or null if no direct action needed",
        source_page: "Exact page or section reference if applicable, e.g. 'Page 42, Section 3.1' or null",
        impact_score: "critical|important|info",
        impact_reason: "Why this matters for PV operations in 1 sentence",
        vigilance_type: "pv|materio|nutri|cosmeto",
        relevant_for: ["QPPV","DSO","regulatory_affairs","clinical_safety"],
        keywords: ["keyword1","keyword2","keyword3"],
        affects_deadlines: false,
        affects_meddra: false,
        affects_e2b: false,
        action_required: "What PV teams should do now, or null",
        deadline: "Compliance deadline if applicable, or null",
        countries: ["FR","EU","US","UK","JP","ZA"],
      })
    ].join("\n");

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' },
      ],
    });

    const raw = '{' + (response.content[0]?.text || '');
    return _parseJson(raw);
  } catch (err) {
    console.warn('[REGINTEL] Analysis failed:', err.message);
    return { summary: content?.substring(0, 200) || title, impact_score: 'info', vigilance_type: 'pv' };
  }
}

// POST /api/regintel/submit — Soumettre manuellement un update réglementaire
app.post('/api/regintel/submit', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { title, url, content, source_code, published_date } = req.body;
    if (!title || !source_code) {
      return res.status(400).json({ error: 'title et source_code requis' });
    }
    if (!REGINTEL_SOURCES[source_code.toUpperCase()]) {
      return res.status(400).json({ error: 'source_code invalide. Options: ' + Object.keys(REGINTEL_SOURCES).join(', ') });
    }

    const source = REGINTEL_SOURCES[source_code.toUpperCase()];
    const analysis = await analyzeRegulatoryUpdate(title, content, source.name);
    const id = crypto.randomUUID();
    const db = await getDb();

    db.run(
      'INSERT INTO regintel_updates (id,source_code,source_name,title,url,published_date,raw_content,summary,impact_score,impact_reason,keywords,relevant_for,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, source_code.toUpperCase(), source.name, title, url||null,
       published_date || new Date().toISOString().slice(0,10),
       (content||'').substring(0,5000),
       analysis.summary, analysis.impact_score, analysis.impact_reason,
       JSON.stringify(analysis.keywords || []),
       JSON.stringify(analysis.relevant_for || []),
       new Date().toISOString()]
    );
    _saveDb();

    return res.status(201).json({
      id, title, source: source.name,
      impact_score: analysis.impact_score,
      summary: analysis.summary,
      impact_reason: analysis.impact_reason,
      action_required: analysis.action_required,
      affects_deadlines: analysis.affects_deadlines,
      affects_e2b: analysis.affects_e2b,
    });
  } catch (err) {
    console.error('[REGINTEL_SUBMIT]', err.message);
    return res.status(500).json({ error: 'Erreur RegIntel', details: err.message });
  }
});

// GET /api/regintel/updates — Feed des updates réglementaires
app.get('/api/regintel/updates', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { source, impact, limit = 20, offset = 0 } = req.query;
    const db = await getDb();

    let q = 'SELECT * FROM regintel_updates WHERE 1=1';
    const params = [];
    if (source) { q += ' AND source_code=?'; params.push(source.toUpperCase()); }
    if (impact) { q += ' AND impact_score=?'; params.push(impact); }
    q += ' ORDER BY published_date DESC, created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const stmt = db.prepare(q);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      try { row.keywords = JSON.parse(row.keywords || '[]'); } catch { row.keywords = []; }
      try { row.relevant_for = JSON.parse(row.relevant_for || '[]'); } catch { row.relevant_for = []; }
      rows.push(row);
    }
    stmt.free();

    return res.json({ updates: rows, total: rows.length });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur RegIntel', details: err.message });
  }
});

// GET /api/regintel/sources — Liste des sources surveillées
app.get('/api/regintel/sources', (req, res) => {
  const sources = Object.entries(REGINTEL_SOURCES).map(([code, s]) => ({
    code, name: s.name, region: s.region, url: s.url, color: s.color,
  }));
  return res.json({ sources });
});

// POST /api/regintel/digest — Générer un digest hebdomadaire
app.post('/api/regintel/digest', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { org_id } = req.body;
    const orgId = org_id || 'default';
    const db = await getDb();

    // Récupérer les updates de la semaine
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const stmt = db.prepare('SELECT * FROM regintel_updates WHERE created_at>=? ORDER BY impact_score ASC, published_date DESC LIMIT 30');
    stmt.bind([since]);
    const updates = [];
    while (stmt.step()) updates.push(stmt.getAsObject());
    stmt.free();

    if (updates.length === 0) {
      return res.json({ message: 'Aucune mise à jour cette semaine', updates_count: 0 });
    }

    const critical = updates.filter(u => u.impact_score === 'critical');
    const important = updates.filter(u => u.impact_score === 'important');
    const info = updates.filter(u => u.impact_score === 'info');

    // Générer le digest avec Claude
    const client = getAnthropicClient();
    const updatesText = updates.map(u => "- [" + u.impact_score.toUpperCase() + "] " + u.source_name + ": " + u.title + " — " + u.summary).join("\n");
    const digestPrompt = "Generate a professional weekly pharmacovigilance regulatory intelligence digest in English.\n\n"
      + "Updates this week:\n" + updatesText
      + "\n\nWrite a 3-paragraph executive summary:\n"
      + "1. Critical items requiring immediate action\n"
      + "2. Important updates to be aware of\n"
      + "3. Upcoming regulatory trends to monitor\n\n"
      + "Keep it professional, concise, and actionable. No JSON.";

    const digestResp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: digestPrompt }],
    });

    const digestContent = digestResp.content[0]?.text || '';
    const digestId = crypto.randomUUID();
    const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0,10);

    db.run(
      'INSERT INTO regintel_digests (id,org_id,week_start,content,updates_count,critical_count,created_at) VALUES (?,?,?,?,?,?,?)',
      [digestId, orgId, weekStart, digestContent, updates.length, critical.length, new Date().toISOString()]
    );
    _saveDb();

    return res.json({
      digest_id: digestId,
      week_start: weekStart,
      updates_count: updates.length,
      critical_count: critical.length,
      important_count: important.length,
      info_count: info.length,
      digest: digestContent,
    });
  } catch (err) {
    console.error('[REGINTEL_DIGEST]', err.message);
    return res.status(500).json({ error: 'Erreur digest', details: err.message });
  }
});

// Seed initial — quelques updates réglementaires récents pour la démo
async function _seedRegIntel() {
  await _initRegIntelTable();
  const db = await getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM regintel_updates').getAsObject([]);
  if (existing.c > 0) return;

  const seedUpdates = [
    {
      source_code: 'EMA',
      title: 'GVP Module VI Revision 3 — Updated guidance on ICSR reporting timelines',
      url: 'https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/guideline-good-pharmacovigilance-practices-gvp-module-vi-collection-management-submission-reports_en.pdf',
      published_date: '2025-01-15',
      content: 'The EMA has published Revision 3 of GVP Module VI clarifying the Day 0 definition for ICSR reporting. The revision confirms that the clock starts when any employee of the MAH becomes aware of the case, regardless of completeness. New guidance on electronic submissions via EudraVigilance gateway is included.',
      impact_score: 'critical',
      summary: 'EMA clarifies Day 0 definition — clock starts at first employee awareness. Electronic submission requirements updated for EudraVigilance.',
      impact_reason: 'Directly impacts 7/15/90-day deadline calculations for all MAHs in Europe',
    },
    {
      source_code: 'FDA',
      title: 'FDA Updates MedWatch 3500A Form — New fields for biologics',
      url: 'https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program',
      published_date: '2025-02-03',
      content: 'FDA has updated the MedWatch 3500A form to include new mandatory fields for biological products and biosimilars. The update introduces a new section for product lot number and expiry date. Effective date for mandatory compliance is Q3 2025.',
      impact_score: 'important',
      summary: 'MedWatch 3500A updated with new mandatory fields for biologics. Lot number and expiry date now required.',
      impact_reason: 'MAHs with biologics or biosimilars must update their ICSR templates before Q3 2025',
    },
    {
      source_code: 'ICH',
      title: 'ICH E2B(R3) Implementation Working Group — New Q&A on XML validation',
      url: 'https://www.ich.org/page/e2br3-implementation-working-group',
      published_date: '2025-02-20',
      content: 'The ICH E2B(R3) Implementation Working Group has published new Q&A clarifying XML validation requirements. The document addresses common errors in E2B(R3) submissions and provides guidance on handling missing mandatory elements.',
      impact_score: 'important',
      summary: 'New ICH Q&A clarifies E2B(R3) XML validation requirements and common submission errors.',
      impact_reason: 'PV teams should review their XML generation process against the new Q&A to avoid rejection',
    },
    {
      source_code: 'SAHPRA',
      title: 'SAHPRA Circular — Mandatory VigiFlow registration for all MAHs by June 2025',
      url: 'https://www.sahpra.org.za',
      published_date: '2025-01-28',
      content: 'SAHPRA has issued a circular requiring all Medicine Authorization Holders to register on VigiFlow for electronic ICSR submission by 30 June 2025. Paper submissions will no longer be accepted after this date.',
      impact_score: 'critical',
      summary: 'SAHPRA mandates VigiFlow registration for all MAHs by June 2025. Paper submissions discontinued.',
      impact_reason: 'MAHs operating in South Africa must register on VigiFlow immediately to avoid non-compliance',
    },
    {
      source_code: 'ANSM',
      title: 'ANSM — Mise à jour des exigences de déclaration pour les médicaments génériques',
      url: 'https://ansm.sante.fr',
      published_date: '2025-03-01',
      content: "L'ANSM a publié une mise à jour des exigences de déclaration des effets indésirables pour les médicaments génériques. Les délais de soumission restent inchangés mais les critères de validité sont précisés pour les médicaments à base de plantes.",
      impact_score: 'info',
      summary: "L'ANSM précise les critères de validité des ICSRs pour les médicaments à base de plantes. Délais inchangés.",
      impact_reason: 'MAHs avec des produits à base de plantes doivent vérifier leurs procédures de collecte',
    },
  ];

  for (const u of seedUpdates) {
    const id = crypto.randomUUID();
    db.run(
      'INSERT OR IGNORE INTO regintel_updates (id,source_code,source_name,title,url,published_date,raw_content,summary,impact_score,impact_reason,keywords,relevant_for,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, u.source_code, REGINTEL_SOURCES[u.source_code].name, u.title, u.url||null,
       u.published_date, u.content, u.summary, u.impact_score, u.impact_reason,
       '[]', '["QPPV","DSO"]', new Date().toISOString()]
    );
  }
  _saveDb();
  console.log('[REGINTEL] Seed completed —', seedUpdates.length, 'updates');
}

// Initialiser RegIntel au démarrage
_seedRegIntel().catch(err => console.warn('[REGINTEL_SEED]', err.message));

// ═══════════════════════════════════════════════════════════════════
//  9-A-BIS. REGINTEL ENRICHI — SPEC MARIE-ADRIENNE
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/regintel/profile — profil réglementaire org ─────────────────────
app.get('/api/regintel/profile', async (req, res) => {
  try {
    await _initRegIntelTable();
    const orgId = req.query.org_id || 'default';
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM regintel_profiles WHERE org_id=?');
    const row = stmt.getAsObject([orgId]);
    stmt.free();
    if (!row.id) {
      return res.json({
        org_id: orgId, countries: ['FR','EU'], vigilance_types: ['pv'],
        therapeutic_classes: [], dci_list: [], alert_email: null,
      });
    }
    return res.json({
      ...row,
      countries: JSON.parse(row.countries||'[]'),
      vigilance_types: JSON.parse(row.vigilance_types||'[]'),
      therapeutic_classes: JSON.parse(row.therapeutic_classes||'[]'),
      dci_list: JSON.parse(row.dci_list||'[]'),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/regintel/profile — sauvegarder profil ─────────────────────────
app.post('/api/regintel/profile', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { org_id='default', countries=[], vigilance_types=['pv'],
      therapeutic_classes=[], dci_list=[], alert_email=null } = req.body;
    const db = await getDb();
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM regintel_profiles WHERE org_id=?').getAsObject([org_id]);
    if (existing.id) {
      db.run('UPDATE regintel_profiles SET countries=?,vigilance_types=?,therapeutic_classes=?,dci_list=?,alert_email=?,updated_at=? WHERE org_id=?',
        [JSON.stringify(countries), JSON.stringify(vigilance_types), JSON.stringify(therapeutic_classes),
         JSON.stringify(dci_list), alert_email, now, org_id]);
    } else {
      db.run('INSERT INTO regintel_profiles (id,org_id,countries,vigilance_types,therapeutic_classes,dci_list,alert_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), org_id, JSON.stringify(countries), JSON.stringify(vigilance_types),
         JSON.stringify(therapeutic_classes), JSON.stringify(dci_list), alert_email, now, now]);
    }
    _saveDb();
    return res.json({ success: true, org_id, updated_at: now });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/regintel/tasks — liste des tâches Kanban ────────────────────────
app.get('/api/regintel/tasks', async (req, res) => {
  try {
    await _initRegIntelTable();
    const orgId = req.query.org_id || 'default';
    const status = req.query.status || null;
    const db = await getDb();
    let sql = `
      SELECT t.*, u.title as update_title, u.source_name, u.impact_score, u.vigilance_type
      FROM regintel_tasks t
      LEFT JOIN regintel_updates u ON t.update_id = u.id
      WHERE t.org_id=?`;
    const params = [orgId];
    if (status) { sql += ' AND t.status=?'; params.push(status); }
    sql += ' ORDER BY CASE t.priority WHEN "critical" THEN 0 WHEN "important" THEN 1 ELSE 2 END, t.created_at DESC';
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return res.json({ tasks: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/regintel/tasks — créer une tâche depuis une alerte ─────────────
app.post('/api/regintel/tasks', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { org_id='default', update_id, title, description, priority='important',
      assigned_to=null, due_date=null, created_by=null } = req.body;
    if (!title) return res.status(400).json({ error: 'title requis' });
    const db = await getDb();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.run('INSERT INTO regintel_tasks (id,org_id,update_id,title,description,status,priority,assigned_to,due_date,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, org_id, update_id||null, title, description||null, 'new', priority, assigned_to, due_date, created_by, now, now]);
    db.run('INSERT INTO regintel_task_audit (id,task_id,org_id,user_id,action,old_status,new_status,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [crypto.randomUUID(), id, org_id, created_by, 'created', null, 'new', 'Task created from RegIntel alert', now]);
    _saveDb();
    return res.json({ success: true, task_id: id, created_at: now });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/regintel/tasks/:id — mettre à jour statut Kanban ──────────────
app.patch('/api/regintel/tasks/:id', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { id } = req.params;
    const { status, assigned_to, notes, user_id='system', due_date } = req.body;
    const db = await getDb();
    const existing = db.prepare('SELECT * FROM regintel_tasks WHERE id=?').getAsObject([id]);
    if (!existing.id) return res.status(404).json({ error: 'Tâche introuvable' });
    const now = new Date().toISOString();
    const updates = [];
    const params = [];
    if (status) { updates.push('status=?'); params.push(status); }
    if (assigned_to !== undefined) { updates.push('assigned_to=?'); params.push(assigned_to); }
    if (due_date !== undefined) { updates.push('due_date=?'); params.push(due_date); }
    updates.push('updated_at=?'); params.push(now);
    params.push(id);
    db.run(`UPDATE regintel_tasks SET ${updates.join(',')} WHERE id=?`, params);
    if (status && status !== existing.status) {
      db.run('INSERT INTO regintel_task_audit (id,task_id,org_id,user_id,action,old_status,new_status,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), id, existing.org_id, user_id, 'status_change', existing.status, status, notes||null, now]);
    }
    _saveDb();
    return res.json({ success: true, task_id: id, new_status: status || existing.status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/regintel/tasks/:id/audit — piste d'audit d'une tâche ────────────
app.get('/api/regintel/tasks/:id/audit', async (req, res) => {
  try {
    await _initRegIntelTable();
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM regintel_task_audit WHERE task_id=? ORDER BY created_at ASC');
    stmt.bind([req.params.id]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return res.json({ task_id: req.params.id, audit: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/regintel/ingest/pdf — ingestion d'un PDF réglementaire ─────────
const uploadRegIntel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/regintel/ingest/pdf', uploadRegIntel.single('file'), async (req, res) => {
  try {
    await _initRegIntelTable();
    if (!req.file) return res.status(400).json({ error: 'Fichier PDF requis' });
    const { source_code='EMA', org_id='default', published_date } = req.body;
    // Extraire le texte du PDF
    const parsed = await pdfParse(req.file.buffer);
    const text = parsed.text?.substring(0, 8000) || '';
    if (text.length < 50) return res.status(400).json({ error: 'PDF illisible ou vide' });
    const filename = req.file.originalname || 'document.pdf';
    const source = REGINTEL_SOURCES[source_code]?.name || source_code;
    // Analyse IA
    const analysis = await analyzeRegulatoryUpdate(filename, text, source);
    const id = crypto.randomUUID();
    const db = await getDb();
    db.run(
      'INSERT INTO regintel_updates (id,org_id,source_code,source_name,title,published_date,raw_content,summary,impact_action,source_page,impact_score,impact_reason,vigilance_type,keywords,relevant_for,affects_deadlines,affects_meddra,affects_e2b,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, org_id, source_code, source, analysis.summary?.substring(0,100)||filename,
       published_date||new Date().toISOString().slice(0,10),
       text.substring(0,5000), analysis.summary||'', analysis.impact_action||null,
       analysis.source_page||null, analysis.impact_score||'info', analysis.impact_reason||null,
       analysis.vigilance_type||'pv',
       JSON.stringify(analysis.keywords||[]), JSON.stringify(analysis.relevant_for||[]),
       analysis.affects_deadlines?1:0, analysis.affects_meddra?1:0, analysis.affects_e2b?1:0,
       'new', new Date().toISOString()]
    );
    _saveDb();
    return res.json({ success: true, update_id: id, analysis, pages: parsed.numpages });
  } catch (err) {
    console.error('[REGINTEL_PDF]', err.message);
    return res.status(500).json({ error: 'Erreur ingestion PDF', details: err.message });
  }
});

// ─── PATCH /api/regintel/updates/:id/status — marquer comme lu ────────────────
app.patch('/api/regintel/updates/:id/status', async (req, res) => {
  try {
    await _initRegIntelTable();
    const { status='read' } = req.body;
    const db = await getDb();
    db.run('UPDATE regintel_updates SET status=? WHERE id=?', [status, req.params.id]);
    _saveDb();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/regintel/report — rapport d'inspection PDF ──────────────────────
app.get('/api/regintel/report', async (req, res) => {
  try {
    await _initRegIntelTable();
    const orgId = req.query.org_id || 'default';
    const since = req.query.since || new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
    const db = await getDb();

    // Récupérer updates critiques et importantes
    const uStmt = db.prepare(`SELECT * FROM regintel_updates WHERE created_at>=? AND impact_score IN ('critical','important') ORDER BY impact_score ASC, created_at DESC LIMIT 100`);
    uStmt.bind([since+'T00:00:00.000Z']);
    const updates = [];
    while (uStmt.step()) updates.push(uStmt.getAsObject());
    uStmt.free();

    // Récupérer tâches clôturées
    const tStmt = db.prepare(`SELECT t.*, u.title as update_title FROM regintel_tasks t LEFT JOIN regintel_updates u ON t.update_id=u.id WHERE t.org_id=? AND t.updated_at>=? ORDER BY t.updated_at DESC LIMIT 50`);
    tStmt.bind([orgId, since+'T00:00:00.000Z']);
    const tasks = [];
    while (tStmt.step()) tasks.push(tStmt.getAsObject());
    tStmt.free();

    // Générer le PDF
    const doc = new PDFDoc({ size: 'A4', margins: { top:40, bottom:40, left:45, right:45 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      const now = new Date().toLocaleDateString('fr-FR');
      let y = 40;
      const W = 505; // page width usable

      // Header
      doc.rect(45, y, W, 52).fill('#0c1120');
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#00d4aa').text('PharmaVeil', 55, y+10);
      doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,.6)').text('pharmaveil.eu — RegIntel', 55, y+30);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text("RAPPORT D'INSPECTION\nVEILLE RÉGLEMENTAIRE", 380, y+8, {align:'right',width:160});
      y += 66;

      doc.font('Helvetica').fontSize(8).fillColor('#555e7a').text(`Période : ${since} → ${now} · Généré le ${now} · Org : ${orgId}`, 45, y);
      y += 20;

      // Section updates critiques
      doc.rect(45, y, W, 18).fill('#d32f2f');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(`ALERTES CRITIQUES & IMPORTANTES (${updates.length})`, 52, y+5);
      y += 26;

      if (updates.length === 0) {
        doc.font('Helvetica').fontSize(9).fillColor('#555e7a').text('Aucune alerte critique ou importante sur la période.', 45, y);
        y += 18;
      }

      for (const u of updates.slice(0, 30)) {
        if (y > 750) { doc.addPage(); y = 40; }
        const c = u.impact_score === 'critical' ? '#d32f2f' : '#e65100';
        doc.rect(45, y, 5, 28).fill(c);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#0c1120').text(`[${(u.impact_score||'').toUpperCase()}] ${u.source_name} · ${u.published_date||''}`, 55, y+2, {width:W-15});
        doc.font('Helvetica').fontSize(7.5).fillColor('#333').text(u.title||'', 55, y+13, {width:W-15});
        if (u.impact_action) {
          doc.font('Helvetica').fontSize(7).fillColor('#e65100').text('→ '+u.impact_action, 55, y+23, {width:W-15});
          y += 34;
        } else { y += 28; }
        doc.strokeColor('#eee').lineWidth(0.5).moveTo(45,y).lineTo(550,y).stroke();
        y += 6;
      }

      // Section tâches
      y += 10;
      if (y > 700) { doc.addPage(); y = 40; }
      doc.rect(45, y, W, 18).fill('#0c1120');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(`TÂCHES DE CONFORMITÉ (${tasks.length})`, 52, y+5);
      y += 26;

      if (tasks.length === 0) {
        doc.font('Helvetica').fontSize(9).fillColor('#555e7a').text('Aucune tâche enregistrée sur la période.', 45, y);
        y += 18;
      }

      for (const t of tasks.slice(0, 20)) {
        if (y > 750) { doc.addPage(); y = 40; }
        const sc = {new:'#999',read:'#4a9eff',action_required:'#e65100',done:'#2e7d32'}[t.status]||'#999';
        doc.rect(45, y, 5, 22).fill(sc);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#0c1120').text(t.title||'', 55, y+2, {width:W-80});
        doc.font('Helvetica').fontSize(7).fillColor('#555e7a').text(`Statut: ${t.status||'—'} · Assigné: ${t.assigned_to||'—'} · ${t.updated_at?new Date(t.updated_at).toLocaleDateString('fr-FR'):'—'}`, 55, y+13, {width:W-15});
        y += 28;
      }

      // Footer
      const fh = doc.page.height - 45;
      doc.strokeColor('#ddd').lineWidth(0.5).moveTo(45,fh).lineTo(550,fh).stroke();
      doc.font('Helvetica').fontSize(7).fillColor('#888').text(
        `PharmaVeil RegIntel · Rapport d'inspection conforme GVP Module VI · Généré le ${now} · Confidentiel`,
        45, fh+8, {align:'center',width:W}
      );
      doc.end();
    });

    const pdf = Buffer.concat(chunks);
    res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="pharmaveil-regintel-report-${since}.pdf"`,'Content-Length':pdf.length});
    return res.send(pdf);
  } catch (err) {
    console.error('[REGINTEL_REPORT]', err.message);
    return res.status(500).json({ error: 'Erreur rapport', details: err.message });
  }
});



// ═══════════════════════════════════════════════════════════════════
//  9-B. MODULE ASSISTANT SOUMISSION — PHASE 1
// ═══════════════════════════════════════════════════════════════════

// ─── Prompt Pre-Submission Check ────────────────────────────────────────────

function buildPrecheckPrompt(caseData, fields, authorityCode = 'EMA') {
  const authority = AUTHORITY_RULES[authorityCode.toUpperCase()] || AUTHORITY_RULES.EMA;
  return `Tu es un expert en validation des ICSR (Individual Case Safety Reports) selon GVP Module VI et les règles métier EudraVigilance v2.1.

Analyse ce cas ICSR et produis un rapport de validation prédictive pour soumission à ${authority.name}.

DONNÉES DU CAS :
${JSON.stringify({
  source_type: caseData.source_type,
  seriousness: caseData.seriousness,
  status: caseData.status,
  received_at: caseData.received_at,
  deadline_7: caseData.deadline_7,
  deadline_15: caseData.deadline_15,
  deadline_90: caseData.deadline_90,
  patient_age: fields.patient_age,
  patient_sex: fields.patient_sex,
  patient_weight: fields.patient_weight,
  reporter_name: fields.reporter_name,
  reporter_type: fields.reporter_type,
  reporter_country: fields.reporter_country,
  drug_name: fields.drug_name,
  drug_dose: fields.drug_dose,
  drug_route: fields.drug_route,
  drug_start_date: fields.drug_start_date,
  adr_description: fields.adr_description,
  adr_onset_date: fields.adr_onset_date,
  adr_outcome: fields.adr_outcome,
  meddra_pt_code: fields.meddra_pt_code,
  meddra_pt_name: fields.meddra_pt_name,
  confidence_score: fields.confidence_score,
  gvp_valid: fields.gvp_valid,
  narrative: fields.narrative ? 'présent' : 'absent',
}, null, 2)}

AUTORITÉ CIBLE : ${authority.name} (${authority.region})
RÈGLES : ${authority.notes}

Applique les règles de validation suivantes :
1. CRITÈRES MINIMAUX ICH E2A : patient identifiable, médicament suspect, effet indésirable, rapporteur
2. RÈGLES ${authorityCode.toUpperCase()} : ${authority.validity_rules.anonymous_patient_valid ? 'patient anonyme accepté' : 'patient identifiable OBLIGATOIRE'}
3. COMPLÉTUDE E2B(R3) : codage MedDRA PT, voie d'administration, issue de l'EI
4. COHÉRENCE LOGIQUE : dates cohérentes, cas grave = critère gravité coché
5. DÉLAIS GVP : délai respecté depuis réception ?

Réponds UNIQUEMENT avec ce JSON (aucun texte avant/après) :
{
  "completeness_score": 0-100,
  "submission_ready": false,
  "blocking_errors": [
    { "code": "E001", "field": "Nom du champ affiché", "field_key": "clé_champ_db", "message": "Description claire du problème et comment le corriger" }
  ],
  "warnings": [
    { "code": "W001", "field": "Nom du champ", "field_key": "clé_champ_db", "message": "Avertissement — génération possible mais risque de rejet" }
  ],
  "recommendations": [
    { "code": "R001", "field": "Nom du champ", "message": "Bonne pratique ou amélioration suggérée" }
  ],
  "authority_check": {
    "authority": "${authority.name}",
    "valid": false,
    "deadline_status": "ok|warning|overdue",
    "deadline_message": "string",
    "submission_format": "${authority.submission_format}"
  },
  "summary": "Résumé en 1-2 phrases de l'état du cas"
}`;
}

// ─── Helper: enregistrer une soumission ─────────────────────────────────────

async function dbInsertSubmission(data) {
  const db = await getDb();
  db.run(
    'INSERT INTO submissions (id,case_id,org_id,mode,authority,user_id,file_hash,status,ack_status,version,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      crypto.randomUUID(), data.caseId, data.orgId || 'default',
      data.mode || 'export_xml', data.authority || 'EMA',
      data.userId || null, data.fileHash || null,
      data.status || 'completed', data.ackStatus || null,
      data.version || 1, data.notes || null,
      new Date().toISOString(),
    ]
  );
  _saveDb();
}

// ─── POST /api/cases/:id/precheck ────────────────────────────────────────────

app.post('/api/cases/:id/precheck', async (req, res) => {
  try {
    const { id } = req.params;
    const authority = (req.body?.authority || 'EMA').toUpperCase();

    const caseRow = await dbGetCase(id);
    if (!caseRow) return res.status(404).json({ error: 'Cas introuvable' });
    const fields  = await dbGetFields(id);
    if (!fields)  return res.status(404).json({ error: 'Champs non extraits' });

    const client = getAnthropicClient();
    const prompt = buildPrecheckPrompt(caseRow, fields, authority);

    // Assistant prefill "{" force Claude à démarrer directement le JSON
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: 'You are an ICSR regulatory validation expert. Output ONLY raw JSON. No markdown, no explanation, no code fences. Start directly with {',
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' },
      ],
    });

    // Reconstruire le JSON complet (prefill + réponse)
    const raw = '{' + (resp.content[0]?.text || '');
    console.log('[PRECHECK] raw length:', raw.length, 'starts:', raw.substring(0, 60));

    let report;
    try {
      // Tentative 1 : parse direct
      report = JSON.parse(raw);
    } catch {
      try {
        // Tentative 2 : extraction {} robuste
        report = _parseJson(raw);
      } catch (e2) {
        console.error('[PRECHECK] parse failed, raw:', raw.substring(0, 500));
        return res.status(500).json({ error: 'Parsing JSON precheck', details: e2.message, raw: raw.substring(0, 300) });
      }
    }

    await dbInsertAudit(id, 'precheck:' + authority, req.ip);

    return res.json({
      case_id: id,
      authority,
      completeness_score: report.completeness_score ?? 0,
      submission_ready: report.submission_ready ?? false,
      blocking_errors: report.blocking_errors || [],
      warnings: report.warnings || [],
      recommendations: report.recommendations || [],
      authority_check: report.authority_check || null,
      summary: report.summary || '',
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[PRECHECK]', err.message);
    return res.status(500).json({ error: 'Erreur precheck', details: err.message });
  }
});

// ─── POST /api/cases/:id/submissions  (enregistrer export manuel) ─────────────

app.post('/api/cases/:id/submissions', async (req, res) => {
  try {
    const { id } = req.params;
    const { mode = 'export_xml', authority = 'EMA', org_id, user_id, notes } = req.body || {};

    const caseRow = await dbGetCase(id);
    if (!caseRow) return res.status(404).json({ error: 'Cas introuvable' });

    // Récupérer version courante (nombre de soumissions existantes + 1)
    const db = await getDb();
    const countStmt = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE case_id=?');
    const { c } = countStmt.getAsObject([id]);
    countStmt.free();
    const version = (c || 0) + 1;

    await dbInsertSubmission({
      caseId: id, orgId: org_id || caseRow.org_id || 'default',
      mode, authority, userId: user_id, version, notes,
      status: 'completed',
    });

    await dbInsertAudit(id, `submission:${mode}:${authority}:v${version}`, req.ip, user_id);

    return res.json({
      success: true,
      case_id: id,
      mode,
      authority,
      version,
      recorded_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[SUBMISSIONS_POST]', err.message);
    return res.status(500).json({ error: 'Erreur enregistrement', details: err.message });
  }
});

// ─── GET /api/cases/:id/submissions  (historique d'un cas) ────────────────────

app.get('/api/cases/:id/submissions', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM submissions WHERE case_id=? ORDER BY created_at DESC');
    stmt.bind([id]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return res.json({ case_id: id, submissions: rows });
  } catch (err) {
    console.error('[SUBMISSIONS_GET]', err.message);
    return res.status(500).json({ error: 'Erreur', details: err.message });
  }
});

// ─── GET /api/submissions  (tableau de bord org) ─────────────────────────────

app.get('/api/submissions', async (req, res) => {
  try {
    const orgId  = req.query.org_id || 'default';
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const authority = req.query.authority || null;
    const mode   = req.query.mode || null;

    const db = await getDb();

    // Joindre avec icsr_cases et extracted_fields pour enrichir
    let sql = `
      SELECT
        s.*,
        c.seriousness, c.source_type, c.status as case_status,
        c.deadline_7, c.deadline_15, c.deadline_90,
        c.received_at,
        ef.drug_name, ef.adr_description, ef.meddra_pt_name
      FROM submissions s
      LEFT JOIN icsr_cases c ON s.case_id = c.id
      LEFT JOIN extracted_fields ef ON s.case_id = ef.case_id
      WHERE s.org_id=?
    `;
    const params = [orgId];

    if (authority) { sql += ' AND s.authority=?'; params.push(authority); }
    if (mode)      { sql += ' AND s.mode=?'; params.push(mode); }

    sql += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    // Compteur total
    const countStmt = db.prepare('SELECT COUNT(*) as total FROM submissions WHERE org_id=?');
    const { total } = countStmt.getAsObject([orgId]);
    countStmt.free();

    return res.json({ submissions: rows, total: total || 0, limit, offset });
  } catch (err) {
    console.error('[SUBMISSIONS_DASHBOARD]', err.message);
    return res.status(500).json({ error: 'Erreur', details: err.message });
  }
});

// ─── Intercept export pour archiver automatiquement ──────────────────────────
// Wrapper autour des routes export existantes pour logger chaque téléchargement
// NB: On ne modifie pas les routes d'export existantes pour éviter la régression.
// L'archivage se fait via l'appel POST /api/cases/:id/submissions depuis le frontend.

// ─── 404 + Error handler ──────────────────────────────────────────────────────

app.use((req, res) =>
  res.status(404).json({ error: `Route introuvable: ${req.method} ${req.path}` })
);

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'Fichier trop volumineux' });
  res.status(500).json({ error: 'Erreur interne', details: process.env.NODE_ENV==='development' ? err.message : undefined });
});

// ═══════════════════════════════════════════════════════════════════
//  10. DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n PharmaVeil API  ·  port ${PORT}  ·  ${process.env.NODE_ENV||'development'}`);
  console.log(` Health   : http://localhost:${PORT}/health`);
  console.log(` Intake   : POST http://localhost:${PORT}/api/cases/intake`);
  console.log(` Cases    : GET  http://localhost:${PORT}/api/cases\n`);
});

module.exports = app;
