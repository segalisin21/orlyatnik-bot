/**
 * Voice: download file from Telegram, transcribe via Whisper.
 */

import OpenAI from 'openai';
import { env } from './config.js';
import { logger } from './logger.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export type GetFileFn = (fileId: string) => Promise<{ href: string }>;

/**
 * Download voice file from Telegram (via bot.getFile + download link), then transcribe with Whisper.
 * Returns transcribed text or empty string on failure.
 */
export async function transcribeVoice(
  fileId: string,
  getFile: GetFileFn
): Promise<string> {
  try {
    const file = await getFile(fileId);
    const url = file.href;
    if (!url) {
      logger.warn('Voice: no href from getFile', { fileId });
      return '';
    }
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn('Voice: fetch failed', { fileId, status: response.status });
      return '';
    }
    const buffer = await response.arrayBuffer();
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, 'voice.ogg');
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error('Whisper API error', { status: res.status, body: errText });
      return '';
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  } catch (e) {
    logger.error('Transcribe error', { fileId, error: String(e) });
    return '';
  }
}
