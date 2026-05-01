import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { logger } from '../utils/logger.js';

export interface ClassifyRequest {
  system: string;
  user: string;
  schema: Schema;
  model?: string;
}

export interface VisionPart {
  data: Buffer | string;  // raw bytes or base64 string
  mimeType: string;       // e.g. 'image/jpeg', 'image/png'
}

export interface ClassifyVisionRequest extends ClassifyRequest {
  images: VisionPart[];
}

export interface ClassifyResult<T> {
  data: T;
  usage: {
    promptTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
  };
  raw: string;
}

const DEFAULT_FAST = process.env.LLM_MODEL_FAST || 'gemini-2.5-flash';

export class GeminiClient {
  private ai: GoogleGenAI;
  private dryRun: boolean;

  constructor(opts?: { apiKey?: string }) {
    this.dryRun = (process.env.LLM_DRY_RUN || 'false').toLowerCase() === 'true';
    const apiKey = opts?.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    if (!apiKey && !this.dryRun) {
      throw new Error('GEMINI_API_KEY is missing. Set it in .env or LLM_DRY_RUN=true.');
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  async classify<T>(req: ClassifyRequest): Promise<ClassifyResult<T>> {
    if (this.dryRun) return this.dryRunResult<T>(req.schema);

    const model = req.model || DEFAULT_FAST;
    const response = await this.ai.models.generateContent({
      model,
      contents: req.user,
      config: {
        systemInstruction: req.system,
        responseMimeType: 'application/json',
        responseSchema: req.schema
      }
    });

    return this.toResult<T>(response, model);
  }

  async classifyWithVision<T>(req: ClassifyVisionRequest): Promise<ClassifyResult<T>> {
    if (this.dryRun) return this.dryRunResult<T>(req.schema);

    const model = req.model || DEFAULT_FAST;
    const parts: Array<Record<string, unknown>> = [{ text: req.user }];
    for (const img of req.images) {
      const data = Buffer.isBuffer(img.data) ? img.data.toString('base64') : img.data;
      parts.push({ inlineData: { data, mimeType: img.mimeType } });
    }

    const response = await this.ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: req.system,
        responseMimeType: 'application/json',
        responseSchema: req.schema
      }
    });

    return this.toResult<T>(response, model);
  }

  private toResult<T>(response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>, model: string): ClassifyResult<T> {
    const text = response.text || '';
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (err) {
      logger.error({ err, text, model }, 'GeminiClient: response was not valid JSON');
      throw new Error(`GeminiClient: invalid JSON from model: ${text.slice(0, 200)}`);
    }

    return {
      data,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        cachedTokens: response.usageMetadata?.cachedContentTokenCount ?? 0,
        totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
      },
      raw: text
    };
  }

  private dryRunResult<T>(schema: Schema): ClassifyResult<T> {
    return {
      data: cannedFromSchema(schema) as T,
      usage: { promptTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 },
      raw: '<dry-run>'
    };
  }
}

function cannedFromSchema(schema: Schema | undefined): unknown {
  if (!schema) return null;
  switch (schema.type) {
    case Type.OBJECT: {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const [k, v] of Object.entries(props)) {
        out[k] = cannedFromSchema(v);
      }
      return out;
    }
    case Type.ARRAY:
      return [];
    case Type.STRING:
      return 'dryrun';
    case Type.NUMBER:
    case Type.INTEGER:
      return 0;
    case Type.BOOLEAN:
      return false;
    default:
      return null;
  }
}

export { Type };
export type { Schema };
