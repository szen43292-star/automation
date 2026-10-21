import type { Credential, PrismaClient, Prisma } from '@prisma/client';
import {
  CREDENTIAL_SECRET_MASK,
  applyCredentialAuthentication,
  isPropertyVisible,
  type INodeParameters,
  type ICredentialType,
  type ICredentialTypes,
  type IDataObject,
  type IHttpRequestOptions,
  type INode,
} from '@flowforge/workflow';
import { httpRequest } from '@flowforge/engine';
import type { ICredentialsHelper } from '@flowforge/engine';
import type { AuthUser } from '../auth/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import type { Cipher } from './cipher';
import {
  clientCredentialsToken,
  isExpired,
  refreshToken,
  type OAuth2Settings,
  type OAuth2TokenData,
} from './oauth2';

export interface CredentialDTO {
  id: string;
  name: string;
  type: string;
  data?: IDataObject;
  owner?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface CredentialTestResult {
  ok: boolean;
  message: string;
}

function secretFields(type: ICredentialType): string[] {
  return type.properties.filter((p) => p.typeOptions?.password).map((p) => p.name);
}

export class CredentialsService {
  private readonly refreshLocks = new Map<string, Promise<OAuth2TokenData>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: Cipher,
    readonly types: ICredentialTypes,
  ) {}

  scope(user: AuthUser): Prisma.CredentialWhereInput {
    return user.role === 'member' ? { ownerId: user.id } : {};
  }

  private type(name: string): ICredentialType {
    const type = this.types.get(name);
    if (!type) throw badRequest(`Unknown credential type "${name}"`);
    return type;
  }

  /** Replace secrets with a mask; OAuth2 tokens become a connection summary. */
  mask(type: ICredentialType, data: IDataObject): IDataObject {
    const out: IDataObject = { ...data };
    for (const field of secretFields(type)) {
      if (out[field]) out[field] = CREDENTIAL_SECRET_MASK;
    }
    if (type.oauth2) {
      const token = data.oauthTokenData as OAuth2TokenData | undefined;
      delete out.oauthTokenData;
      out.oauthConnected = Boolean(token?.access_token);
      if (token?.expires_at) out.oauthExpiresAt = new Date(token.expires_at).toISOString();
    }
    return out;
  }

