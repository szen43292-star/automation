import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';
import { googleJson, toList } from '../shared/google';

const CREDENTIAL = 'gmailOAuth2';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** RFC 2047 encoded-word, so subjects and names may contain any character. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Header values must not carry line breaks (they would start new headers). */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export interface MailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html: boolean;
  replyTo?: string;
}

/** An RFC 822 message, base64url-encoded as the Gmail API wants it. */
export function buildRawMessage(mail: MailInput): string {
  const headers = [
    `To: ${mail.to.map(oneLine).join(', ')}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.map(oneLine).join(', ')}`] : []),
    ...(mail.bcc?.length ? [`Bcc: ${mail.bcc.map(oneLine).join(', ')}`] : []),
    ...(mail.replyTo ? [`Reply-To: ${oneLine(mail.replyTo)}`] : []),
    `Subject: ${encodeHeader(oneLine(mail.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: ${mail.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(mail.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

export const Gmail: INodeType = {
  description: {
    name: 'flowforge.gmail',
    displayName: 'Gmail',
    icon: 'mail',
    iconColor: '#ea4335',
    group: ['apps'],
    version: 1,
    description: 'Send an email from your Gmail account',
    subtitle: '={{ "Send to " + $parameter.sendTo }}',
    defaults: { name: 'Gmail' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['gmail', 'email', 'mail', 'send', 'notify', 'google'],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        default: 'message',
        noDataExpression: true,
        options: [{ name: 'Message', value: 'message' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'send',
        noDataExpression: true,
        options: [{ name: 'Send', value: 'send', description: 'Send an email' }],
      },
      {
        displayName: 'To',
        name: 'sendTo',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'you@example.com',
        description: 'One address, or several separated by commas',
      },
      { displayName: 'Subject', name: 'subject', type: 'string', default: '', required: true },
      {
        displayName: 'Email Type',
        name: 'emailType',
        type: 'options',
        default: 'text',
        options: [
          { name: 'Text', value: 'text' },
          { name: 'HTML', value: 'html' },
        ],
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 6 },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          { displayName: 'CC', name: 'ccList', type: 'string', default: '' },
          { displayName: 'BCC', name: 'bccList', type: 'string', default: '' },
          { displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const to = toList(this.getNodeParameter('sendTo', i, ''));
        if (!to.length || to.some((address) => !address.includes('@')))
          throw new NodeOperationError(this.getNode(), 'Enter the email address to send to', {
            itemIndex: i,
          });
        const options = this.getNodeParameter<IDataObject>('options', i, {});
        const raw = buildRawMessage({
          to,
          cc: toList(options.ccList),
          bcc: toList(options.bccList),
          subject: String(this.getNodeParameter('subject', i, '')),
          body: String(this.getNodeParameter('message', i, '')),
          html: this.getNodeParameter<string>('emailType', i, 'text') === 'html',
          replyTo: options.replyTo ? String(options.replyTo) : undefined,
        });
        const sent = await googleJson(
          this,
          CREDENTIAL,
          { url: SEND_URL, method: 'POST', body: { raw } },
          i,
        );
        output.push({ json: sent, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          output.push(errorItem(this, error, i, items[i]));
          continue;
        }
        throw error;
      }
    }
    return [output];
  },
};
