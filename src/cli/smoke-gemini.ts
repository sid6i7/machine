import 'dotenv/config';
import { GeminiClient, Type } from '../llm/GeminiClient.js';
import { logger } from '../utils/logger.js';

// Lightweight wiring test for GeminiClient: hits the live API once with a
// minimal classification request and prints token usage. Re-run a second time
// to see implicit caching kick in.

interface SentimentResult { sentiment: string; confidence: number; }

async function main() {
  const client = new GeminiClient();
  const result = await client.classify<SentimentResult>({
    system: 'You are a sentiment classifier. Output JSON: { sentiment: positive|negative|neutral, confidence: 0..1 }.',
    user: 'I love this product! It saved me hours of work.',
    schema: {
      type: Type.OBJECT,
      properties: {
        sentiment: { type: Type.STRING, enum: ['positive', 'negative', 'neutral'] },
        confidence: { type: Type.NUMBER }
      },
      required: ['sentiment', 'confidence']
    }
  });
  logger.info({ data: result.data, usage: result.usage }, 'Gemini smoke result');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Gemini smoke failed');
  process.exit(1);
});
