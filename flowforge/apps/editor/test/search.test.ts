import { describe, expect, it } from 'vitest';
import type { INodeTypeDescription } from '@flowforge/workflow';
import { score } from '../src/components/canvas/NodeCreator';

const node = (displayName: string, description: string, keywords: string[] = []) =>
  ({ displayName, description, keywords }) as unknown as INodeTypeDescription;

const whatsapp = node('WhatsApp', 'Send messages, templates and media with WhatsApp Business', [
  'message',
  'chat',
]);
const http = node('HTTP Request', 'Call any REST API', ['api', 'fetch']);
const code = node('Code', 'Run JavaScript', ['js']);

describe('node search', () => {
  it('matches every word of the search anywhere in the node', () => {
    expect(score(whatsapp, 'send whatsapp')).toBeGreaterThan(0);
    expect(score(http, 'http req')).toBeGreaterThan(0);
    expect(score(http, 'fetch api')).toBeGreaterThan(0);
    expect(score(code, 'send whatsapp')).toBe(0);
    expect(score(code, '   ')).toBe(0);
  });

  it('ranks name matches above keyword and description matches', () => {
    expect(score(code, 'code')).toBeGreaterThan(score(code, 'js'));
    expect(score(code, 'js')).toBeGreaterThan(score(code, 'javascript'));
    expect(score(http, 'HTTP')).toBeGreaterThan(score(whatsapp, 'business'));
  });
});
