import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeParameters,
  type INodeProperties,
  type INodeType,
} from '@flowforge/workflow';

const ICON = 'message-circle';
const COLOR = '#25D366';

const SEND_OPERATIONS = [
  'sendText',
  'sendTemplate',
  'sendMedia',
  'sendButtons',
  'sendList',
  'sendLocation',
  'react',
];

/** "+91 98765-43210" → "919876543210" (the Cloud API wants digits with the country code). */
export function normalisePhone(value: string): string {
  return value.replace(/[^\d]/g, '');
}

const accountProperty: INodeProperties = {
  displayName: 'WhatsApp Number',
  name: 'account',
  type: 'options',
  default: '',
  required: true,
  typeOptions: { loadOptionsMethod: 'whatsappAccounts' },
  description: 'Numbers are connected on the WhatsApp page - no API keys needed here',
};

const show = (operation: string[]) => ({ show: { operation } });

export const WhatsApp: INodeType = {
  description: {
    name: 'flowforge.whatsApp',
    displayName: 'WhatsApp',
    icon: ICON,
    iconColor: COLOR,
    group: ['whatsapp'],
    version: 1,
    description: 'Send WhatsApp messages, templates, media and buttons from a connected number',
    defaults: { name: 'WhatsApp' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['whatsapp', 'message', 'chat', 'sms', 'reply', 'template', 'meta'],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      accountProperty,
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'sendText',
        noDataExpression: true,
        options: [
          {
            name: 'Send Text',
            value: 'sendText',
            description: 'Reply within 24 hours of the customer’s last message',
          },
          {
            name: 'Send Template',
            value: 'sendTemplate',
            description:
              'Approved template - the only way to message someone first or after 24 hours',
          },
          { name: 'Send Image, Document, Audio or Video', value: 'sendMedia' },
          {
            name: 'Send Reply Buttons',
            value: 'sendButtons',
            description: 'Up to 3 tappable buttons',
          },
          { name: 'Send List', value: 'sendList', description: 'A menu of up to 10 choices' },
          { name: 'Send Location', value: 'sendLocation' },
          { name: 'React to a Message', value: 'react' },
          {
            name: 'Mark as Read',
            value: 'markRead',
            description: 'Blue ticks, optionally with "typing…"',
          },
          {
            name: 'Download Media',
            value: 'downloadMedia',
            description: 'Get a received photo, voice note or file',
          },
        ],
      },
      {
        displayName: 'To',
        name: 'to',
        type: 'string',
        default: '={{ $json.from }}',
        required: true,
        placeholder: 'e.g. +91 98765 43210',
        description:
          'Phone number with country code. With a WhatsApp Trigger, {{ $json.from }} replies to the sender.',
        displayOptions: show(SEND_OPERATIONS),
      },
      // Text
      {
        displayName: 'Message',
        name: 'text',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 4 },
        placeholder: 'Hi {{ $json.contactName }}, thanks for your message!',
        description: 'Up to 4096 characters. *bold*, _italic_ and ~strike~ work as in WhatsApp.',
        displayOptions: show(['sendText']),
      },
      // Template
      {
        displayName: 'Template',
        name: 'templateName',
        type: 'options',
        default: '',
        required: true,
        typeOptions: { loadOptionsMethod: 'whatsappTemplates', loadOptionsDependsOn: ['account'] },
        description: 'Templates are created and approved in Meta WhatsApp Manager',
        displayOptions: show(['sendTemplate']),
      },
      {
        displayName: 'Language Code',
        name: 'templateLanguage',
        type: 'string',
        default: 'en_US',
        placeholder: 'en_US, hi, en',
        displayOptions: show(['sendTemplate']),
      },
      {
        displayName: 'Body Variables',
        name: 'bodyParameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: {},
        description: 'Values for {{1}}, {{2}}, … in the template body, in order',
        displayOptions: show(['sendTemplate']),
        options: [
          {
            name: 'parameter',
            displayName: 'Variable',
            values: [{ displayName: 'Value', name: 'text', type: 'string', default: '' }],
          },
        ],
      },
      {
        displayName: 'Header',
        name: 'headerType',
        type: 'options',
        default: 'none',
        description: 'Only if the template has a header with a variable or media',
        displayOptions: show(['sendTemplate']),
        options: [
          { name: 'None', value: 'none' },
          { name: 'Text Variable', value: 'text' },
          { name: 'Image', value: 'image' },
          { name: 'Video', value: 'video' },
          { name: 'Document', value: 'document' },
        ],
      },
      {
        displayName: 'Header Text',
        name: 'headerText',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['sendTemplate'], headerType: ['text'] } },
      },
      {
        displayName: 'Header Media URL',
        name: 'headerMediaUrl',
        type: 'string',
        default: '',
        placeholder: 'https://example.com/offer.jpg',
        displayOptions: {
          show: { operation: ['sendTemplate'], headerType: ['image', 'video', 'document'] },
        },
      },
      // Media
      {
        displayName: 'Media Type',
        name: 'mediaType',
        type: 'options',
        default: 'image',
        displayOptions: show(['sendMedia']),
        options: [
          { name: 'Image', value: 'image' },
          { name: 'Document', value: 'document' },
          { name: 'Audio', value: 'audio' },
          { name: 'Video', value: 'video' },
          { name: 'Sticker', value: 'sticker' },
        ],
      },
      {
        displayName: 'Source',
        name: 'mediaSource',
        type: 'options',
        default: 'url',
        displayOptions: show(['sendMedia']),
        options: [
          { name: 'Public URL', value: 'url' },
          { name: 'Binary Data From a Previous Node', value: 'binary' },
        ],
      },
      {
        displayName: 'Media URL',
        name: 'mediaUrl',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://example.com/menu.pdf',
        displayOptions: { show: { operation: ['sendMedia'], mediaSource: ['url'] } },
      },
      {
        displayName: 'Binary Property',
        name: 'binaryProperty',
        type: 'string',
        default: 'data',
        displayOptions: { show: { operation: ['sendMedia'], mediaSource: ['binary'] } },
      },
      {
        displayName: 'Caption',
        name: 'caption',
        type: 'string',
        default: '',
        displayOptions: {
          show: { operation: ['sendMedia'], mediaType: ['image', 'video', 'document'] },
        },
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        default: '',
        placeholder: 'invoice.pdf',
        displayOptions: { show: { operation: ['sendMedia'], mediaType: ['document'] } },
      },
      // Interactive
      {
        displayName: 'Message',
        name: 'bodyText',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 3 },
        displayOptions: show(['sendButtons', 'sendList']),
      },
      {
        displayName: 'Buttons',
        name: 'buttons',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: {
          button: [
            { id: 'yes', title: 'Yes' },
            { id: 'no', title: 'No' },
          ],
        },
        description: 'Up to 3. The tapped button arrives in the WhatsApp Trigger as $json.reply.id',
        displayOptions: show(['sendButtons']),
        options: [
          {
            name: 'button',
            displayName: 'Button',
            values: [
              {
                displayName: 'Title',
                name: 'title',
                type: 'string',
                default: '',
                description: 'Up to 20 characters',
              },
              {
                displayName: 'ID',
                name: 'id',
                type: 'string',
                default: '',
                description: 'Returned when tapped',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Menu Button Label',
        name: 'listButton',
        type: 'string',
        default: 'Choose',
        description: 'Up to 20 characters',
        displayOptions: show(['sendList']),
      },
      {
        displayName: 'Choices',
        name: 'rows',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: { row: [{ id: '', title: '', description: '', section: '' }] },
        description: 'Up to 10. Rows with the same section name are grouped.',
        displayOptions: show(['sendList']),
        options: [
          {
            name: 'row',
            displayName: 'Choice',
            values: [
              {
                displayName: 'Title',
                name: 'title',
                type: 'string',
                default: '',
                description: 'Up to 24 characters',
              },
              { displayName: 'ID', name: 'id', type: 'string', default: '' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Section', name: 'section', type: 'string', default: '' },
            ],
          },
        ],
      },
      // Location
      {
        displayName: 'Latitude',
        name: 'latitude',
        type: 'number',
        default: 0,
        typeOptions: { numberPrecision: 6 },
        displayOptions: show(['sendLocation']),
      },
      {
        displayName: 'Longitude',
        name: 'longitude',
        type: 'number',
        default: 0,
        typeOptions: { numberPrecision: 6 },
        displayOptions: show(['sendLocation']),
      },
      {
        displayName: 'Place Name',
        name: 'locationName',
        type: 'string',
        default: '',
        displayOptions: show(['sendLocation']),
      },
      {
        displayName: 'Address',
        name: 'locationAddress',
        type: 'string',
        default: '',
        displayOptions: show(['sendLocation']),
      },
      // Reaction / read / download
      {
        displayName: 'Message ID',
        name: 'messageId',
        type: 'string',
        default: '={{ $json.messageId }}',
        required: true,
        displayOptions: show(['react', 'markRead']),
      },
      {
        displayName: 'Emoji',
        name: 'emoji',
        type: 'string',
        default: '👍',
        description: 'Leave empty to remove a reaction',
        displayOptions: show(['react']),
      },
      {
        displayName: 'Show "typing…"',
        name: 'typing',
        type: 'boolean',
        default: false,
        description: 'Shows the typing indicator for up to 25 seconds or until you reply',
        displayOptions: show(['markRead']),
      },
      {
        displayName: 'Media ID',
        name: 'mediaId',
        type: 'string',
        default: '={{ $json.media.id }}',
        required: true,
        displayOptions: show(['downloadMedia']),
      },
      {
        displayName: 'Put Output File in Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        displayOptions: show(['downloadMedia']),
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: show([
          'sendText',
          'sendTemplate',
          'sendMedia',
          'sendButtons',
          'sendList',
          'sendLocation',
        ]),
        options: [
          {
            displayName: 'Reply To (Quote) Message ID',
            name: 'replyTo',
            type: 'string',
            default: '={{ $json.messageId }}',
            description: 'Shows the customer’s message quoted above yours',
          },
          {
            displayName: 'Show Link Preview',
            name: 'previewUrl',
            type: 'boolean',
            default: false,
            description: 'Text messages: show a preview of the first link',
          },
          {
            displayName: 'Header Text',
            name: 'headerText',
            type: 'string',
            default: '',
            description: 'Buttons and lists: a bold line above the message',
          },
          {
            displayName: 'Footer Text',
            name: 'footerText',
            type: 'string',
            default: '',
            description: 'Buttons and lists: small grey text below the message',
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const operation = this.getNodeParameter<string>('operation', 0);
    const node = this.getNode();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const accountId = this.getNodeParameter<string>('account', i, '');
        if (!accountId) {
          throw new NodeOperationError(node, 'Choose a WhatsApp number', {
            description: 'Connect one on the WhatsApp page (a test number works without any keys).',
            itemIndex: i,
          });
        }
        const whatsapp = this.helpers.whatsapp;

        if (operation === 'markRead') {
          const messageId = this.getNodeParameter<string>('messageId', i);
          await whatsapp.markRead(accountId, messageId, {
            typing: this.getNodeParameter<boolean>('typing', i, false),
          });
          out.push({ json: { success: true, messageId }, pairedItem: { item: i } });
          continue;
        }

        if (operation === 'downloadMedia') {
          const mediaId = this.getNodeParameter<string>('mediaId', i);
          if (!mediaId) throw new NodeOperationError(node, 'Media ID is empty', { itemIndex: i });
          const media = await whatsapp.downloadMedia(accountId, mediaId);
          const field = this.getNodeParameter<string>('binaryPropertyName', i, 'data') || 'data';
          out.push({
            json: {
              ...items[i]!.json,
              mediaId,
              mimeType: media.mimeType,
              fileSize: media.data.length,
            },
            binary: {
              ...(items[i]!.binary ?? {}),
              [field]: this.helpers.prepareBinaryData(media.data, media.fileName, media.mimeType),
            },
            pairedItem: { item: i },
          });
          continue;
        }

        const to = normalisePhone(this.getNodeParameter<string>('to', i, ''));
        if (to.length < 7) {
          throw new NodeOperationError(
            node,
            `"${this.getNodeParameter<string>('to', i, '')}" is not a phone number`,
            {
              description: 'Use the full number with country code, e.g. +91 98765 43210.',
              itemIndex: i,
            },
          );
        }
        const options = this.getNodeParameter<IDataObject>('options', i, {});
        const message = await buildMessage.call(this, operation, i, options, accountId);
        if (options.replyTo && operation !== 'react')
          message.context = { message_id: String(options.replyTo) };
        const result = await whatsapp.send(accountId, to, message);
        out.push({
          json: { ...result, status: 'sent', operation, type: message.type ?? 'text' },
          pairedItem: { item: i },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(node, (error as Error).message, {
          description: (error as { description?: string }).description,
          itemIndex: i,
        });
      }
    }
    return [out];
  },
};

function fail(
  ctx: IExecuteFunctions,
  message: string,
  itemIndex: number,
  description?: string,
): never {
  throw new NodeOperationError(ctx.getNode(), message, { itemIndex, description });
}

function limit(
  ctx: IExecuteFunctions,
  label: string,
  value: string,
  max: number,
  itemIndex: number,
) {
  if (!value.trim()) fail(ctx, `${label} is empty`, itemIndex);
  if (value.length > max)
    fail(ctx, `${label} is ${value.length} characters - WhatsApp allows ${max}`, itemIndex);
}

async function buildMessage(
  this: IExecuteFunctions,
  operation: string,
  i: number,
  options: IDataObject,
  accountId: string,
): Promise<IDataObject> {
  const header = options.headerText
    ? { type: 'text', text: String(options.headerText) }
    : undefined;
  const footer = options.footerText ? { text: String(options.footerText) } : undefined;

  switch (operation) {
    case 'sendText': {
      const body = this.getNodeParameter<string>('text', i, '');
      limit(this, 'Message', body, 4096, i);
      return { type: 'text', text: { body, preview_url: Boolean(options.previewUrl) } };
    }
    case 'sendTemplate': {
      const name = this.getNodeParameter<string>('templateName', i, '');
      if (!name)
        fail(
          this,
          'Choose a template',
          i,
          'Templates are created and approved in Meta WhatsApp Manager.',
        );
      const components: IDataObject[] = [];
      const headerType = this.getNodeParameter<string>('headerType', i, 'none');
      if (headerType === 'text') {
        components.push({
          type: 'header',
          parameters: [{ type: 'text', text: this.getNodeParameter<string>('headerText', i, '') }],
        });
      } else if (headerType !== 'none') {
        const link = this.getNodeParameter<string>('headerMediaUrl', i, '');
        if (!link) fail(this, 'Header media URL is empty', i);
        components.push({
          type: 'header',
          parameters: [{ type: headerType, [headerType]: { link } }],
        });
      }
      const bodyParameters =
        this.getNodeParameter<{ parameter?: Array<{ text: unknown }> }>('bodyParameters', i, {})
          .parameter ?? [];
      if (bodyParameters.length) {
        components.push({
          type: 'body',
          parameters: bodyParameters.map((p) => ({ type: 'text', text: String(p.text ?? '') })),
        });
      }
      return {
        type: 'template',
        template: {
          name,
          language: {
            code: this.getNodeParameter<string>('templateLanguage', i, 'en_US') || 'en_US',
          },
          ...(components.length ? { components } : {}),
        },
      };
    }
    case 'sendMedia': {
      const mediaType = this.getNodeParameter<string>('mediaType', i, 'image');
      const media: IDataObject = {};
      if (this.getNodeParameter<string>('mediaSource', i, 'url') === 'binary') {
        const property = this.getNodeParameter<string>('binaryProperty', i, 'data') || 'data';
        const binary = this.getInputData()[i]?.binary?.[property];
        if (!binary)
          fail(
            this,
            `No binary data in "${property}"`,
            i,
            'The previous node must output a file in this field.',
          );
        const uploaded = await this.helpers.whatsapp.uploadMedia(accountId, {
          data: Buffer.from(binary.data, 'base64'),
          mimeType: binary.mimeType,
          fileName: binary.fileName,
        });
        media.id = uploaded.id;
        if (mediaType === 'document' && binary.fileName) media.filename = binary.fileName;
      } else {
        const link = this.getNodeParameter<string>('mediaUrl', i, '');
        if (!/^https?:\/\//i.test(link))
          fail(this, 'Media URL must start with http:// or https://', i);
        media.link = link;
      }
      const caption = ['image', 'video', 'document'].includes(mediaType)
        ? this.getNodeParameter<string>('caption', i, '')
        : '';
      if (caption) media.caption = caption;
      const fileName =
        mediaType === 'document' ? this.getNodeParameter<string>('fileName', i, '') : '';
      if (fileName) media.filename = fileName;
      return { type: mediaType, [mediaType]: media };
    }
    case 'sendButtons': {
      const body = this.getNodeParameter<string>('bodyText', i, '');
      limit(this, 'Message', body, 1024, i);
      const buttons =
        this.getNodeParameter<{ button?: Array<{ id?: string; title?: string }> }>('buttons', i, {})
          .button ?? [];
      if (buttons.length === 0 || buttons.length > 3)
        fail(this, `WhatsApp allows 1 to 3 buttons (got ${buttons.length})`, i);
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(header ? { header } : {}),
          body: { text: body },
          ...(footer ? { footer } : {}),
          action: {
            buttons: buttons.map((b, index) => {
              const title = String(b.title ?? '');
              limit(this, `Button ${index + 1} title`, title, 20, i);
              return { type: 'reply', reply: { id: String(b.id || `button_${index + 1}`), title } };
            }),
          },
        },
      };
    }
    case 'sendList': {
      const body = this.getNodeParameter<string>('bodyText', i, '');
      limit(this, 'Message', body, 1024, i);
      const button = this.getNodeParameter<string>('listButton', i, 'Choose');
      limit(this, 'Menu button label', button, 20, i);
      const rows =
        this.getNodeParameter<{ row?: Array<Record<string, unknown>> }>('rows', i, {}).row ?? [];
      if (rows.length === 0 || rows.length > 10)
        fail(this, `WhatsApp lists have 1 to 10 choices (got ${rows.length})`, i);
      const sections = new Map<string, IDataObject[]>();
      rows.forEach((row, index) => {
        const title = String(row.title ?? '');
        limit(this, `Choice ${index + 1} title`, title, 24, i);
        const description = String(row.description ?? '');
        if (description.length > 72)
          fail(this, `Choice ${index + 1} description is longer than 72 characters`, i);
        const section = String(row.section ?? '');
        const list = sections.get(section) ?? [];
        list.push({
          id: String(row.id || `row_${index + 1}`),
          title,
          ...(description ? { description } : {}),
        });
        sections.set(section, list);
      });
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(header ? { header } : {}),
          body: { text: body },
          ...(footer ? { footer } : {}),
          action: {
            button,
            sections: [...sections].map(([title, sectionRows]) => ({
              ...(title || sections.size > 1 ? { title: title || 'Options' } : {}),
              rows: sectionRows,
            })),
          },
        },
      };
    }
    case 'sendLocation':
      return {
        type: 'location',
        location: {
          latitude: this.getNodeParameter<number>('latitude', i, 0),
          longitude: this.getNodeParameter<number>('longitude', i, 0),
          name: this.getNodeParameter<string>('locationName', i, ''),
          address: this.getNodeParameter<string>('locationAddress', i, ''),
        },
      };
    case 'react':
      return {
        type: 'reaction',
        reaction: {
          message_id: this.getNodeParameter<string>('messageId', i, ''),
          emoji: this.getNodeParameter<string>('emoji', i, ''),
        },
      };
    default:
      fail(this, `Unknown operation "${operation}"`, i);
  }
}

// ---------------------------------------------------------------------------------------------

const MESSAGE_TYPES = [
  { name: 'Text', value: 'text' },
  { name: 'Button or List Reply', value: 'interactive' },
  { name: 'Template Quick Reply', value: 'button' },
  { name: 'Image', value: 'image' },
  { name: 'Voice Note / Audio', value: 'audio' },
  { name: 'Video', value: 'video' },
  { name: 'Document', value: 'document' },
  { name: 'Sticker', value: 'sticker' },
  { name: 'Location', value: 'location' },
  { name: 'Contacts', value: 'contacts' },
  { name: 'Reaction', value: 'reaction' },
];

export const WhatsAppTrigger: INodeType = {
  description: {
    name: 'flowforge.whatsAppTrigger',
    displayName: 'WhatsApp Trigger',
    icon: ICON,
    iconColor: COLOR,
    group: ['trigger', 'whatsapp'],
    triggerKind: 'event',
    version: 1,
    description:
      'Start the workflow when your WhatsApp number receives a message or a delivery update',
    defaults: { name: 'WhatsApp Trigger' },
    inputs: [],
    outputs: [{ type: 'main' }],
    keywords: ['whatsapp', 'message received', 'incoming', 'chat', 'inbound'],
    properties: [
      {
        ...accountProperty,
        default: '*',
        typeOptions: { loadOptionsMethod: 'whatsappAccountsOrAny' },
      },
      {
        displayName: 'Trigger On',
        name: 'events',
        type: 'multiOptions',
        default: ['message'],
        options: [
          { name: 'Message Received', value: 'message' },
          { name: 'Message Status (sent, delivered, read, failed)', value: 'status' },
        ],
      },
      {
        displayName: 'Only These Message Types',
        name: 'messageTypes',
        type: 'multiOptions',
        default: [],
        description: 'Leave empty for all types',
        options: MESSAGE_TYPES,
      },
      {
        displayName:
          'Use "Listen for test event", then send a message to your number (or use the simulator on the WhatsApp page). The customer is in {{ $json.from }} and the text in {{ $json.text }}.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
    ],
  },
  eventSubscription(parameters: INodeParameters) {
    const events = Array.isArray(parameters.events) ? (parameters.events as string[]) : ['message'];
    const messageTypes = Array.isArray(parameters.messageTypes)
      ? (parameters.messageTypes as string[])
      : [];
    return {
      source: 'whatsapp',
      scope: String(parameters.account || '*'),
      events: events.length ? events : ['message'],
      filter: { messageType: messageTypes },
    };
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    if (this.getMode() === 'manual' && !items.some((item) => 'event' in item.json)) {
      return [[{ json: sampleMessage() }]];
    }
    return [items];
  },
};

/** What a received text message looks like - used for manual runs without a real event. */
export function sampleMessage(): IDataObject {
  return {
    event: 'message',
    sample: true,
    account: { id: 'sample', phoneNumber: '+1 555 010 0000', name: 'Sample number' },
    from: '919876543210',
    contactName: 'Asha',
    messageId: 'wamid.SAMPLE',
    timestamp: new Date().toISOString(),
    type: 'text',
    text: 'Hi! What are your opening hours?',
  };
}
