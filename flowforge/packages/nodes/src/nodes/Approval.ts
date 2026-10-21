import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';

export const Approval: INodeType = {
  description: {
    name: 'flowforge.approval',
    displayName: 'Ask for Approval',
    icon: 'circle-check',
    iconColor: '#16a34a',
    group: ['flow'],
    version: 1,
    description:
      'Ask yourself to approve something (e.g. a video) from your phone: a link opens a page with the video and Approve / Reject',
    subtitle: '={{ $parameter.operation === "media" ? "Get approved video" : "Request approval" }}',
    defaults: { name: 'Ask for Approval' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['approve', 'approval', 'review', 'confirm', 'human', 'phone', 'decision'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'request',
        noDataExpression: true,
        options: [
          {
            name: 'Request Approval',
            value: 'request',
            description: 'Save the video and create the approval link',
          },
          {
            name: 'Get Approved Video',
            value: 'media',
            description: 'Load the video saved with an approval (e.g. to upload it)',
          },
        ],
      },
      {
        displayName:
          'Send the link in "approval_url" to yourself (e.g. with Gmail), then add a Wait node set to "On Webhook Call": your answer on the page continues the workflow with { approved: true } or { approved: false }.',
        name: 'requestNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { operation: ['request'] } },
      },
      {
        displayName: 'Title',
        name: 'title',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['request'] } },
      },
      {
        displayName: 'Details',
        name: 'description',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: { show: { operation: ['request'] } },
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        description: 'The video (or image) to show on the approval page. Empty = none.',
        displayOptions: { show: { operation: ['request'] } },
      },
      {
        displayName: 'Expires After (hours)',
        name: 'expiresAfterHours',
        type: 'number',
        default: 24,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { operation: ['request'] } },
      },
      {
        displayName: 'Approval ID',
        name: 'approvalId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['media'] } },
      },
      {
        displayName: 'Output Binary Field',
        name: 'outputBinaryPropertyName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { operation: ['media'] } },
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const operation = this.getNodeParameter<string>('operation', 0);
    const output: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        if (operation === 'media') {
          const id = String(this.getNodeParameter('approvalId', i, '') ?? '').trim();
          if (!id)
            throw new NodeOperationError(this.getNode(), 'Enter the approval ID', { itemIndex: i });
          const field = this.getNodeParameter<string>('outputBinaryPropertyName', i, 'data');
          const media = await this.helpers.approvals.media(id);
          output.push({
            json: { ...items[i]!.json, approval_id: id },
            binary: {
              [field || 'data']: this.helpers.prepareBinaryData(
                media.data,
                media.fileName,
                media.mimeType,
              ),
            },
            pairedItem: { item: i },
          });
          continue;
        }

        const title = String(this.getNodeParameter('title', i, '') ?? '').trim();
        if (!title)
          throw new NodeOperationError(this.getNode(), 'The approval needs a title', {
            itemIndex: i,
          });
        const field = String(this.getNodeParameter('binaryPropertyName', i, 'data') ?? '').trim();
        const file = field ? items[i]!.binary?.[field] : undefined;
        if (field && !file?.data)
          throw new NodeOperationError(this.getNode(), `The input has no binary field "${field}"`, {
            itemIndex: i,
            description: 'Download the video first, or empty "Input Binary Field" for no video.',
          });
        const hours = Number(this.getNodeParameter('expiresAfterHours', i, 24)) || 24;
        const created = await this.helpers.approvals.create({
          title,
          description: String(this.getNodeParameter('description', i, '') ?? ''),
          ...(file
            ? {
                media: {
                  data: Buffer.from(file.data, 'base64'),
                  mimeType: file.mimeType || 'application/octet-stream',
                  fileName: file.fileName,
                },
              }
            : {}),
          expiresAt: new Date(Date.now() + hours * 3_600_000),
        });
        const json: IDataObject = {
          approval_id: created.id,
          approval_url: created.url,
          local_url: created.localUrl,
          expires_at: created.expiresAt,
        };
        output.push({ json, pairedItem: { item: i } });
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
