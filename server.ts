import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const VALID_CATEGORIES = [
  'Groceries',
  'Housing & Utilities',
  'Transport & Mobility',
  'Dining & Cafes',
  'Health & Pharmacy',
  'Shopping & Retail',
  'Subscriptions & Media',
  'Insurance & Finance',
  'Salary & Income',
  'Internal Transfer',
  'Travel & Leisure',
  'Other',
];

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '512kb' }));

  // Server-side proxy for optional, explicitly consented batch merchant classification.
  // Privacy Guard: Accepts ONLY deduplicated, sanitized merchant strings.
  app.post('/api/classify-merchants', async (req, res) => {
    try {
      const { sanitizedMerchants, consentConfirmed } = req.body as {
        sanitizedMerchants?: string[];
        consentConfirmed?: boolean;
      };

      if (!consentConfirmed) {
        return res.status(400).json({
          error: 'Explicit user consent is required before sending sanitized merchant labels for classification.',
        });
      }

      if (!Array.isArray(sanitizedMerchants) || sanitizedMerchants.length === 0) {
        return res.status(400).json({
          error: 'No sanitized merchant strings provided.',
        });
      }

      // Defense-in-depth server boundary check: reject if raw IBAN or unsanitized date/amount patterns leak
      const ibanRegex = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i;
      const dateRegex = /\b\d{2}\.\d{2}\.\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/;
      for (const label of sanitizedMerchants) {
        if (ibanRegex.test(label) || dateRegex.test(label)) {
          return res.status(422).json({
            error: `Privacy boundary violation blocked: Merchant string "${label}" contains unsanitized IBAN or date pattern.`,
          });
        }
      }

      // Deduplicate on server as well
      const uniqueMerchants = Array.from(new Set(sanitizedMerchants.map((m) => m.trim()).filter(Boolean))).slice(0, 100);

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({
          error: 'GEMINI_API_KEY is not configured on the server. Using local offline rules engine instead.',
        });
      }

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const prompt = `You are a financial merchant classification engine for European and international banking transactions.
Classify each sanitized merchant label below into four dimensions:
1. category: One of ${JSON.stringify(VALID_CATEGORIES)}
2. costStructure: "Fixed" or "Variable"
3. necessity: "Essential" or "Discretionary"
4. cadence: "Recurring" or "One-Off"

Sanitized Merchant Labels:
${JSON.stringify(uniqueMerchants, null, 2)}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                sanitizedPattern: {
                  type: Type.STRING,
                  description: 'The exact sanitized merchant label from the input list.',
                },
                category: {
                  type: Type.STRING,
                  description: 'Primary spending or income category.',
                },
                costStructure: {
                  type: Type.STRING,
                  description: 'Either Fixed or Variable.',
                },
                necessity: {
                  type: Type.STRING,
                  description: 'Either Essential or Discretionary.',
                },
                cadence: {
                  type: Type.STRING,
                  description: 'Either Recurring or One-Off.',
                },
                confidence: {
                  type: Type.NUMBER,
                  description: 'Confidence score between 0.0 and 1.0.',
                },
              },
              required: ['sanitizedPattern', 'category', 'costStructure', 'necessity', 'cadence'],
            },
          },
        },
      });

      const rawText = response.text?.trim() || '[]';
      const parsed = JSON.parse(rawText);
      return res.json({ results: parsed });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to classify merchants via Gemini API';
      return res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`bankingBuddy server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