  private toDTO(
    row: Credential & { owner?: { id: string; name: string } },
    includeData: boolean,
  ): CredentialDTO {
    const type = this.types.get(row.type);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      ...(includeData && type
        ? { data: this.mask(type, this.cipher.decryptJson<IDataObject>(row.data)) }
        : {}),
      ...(row.owner ? { owner: row.owner } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private validate(type: ICredentialType, data: IDataObject) {
    const values = Object.fromEntries(
      type.properties.map((p) => [p.name, data[p.name] ?? p.default]),
    ) as INodeParameters;
    for (const prop of type.properties) {
      if (!prop.required || !isPropertyVisible(prop.displayOptions, values)) continue;
      if (data[prop.name] === undefined || data[prop.name] === '')
        throw badRequest(`"${prop.displayName}" is required`);
    }
  }

  /** Merge incoming data with stored data: masked secrets keep their old value. */
  private merge(type: ICredentialType, stored: IDataObject, incoming: IDataObject): IDataObject {
    const merged: IDataObject = { ...stored, ...incoming };
    for (const field of secretFields(type)) {
      if (incoming[field] === CREDENTIAL_SECRET_MASK) merged[field] = stored[field];
    }
    delete merged.oauthConnected;
    delete merged.oauthExpiresAt;
    if (type.oauth2) merged.oauthTokenData = stored.oauthTokenData;
    return merged;
  }

  async list(user: AuthUser, type?: string): Promise<CredentialDTO[]> {
    const rows = await this.prisma.credential.findMany({
      where: { ...this.scope(user), ...(type ? { type } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: { owner: { select: { id: true, name: true } } },
    });
    return rows.map((r) => this.toDTO(r, false));
  }

  async getRow(user: AuthUser, id: string): Promise<Credential> {
    const row = await this.prisma.credential.findFirst({ where: { id, ...this.scope(user) } });
    if (!row) throw notFound('Credential');
    return row;
  }

  async get(user: AuthUser, id: string): Promise<CredentialDTO> {
    return this.toDTO(await this.getRow(user, id), true);
  }

  async create(
    user: AuthUser,
    input: { name: string; type: string; data: IDataObject },
  ): Promise<CredentialDTO> {
    const type = this.type(input.type);
    const data = this.merge(type, {}, input.data);
    if (type.oauth2) delete data.oauthTokenData;
    this.validate(type, data);
    const row = await this.prisma.credential.create({
      data: {
        name: input.name,
        type: input.type,
        ownerId: user.id,
        data: this.cipher.encryptJson(data),
      },
    });
    return this.toDTO(row, true);
  }

  async update(
    user: AuthUser,
    id: string,
    input: { name?: string; data?: IDataObject },
  ): Promise<CredentialDTO> {
    const row = await this.getRow(user, id);
    if (user.role === 'member' && row.ownerId !== user.id) throw forbidden();
    const type = this.type(row.type);
    let data = this.cipher.decryptJson<IDataObject>(row.data);
    if (input.data) {
      const settingsChanged =
        type.oauth2 &&
        ['clientId', 'accessTokenUrl', 'authUrl', 'scope'].some(
          (k) => input.data![k] !== undefined && input.data![k] !== data[k],
        );
      data = this.merge(type, data, input.data);
      if (settingsChanged) delete data.oauthTokenData; // must reconnect
      this.validate(type, data);
    }
    const updated = await this.prisma.credential.update({
      where: { id },
      data: { name: input.name, data: this.cipher.encryptJson(data) },
    });
    return this.toDTO(updated, true);
  }

  async remove(user: AuthUser, id: string) {
    const row = await this.getRow(user, id);
    if (user.role === 'member' && row.ownerId !== user.id) throw forbidden();
    await this.prisma.credential.delete({ where: { id } });
  }

  async decrypt(id: string): Promise<{ row: Credential; data: IDataObject }> {
    const row = await this.prisma.credential.findUnique({ where: { id } });
    if (!row)
      throw new Error('The credential used by this node no longer exists. Select another one.');
    const data = this.cipher.decryptJson<IDataObject>(row.data);
    // Ready-made OAuth2 credentials (Google, ...) keep their fixed settings in the type.
    const defaults = this.types.get(row.type)?.oauth2Defaults;
    return { row, data: defaults ? { ...data, ...defaults } : data };
  }

  async storeData(id: string, data: IDataObject) {
    await this.prisma.credential.update({
      where: { id },
      data: { data: this.cipher.encryptJson(data) },
    });
  }

  /** Valid OAuth2 token for a credential, refreshing (once at a time) when expired. */
  async oauthToken(id: string, force = false): Promise<OAuth2TokenData> {
    const pending = this.refreshLocks.get(id);
    if (pending) return pending;
    const { data } = await this.decrypt(id);
    const settings = data as unknown as OAuth2Settings;
    let token = data.oauthTokenData as OAuth2TokenData | undefined;
    if (!force && token && !isExpired(token)) return token;
    if (!token && settings.grantType !== 'clientCredentials') {
      throw new Error('This OAuth2 credential is not connected yet. Open it and click "Connect".');
    }
    const work = (async () => {
      token = token ? await refreshToken(settings, token) : await clientCredentialsToken(settings);
      await this.storeData(id, { ...data, oauthTokenData: token });
      return token;
    })();
    this.refreshLocks.set(id, work);
    try {
      return await work;
    } finally {
      this.refreshLocks.delete(id);
    }
  }

  async authenticate(
    credentialId: string,
    typeName: string,
    options: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> {
    const type = this.type(typeName);
    const { row, data } = await this.decrypt(credentialId);
    if (row.type !== typeName)
      throw new Error(`The selected credential is a "${row.type}", not a "${typeName}"`);
    if (type.oauth2) {
      const token = await this.oauthToken(credentialId);
      return applyCredentialAuthentication({ type: 'oauth2' }, { oauthTokenData: token }, options);
    }
    if (!type.authenticate) return options;
    return applyCredentialAuthentication(type.authenticate, data, options);
  }

  async test(
    user: AuthUser,
    input: { type: string; data: IDataObject; id?: string },
  ): Promise<CredentialTestResult> {
    const type = this.type(input.type);
    const stored = input.id
      ? this.cipher.decryptJson<IDataObject>((await this.getRow(user, input.id)).data)
      : {};
    const data = this.merge(type, stored, input.data);
    try {
      this.validate(type, data);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    try {
      if (type.oauth2) {
        if (data.grantType === 'clientCredentials') {
          await clientCredentialsToken(data as unknown as OAuth2Settings);
          return { ok: true, message: 'Got an access token from the token URL' };
        }
        return data.oauthTokenData
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: 'Not connected yet - save, then click "Connect"' };
      }
      const testUrl =
        type.test?.request.url ??
        (typeof data.testUrl === 'string' && data.testUrl ? data.testUrl : undefined);
      if (!testUrl || !type.authenticate) {
        return {
          ok: true,
          message: 'Saved. This credential type has no automatic connection test.',
        };
      }
      const request = applyCredentialAuthentication(type.authenticate, data, {
        ...(type.test?.request ?? {}),
        url: testUrl,
        timeout: 15_000,
      });
      const response = await httpRequest(request);
      const expected = type.test?.expectStatus;
      const ok = expected ? response.statusCode === expected : response.statusCode < 400;
      return ok
        ? { ok: true, message: `Connection works (HTTP ${response.statusCode})` }
        : {
            ok: false,
            message: `The service answered HTTP ${response.statusCode} - check the credential`,
          };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /**
   * Engine-facing helper for one execution. Only credentials owned by the
   * workflow owner (or any credential, for owner/admin workflow owners) may be used.
   */
  helper(workflowOwner: { id: string; role: string } | null): ICredentialsHelper {
    const cache = new Map<string, IDataObject>();
    const resolve = async (node: INode, type: string) => {
      const ref = node.credentials?.[type];
      if (!ref) throw new Error(`No "${type}" credential selected on node "${node.name}"`);
      const { row, data } = await this.decrypt(ref.id);
      if (row.type !== type)
        throw new Error(`The selected credential is a "${row.type}", not a "${type}"`);
      if (workflowOwner && workflowOwner.role === 'member' && row.ownerId !== workflowOwner.id) {
        throw new Error(`The workflow owner has no access to credential "${row.name}"`);
      }
      return { id: row.id, data };
    };
    return {
      getDecrypted: async (node, type) => {
        const key = `${node.name}:${type}`;
        if (!cache.has(key)) {
          const { data } = await resolve(node, type);
          const copy = { ...data };
          delete copy.oauthTokenData;
          cache.set(key, copy);
        }
        return { ...cache.get(key)! };
      },
      authenticateRequest: async (node, type, options) => {
        const { id } = await resolve(node, type);
        return this.authenticate(id, type, options);
      },
      refreshOAuth2: async (node, type) => {
        if (!this.types.get(type)?.oauth2) return false;
        const { id } = await resolve(node, type);
        try {
          await this.oauthToken(id, true);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
}
