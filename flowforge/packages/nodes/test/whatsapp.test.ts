import { describe, expect, it } from 'vitest';
import { matchesSubscription, type IDataObject, type IWhatsAppHelper } from '@flowforge/workflow';
import { WhatsAppTrigger, normalisePhone } from '../src';
import { errorOf, runGraph, runNode } from './harness';

/** Records what the WhatsApp node asks the server to send. */
function fakeWhatsApp() {
  const sent: Array<{ accountId: string; to: string; message: IDataObject }> = [];
  const calls: string[] = [];
  const helper: IWhatsAppHelper = {
    async send(accountId, to, message) {
      sent.push({ accountId, to, message });
      return {
        messageId: `wamid.${sent.length}`,
        to,
        accountId,
        from: '+1 555 0100',
        simulated: true,
      };
    },
    async markRead(_accountId, messageId, options) {
      calls.push(`read:${messageId}:${options?.typing ? 'typing' : ''}`);
    },
    async uploadMedia(_accountId, media) {
      calls.push(`upload:${media.mimeType}:${media.fileName}:${media.data.toString()}`);
      return { id: 'media-1' };
    },
    async downloadMedia(_accountId, mediaId) {
      calls.push(`download:${mediaId}`);
      return { data: Buffer.from('voice-note'), mimeType: 'audio/ogg', fileName: 'note.ogg' };
    },
    async listTemplates() {
      return [];
    },
  };
  return { helper, sent, calls };
}

const run = (
  parameters: IDataObject,
  input: IDataObject[] = [{ from: '919876543210', contactName: 'Asha', messageId: 'wamid.IN' }],
) => {
  const fake = fakeWhatsApp();
  return runNode(
    'flowforge.whatsApp',
    { account: 'acc-1', ...parameters },
    input,
    {},
    { whatsapp: fake.helper },
  ).then((result) => ({ ...result, ...fake }));
};

