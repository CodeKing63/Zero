import { generateText } from 'ai';
import { openai } from './llm';
import { env } from '../env';
import type { Message } from 'ai';

function plainText(m: Message): string {
  const parts = m.parts ?? [];
  const fromParts = parts
    .map((p) => ('text' in p ? p.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return fromParts || m.content || '';
}

export async function generateChatTitle(messages: Message[]): Promise<string | null> {
  const firstUser = messages.find((m) => m.role === 'user');
  const firstAssistant = messages.find((m) => m.role === 'assistant');
  if (!firstUser || !firstAssistant) return null;

  const userText = plainText(firstUser).slice(0, 500);
  const assistantText = plainText(firstAssistant).slice(0, 500);
  if (!userText) return null;

  try {
    const { text } = await generateText({
      model: openai(env.OPENAI_MINI_MODEL || 'gpt-4o-mini'),
      messages: [
        {
          role: 'system',
          content:
            'Generate a 3 to 6 word title for this conversation. Be specific and descriptive. No quotes, no punctuation.',
        },
        {
          role: 'user',
          content: `User: ${userText}\nAssistant: ${assistantText}`,
        },
      ],
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, '').slice(0, 120);
    return cleaned || null;
  } catch (err) {
    console.warn('[generateChatTitle] failed', err);
    return null;
  }
}
