# PharmaVeil — Backend API

Agent IA de pharmacovigilance pour PME pharma.  
Stack : Node.js · Express · sql.js · Claude API (Anthropic)

## Démarrage rapide

```bash
npm install
cp .env.example .env
# Renseigner ANTHROPIC_API_KEY dans .env
npm start
```

## Variables d'environnement

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✓ | — | Clé API Anthropic |
| `PORT` | — | 3001 | Port HTTP |
| `NODE_ENV` | — | development | Environnement |
| `DB_PATH` | — | ./pharmaveil.db | Chemin SQLite |
| `CONFIDENCE_THRESHOLD_GREEN` | — | 0.85 | Seuil confiance haute |
| `CONFIDENCE_THRESHOLD_ORANGE` | — | 0.60 | Seuil confiance moyenne |

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/api/cases/intake` | Intake email/form/manual |
| POST | `/api/cases/intake/pdf` | Upload PDF CIOMS scanné |
| GET | `/api/cases` | Liste des cas |
| GET | `/api/cases/:id` | Détail d'un cas |
| PATCH | `/api/cases/:id/validate` | Validation humaine |
| GET | `/api/cases/:id/meddra` | Lookup MedDRA |
| GET | `/api/cases/:id/export/pdf` | Export CIOMS I PDF |
| GET | `/api/cases/:id/export/e2b` | Export E2B(R3) XML |

## Exemple d'appel

```bash
curl -X POST http://localhost:3001/api/cases/intake \
  -H "Content-Type: application/json" \
  -d '{
    "source_type": "email",
    "raw_email": "De: Dr. Laurent\nPatient homme 67 ans, nausées sous Metformine 1g depuis 3 jours."
  }'
```

## Deploy Railway

```bash
railway login
railway init
railway up
railway variables set ANTHROPIC_API_KEY=sk-ant-...
```