describe('WhatsApp node', () => {
  it('sends text replies to the sender with expressions and quoting', async () => {
    const { sent, output } = await run({
      operation: 'sendText',
      to: '={{ $json.from }}',
      text: '=Hi {{ $json.contactName }}!',
      options: { replyTo: '={{ $json.messageId }}', previewUrl: true },
    });
    expect(sent).toEqual([
      {
        accountId: 'acc-1',
        to: '919876543210',
        message: {
          type: 'text',
          text: { body: 'Hi Asha!', preview_url: true },
          context: { message_id: 'wamid.IN' },
        },
      },
    ]);
    expect(output()).toEqual([
      expect.objectContaining({
        messageId: 'wamid.1',
        to: '919876543210',
        status: 'sent',
        simulated: true,
      }),
    ]);
  });

  it('normalises phone numbers and rejects nonsense', async () => {
    expect(normalisePhone('+91 98765-43210')).toBe('919876543210');
    const { run: result, sent } = await run({ operation: 'sendText', to: 'call me', text: 'x' });
    expect(sent).toHaveLength(0);
    expect(errorOf(result)?.message).toContain('is not a phone number');
  });

  it('builds templates with header and body variables', async () => {
    const { sent } = await run({
      operation: 'sendTemplate',
      templateName: 'appointment_reminder',
      templateLanguage: 'hi',
      headerType: 'image',
      headerMediaUrl: 'https://example.com/clinic.jpg',
      bodyParameters: {
        parameter: [{ text: '={{ $json.contactName }}' }, { text: 'Monday 10:00' }],
      },
    });
    expect(sent[0]!.message).toEqual({
      type: 'template',
      template: {
        name: 'appointment_reminder',
        language: { code: 'hi' },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'image', image: { link: 'https://example.com/clinic.jpg' } }],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: 'Monday 10:00' },
            ],
          },
        ],
      },
    });
  });

  it('builds reply buttons and validates WhatsApp limits', async () => {
    const { sent } = await run({
      operation: 'sendButtons',
      bodyText: 'Confirm your table for 4?',
      buttons: { button: [{ title: 'Confirm', id: 'confirm' }, { title: 'Change time' }] },
      options: { headerText: 'Reservation', footerText: 'Reply anytime' },
    });
    expect(sent[0]!.message).toEqual({
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Reservation' },
        body: { text: 'Confirm your table for 4?' },
        footer: { text: 'Reply anytime' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'confirm', title: 'Confirm' } },
            { type: 'reply', reply: { id: 'button_2', title: 'Change time' } },
          ],
        },
      },
    });

    const tooMany = await run({
      operation: 'sendButtons',
      bodyText: 'Pick',
      buttons: { button: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }] },
    });
    expect(errorOf(tooMany.run)?.message).toContain('1 to 3 buttons');
    const longTitle = await run({
      operation: 'sendButtons',
      bodyText: 'Pick',
      buttons: { button: [{ title: 'This title is far too long' }] },
    });
    expect(errorOf(longTitle.run)?.message).toContain('WhatsApp allows 20');
  });

  it('groups list choices into sections', async () => {
    const { sent } = await run({
      operation: 'sendList',
      bodyText: 'What would you like?',
      listButton: 'Menu',
      rows: {
        row: [
          { title: 'Croissant', id: 'croissant', section: 'Bakery', description: '₹80' },
          { title: 'Sourdough', id: 'sourdough', section: 'Bakery' },
          { title: 'Cappuccino', id: 'cappuccino', section: 'Drinks' },
        ],
      },
    });
    expect((sent[0]!.message.interactive as IDataObject).action).toEqual({
      button: 'Menu',
      sections: [
        {
          title: 'Bakery',
          rows: [
            { id: 'croissant', title: 'Croissant', description: '₹80' },
            { id: 'sourdough', title: 'Sourdough' },
          ],
        },
        { title: 'Drinks', rows: [{ id: 'cappuccino', title: 'Cappuccino' }] },
      ],
    });
  });

  it('sends media by URL or uploads binary data from a previous node', async () => {
    const byUrl = await run({
      operation: 'sendMedia',
      mediaType: 'document',
      mediaSource: 'url',
      mediaUrl: 'https://example.com/menu.pdf',
      caption: 'Our menu',
      fileName: 'menu.pdf',
    });
    expect(byUrl.sent[0]!.message).toEqual({
      type: 'document',
      document: { link: 'https://example.com/menu.pdf', caption: 'Our menu', filename: 'menu.pdf' },
    });

    const fake = fakeWhatsApp();
    await runGraph(
      [
        { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
        {
          name: 'File',
          type: 'flowforge.code',
          parameters: {
            jsCode:
              "return [{ json: { to: '919876543210' }, binary: { data: { data: 'aGVsbG8=', mimeType: 'image/png', fileName: 'photo.png' } } }];",
          },
        },
        {
          name: 'Send',
          type: 'flowforge.whatsApp',
          parameters: {
            account: 'acc-1',
            operation: 'sendMedia',
            mediaType: 'image',
            mediaSource: 'binary',
            to: '={{ $json.to }}',
          },
        },
      ],
      [
        ['Start', 'File'],
        ['File', 'Send'],
      ],
      {},
      { whatsapp: fake.helper },
    );
    expect(fake.calls).toEqual(['upload:image/png:photo.png:hello']);
    expect(fake.sent[0]!.message).toEqual({ type: 'image', image: { id: 'media-1' } });

    const missing = await run({
      operation: 'sendMedia',
      mediaType: 'image',
      mediaSource: 'binary',
      binaryProperty: 'photo',
    });
    expect(errorOf(missing.run)?.message).toContain('No binary data in "photo"');
  });

  it('marks as read with typing, reacts, and downloads media as a file', async () => {
    const read = await run({
      operation: 'markRead',
      messageId: '={{ $json.messageId }}',
      typing: true,
    });
    expect(read.calls).toEqual(['read:wamid.IN:typing']);

    const react = await run({
      operation: 'react',
      to: '={{ $json.from }}',
      messageId: 'wamid.IN',
      emoji: '❤️',
    });
    expect(react.sent[0]!.message).toEqual({
      type: 'reaction',
      reaction: { message_id: 'wamid.IN', emoji: '❤️' },
    });

    const download = await run(
      { operation: 'downloadMedia', mediaId: '={{ $json.media.id }}', binaryPropertyName: 'audio' },
      [{ media: { id: 'media-9' } }],
    );
    expect(download.calls).toEqual(['download:media-9']);
    const item = download.run.data.resultData.runData.Node![0]!.data!.main[0]![0]!;
    expect(item.json).toMatchObject({ mediaId: 'media-9', mimeType: 'audio/ogg', fileSize: 10 });
    expect(Buffer.from(item.binary!.audio!.data, 'base64').toString()).toBe('voice-note');
  });

  it('explains how to fix a missing number and a host without WhatsApp', async () => {
    const noAccount = await run({ account: '', operation: 'sendText', text: 'x' });
    expect(errorOf(noAccount.run)?.message).toBe('Choose a WhatsApp number');

    const plain = await runNode('flowforge.whatsApp', {
      account: 'acc-1',
      operation: 'sendText',
      to: '919876543210',
      text: 'x',
    });
    expect(errorOf(plain.run)?.message).toBe('WhatsApp is not available here');
  });

  it('continues on fail when asked', async () => {
    const result = await run({ operation: 'sendText', to: 'nope', text: 'x' });
    expect(errorOf(result.run)).toBeTruthy();
    const fake = fakeWhatsApp();
    const continued = await runNode(
      'flowforge.whatsApp',
      { account: 'acc-1', operation: 'sendText', to: 'nope', text: 'x' },
      [{}],
      { onError: 'continueRegularOutput' },
      { whatsapp: fake.helper },
    );
    expect(continued.output()).toEqual([
      { error: expect.stringContaining('is not a phone number') },
    ]);
  });
});

