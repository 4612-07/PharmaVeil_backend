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
      pt_name_lower TEXT, llt_name_lower TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pt_lower  ON meddra_terms(pt_name_lower);
    CREATE INDEX IF NOT EXISTS idx_llt_lower ON meddra_terms(llt_name_lower);
  `);
  _seedMeddra(db);
}

// ═══════════════════════════════════════════════════════════════════
//  2. SEED MedDRA (subset démo 27.0)
// ═══════════════════════════════════════════════════════════════════

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

async function extractIcsrData(sourceText, sourceType) {
  if (!sourceText || sourceText.trim().length < 20)
    throw new Error('Texte source trop court (< 20 caractères)');

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(sourceText, sourceType) }],
  });

  const raw = response.content[0]?.type === 'text' ? response.content[0].text : null;
  if (!raw) throw new Error('Réponse Claude vide');

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
  return {
    results: results.slice(0, topK),
    top: top ? { pt_code: top.pt_code, pt_name: top.pt_name, llt_code: top.llt_code, llt_name: top.llt_name, soc_name: top.soc_name } : null,
    confidence: top ? (top.score >= CONF_GREEN ? 'green' : top.score >= CONF_ORANGE ? 'orange' : 'red') : 'none',
    score: top?.score || 0,
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

      // Helper
      const section = (title) => {
        doc.rect(40, y, 515, 18).fill('#0c1120');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(title.toUpperCase(), 48, y + 4);
        y += 24;
      };
      const field = (label, value, x, w, h = 28, alt = false) => {
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
        section('G. Narrative clinique (IA — à valider)');
        const nh = Math.max(55, Math.ceil(narrativeText.length / 72) * 12 + 20);
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
  db.run(`INSERT INTO icsr_cases (id,org_id,status,source_type,raw_content,received_at,deadline_7,deadline_15,deadline_90,seriousness,processed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [data.id, data.orgId||'default', data.status, data.sourceType, (data.rawContent||'').substring(0,50000),
     data.receivedAt||new Date().toISOString(), data.deadline7||null, data.deadline15||null, data.deadline90||null, data.seriousness||null, new Date().toISOString()]);
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
  ? ['https://pharmaveil.eu', 'https://pharmaveil.fr', 'https://app.pharmaveil.eu', 'https://delightful-haupia-395e44.netlify.app']
  : '*',
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '10') * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('PDF uniquement'), false),
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) =>
  res.json({ status:'ok', service:'PharmaVeil API', version:'1.0.0', timestamp: new Date().toISOString() })
);

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
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier PDF requis (champ: file)' });
    let pdfText;
    try { const d = await pdfParse(req.file.buffer); pdfText = d.text; }
    catch { return res.status(422).json({ error: 'PDF illisible ou protégé' }); }
    if (!pdfText?.trim() || pdfText.trim().length < 30)
      return res.status(422).json({ error: 'PDF vide ou non-textuel' });
    req.body = { source_type: 'manual', manual_text: pdfText, org_id: req.body?.org_id };
    return app._router.handle(req, res, () => {});
  } catch (err) { return res.status(500).json({ error: 'Erreur PDF', details: err.message }); }
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
    const buf = await generateCiomsIPdf({ ...c, fields: f });
    const name = `PharmaVeil_CIOMS-I_PV-${req.params.id.substring(0,8).toUpperCase()}_${new Date().toISOString().slice(0,10)}.pdf`;
    res.set({ 'Content-Type':'application/pdf', 'Content-Disposition':`attachment; filename="${name}"`, 'Content-Length': buf.length });
    return res.send(buf);
  } catch (err) {
    console.error('[PDF]', err.message);
    return res.status(500).json({ error: 'Erreur génération PDF', details: err.message });
  }
});

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

    const name = `PharmaVeil_E2B-R3_PV-${ref}_${new Date().toISOString().slice(0,10)}.xml`;
    res.set({ 'Content-Type':'application/xml; charset=utf-8', 'Content-Disposition':`attachment; filename="${name}"` });
    return res.send(xml);
  } catch (err) {
    return res.status(500).json({ error: 'Erreur export E2B', details: err.message });
  }
});

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
