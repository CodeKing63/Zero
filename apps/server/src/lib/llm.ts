import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../env';

const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: env.OPENROUTER_API_KEY,
});

const withPrefix = (prefix: string) => (modelId: string) =>
  openrouter(modelId.includes('/') ? modelId : `${prefix}/${modelId}`);

export const openai = openrouter;
export const google = withPrefix('google');
export const groq = withPrefix('groq');
export const anthropic = withPrefix('anthropic');
export const perplexity = withPrefix('perplexity');