describe('WhatsApp Trigger', () => {
  it('subscribes to the chosen number, events and message types', () => {
    const subscription = WhatsAppTrigger.eventSubscription!({
      account: 'acc-1',
      events: ['message', 'status'],
      messageTypes: ['text'],
    });
    expect(subscription).toEqual({
      source: 'whatsapp',
      scope: 'acc-1',
      events: ['message', 'status'],
      filter: { messageType: ['text'] },
    });
    const message = (type: string, scope = 'acc-1') => ({
      source: 'whatsapp',
      scope,
      name: 'message',
      attributes: { messageType: type },
    });
    expect(matchesSubscription(subscription, message('text'))).toBe(true);
    expect(matchesSubscription(subscription, message('image'))).toBe(false);
    expect(matchesSubscription(subscription, message('text', 'acc-2'))).toBe(false);
    // The message-type filter doesn't block delivery receipts.
    expect(
      matchesSubscription(subscription, { source: 'whatsapp', scope: 'acc-1', name: 'status' }),
    ).toBe(true);
    const any = WhatsAppTrigger.eventSubscription!({ account: '*' });
    expect(matchesSubscription(any, message('image', 'acc-9'))).toBe(true);
    expect(matchesSubscription(any, { source: 'whatsapp', scope: 'acc-9', name: 'status' })).toBe(
      false,
    );
  });

  it('outputs a sample message on manual runs and real events otherwise', async () => {
    const manual = await runNode('flowforge.whatsAppTrigger', { account: '*' }, [{}]);
    expect(manual.output()).toEqual([
      expect.objectContaining({ event: 'message', sample: true, from: '919876543210' }),
    ]);
    const real = await runNode('flowforge.whatsAppTrigger', { account: '*' }, [
      { event: 'message', from: '447700900123', text: 'hi' },
    ]);
    expect(real.output()).toEqual([{ event: 'message', from: '447700900123', text: 'hi' }]);
  });
});
