import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';
import { googleJson, googleRequest, toList } from '../shared/google';

const CREDENTIAL = 'youTubeOAuth2Api';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

/** YouTube's video categories (the same ids in every region that has them). */
const CATEGORIES: Array<[string, string]> = [
  ['1', 'Film & Animation'],
  ['2', 'Autos & Vehicles'],
  ['10', 'Music'],
  ['15', 'Pets & Animals'],
  ['17', 'Sports'],
  ['19', 'Travel & Events'],
  ['20', 'Gaming'],
  ['22', 'People & Blogs'],
  ['23', 'Comedy'],
  ['24', 'Entertainment'],
  ['25', 'News & Politics'],
  ['26', 'Howto & Style'],
  ['27', 'Education'],
  ['28', 'Science & Technology'],
  ['29', 'Nonprofits & Activism'],
];

export const YouTube: INodeType = {
  description: {
    name: 'flowforge.youTube',
    displayName: 'YouTube',
    icon: 'video',
    iconColor: '#ff0000',
    group: ['apps'],
    version: 1,
    description: 'Upload a video to your YouTube channel',
    subtitle: 'Upload video',
    defaults: { name: 'YouTube' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['youtube', 'video', 'upload', 'shorts', 'channel', 'google'],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        default: 'video',
        noDataExpression: true,
        options: [{ name: 'Video', value: 'video' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'upload',
        noDataExpression: true,
        options: [{ name: 'Upload', value: 'upload', description: 'Upload a video file' }],
      },
      { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
      {
        displayName: 'Region Code',
        name: 'regionCode',
        type: 'string',
        default: 'IN',
        placeholder: 'IN',
        description: 'Two-letter country code of the audience the category is meant for',
      },
      {
        displayName: 'Category',
        name: 'categoryId',
        type: 'options',
        default: '22',
        options: CATEGORIES.map(([value, name]) => ({ name, value })),
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        description: 'The binary field of the input item that holds the video file',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Description',
            name: 'description',
            type: 'string',
            default: '',
            typeOptions: { rows: 4 },
          },
          {
            displayName: 'Tags',
            name: 'tags',
            type: 'string',
            default: '',
            description: 'Comma-separated, or an expression that returns a list',
          },
          {
            displayName: 'Privacy Status',
            name: 'privacyStatus',
            type: 'options',
            default: 'private',
            options: [
              { name: 'Private', value: 'private' },
              { name: 'Unlisted', value: 'unlisted' },
              { name: 'Public', value: 'public' },
            ],
          },
          {
            displayName: 'Made for Kids',
            name: 'selfDeclaredMadeForKids',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Default Language',
            name: 'defaultLanguage',
            type: 'string',
            default: '',
            placeholder: 'en',
          },
          {
            displayName: 'Notify Subscribers',
            name: 'notifySubscribers',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const field = this.getNodeParameter<string>('binaryPropertyName', i, 'data');
        const file = items[i]!.binary?.[field];
        if (!file?.data)
          throw new NodeOperationError(this.getNode(), `The input has no binary field "${field}"`, {
            itemIndex: i,
            description:
              'Download the video first, e.g. with an HTTP Request whose response is a File.',
          });
        const title = String(this.getNodeParameter('title', i) ?? '').trim();
        if (!title)
          throw new NodeOperationError(this.getNode(), 'The video needs a title', { itemIndex: i });
        const options = this.getNodeParameter<IDataObject>('options', i, {});
        const video = Buffer.from(file.data, 'base64');
        const mimeType = file.mimeType?.startsWith('video/') ? file.mimeType : 'video/mp4';
        const tags = toList(options.tags);
        const metadata = {
          snippet: {
            title: title.slice(0, 100),
            description: String(options.description ?? ''),
            categoryId: String(this.getNodeParameter('categoryId', i, '22')),
            ...(tags.length ? { tags } : {}),
            ...(options.defaultLanguage
              ? { defaultLanguage: String(options.defaultLanguage) }
              : {}),
          },
          status: {
            privacyStatus: String(options.privacyStatus ?? 'private'),
            selfDeclaredMadeForKids: Boolean(options.selfDeclaredMadeForKids),
          },
        };

        // Resumable upload: create the upload session, then send the file to it.
        const session = await googleRequest(
          this,
          CREDENTIAL,
          {
            url: UPLOAD_URL,
            method: 'POST',
            qs: {
              uploadType: 'resumable',
              part: 'snippet,status',
              notifySubscribers: Boolean(options.notifySubscribers),
            },
            headers: {
              'content-type': 'application/json; charset=UTF-8',
              'x-upload-content-type': mimeType,
              'x-upload-content-length': String(video.length),
            },
            body: metadata,
          },
          i,
        );
        const location = session.headers.location;
        if (!location)
          throw new NodeOperationError(this.getNode(), 'YouTube did not start the upload', {
            itemIndex: i,
          });
        const uploaded = await googleJson(
          this,
          CREDENTIAL,
          {
            url: location,
            method: 'PUT',
            headers: { 'content-type': mimeType },
            body: new Uint8Array(video),
            timeout: 30 * 60_000,
            responseType: 'json',
          },
          i,
        );
        output.push({ json: uploaded, pairedItem: { item: i } });
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
