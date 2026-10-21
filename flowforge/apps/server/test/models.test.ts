import { describe, expect, it } from 'vitest';
import { pickModel } from '../src/ai/models';

describe('AI agent model choice', () => {
  it('prefers the newest stable Gemini Flash over retired defaults', () => {
    const available = [
      'gemini-2.5-flash',
      'gemini-3.8-flash',
      'gemini-3.8-flash-lite',
      'gemini-2.5-pro',
    ];
    expect(pickModel('llm', 'gemini', available, '', 'gemini-flash-latest')).toBe(
      'gemini-3.8-flash',
    );
    // A model the key lists and the agent asks for is kept.
    expect(pickModel('llm', 'gemini', available, 'gemini-2.5-pro', 'gemini-flash-latest')).toBe(
      'gemini-2.5-pro',
    );
    // Without a model list the request goes through as asked.
    expect(pickModel('llm', 'gemini', null, '', 'gemini-flash-latest')).toBe('gemini-flash-latest');
  });

  it('keeps the other providers as they were', () => {
    expect(
      pickModel(
        'llm',
        'groq',
        ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
        '',
        'llama-3.3-70b-versatile',
      ),
    ).toBe('openai/gpt-oss-120b');
  });
});
