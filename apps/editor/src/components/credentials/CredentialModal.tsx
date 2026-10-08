import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Link2, PlugZap, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { getNodeParameters, type IDataObject, type INodeParameters } from '@flowforge/workflow';
import { ApiError, endpoints, type CredentialDetail } from '../../lib/api';
import { useCredentialTypes } from '../../stores/credentialTypes';
import { useServer } from '../../stores/server';
import { NdvContext, type NdvContextValue } from '../ndv/context';
import { ParameterForm } from '../ndv/ParameterInputs';
import { Badge, Button, Field, Modal, Spinner } from '../ui';

const formContext: NdvContextValue = {
  inputItems: [],
  inputSource: null,
  runData: null,
  getNodeOutput: () => undefined,
  nodeNames: [],
  workflowName: '',
  timezone: 'UTC',
  vars: {},
  parameters: {},
  readOnly: false,
};

/**
 * Create or edit a credential. Secrets come back masked from the server and
 * are only replaced when the user types a new value.
 */
export function CredentialModal({
  open,
  onClose,
  type: initialType,
  credentialId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  type?: string;
  credentialId?: string;
  onSaved?: (credential: CredentialDetail) => void;
}) {
  const types = useCredentialTypes();
  const settings = useServer((s) => s.settings);
  const queryClient = useQueryClient();
  const [type, setType] = useState(initialType ?? '');
  const [name, setName] = useState('');
  const [data, setData] = useState<INodeParameters>({});
  const [savedId, setSavedId] = useState<string | undefined>(credentialId);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    void types.load();
    void useServer
      .getState()
      .load()
      .catch(() => undefined);
    setResult(null);
    setSavedId(credentialId);
    if (credentialId) {
      setLoading(true);
      endpoints
        .credential(credentialId)
        .then((c) => {
          setType(c.type);
          setName(c.name);
          const { oauthConnected, oauthExpiresAt: _e, ...rest } = c.data;
          setConnected(oauthConnected === undefined ? null : Boolean(oauthConnected));
          setData(rest as INodeParameters);
        })
        .catch((e: Error) => toast.error(e.message))
        .finally(() => setLoading(false));
    } else {
      setType(initialType ?? '');
      setName('');
      setData({});
      setConnected(null);
    }
  }, [open, credentialId, initialType]); // eslint-disable-line react-hooks/exhaustive-deps

  const definition = type ? types.byName[type] : undefined;
  const properties = useMemo(
    () => (definition?.properties ?? []).map((p) => ({ ...p, noDataExpression: true })),
    [definition],
  );
  const values = useMemo(
    () => (definition ? getNodeParameters(properties, data) : data),
    [definition, properties, data],
  );

  useEffect(() => {
    if (definition && !name) setName(definition.displayName);
  }, [definition]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['credentials'] });

  const save = async (): Promise<CredentialDetail | null> => {
    setSaving(true);
    setResult(null);
    try {
      const saved = savedId
        ? await endpoints.updateCredential(savedId, { name, data: values as IDataObject })
        : await endpoints.createCredential({ name, type, data: values as IDataObject });
      setSavedId(saved.id);
      if (saved.data.oauthConnected !== undefined) setConnected(Boolean(saved.data.oauthConnected));
      await refresh();
      onSaved?.(saved);
      toast.success('Credential saved');
      return saved;
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof ApiError ? error.message : (error as Error).message,
      });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      setResult(await endpoints.testCredential({ type, data: values as IDataObject, id: savedId }));
    } catch (error) {
      setResult({ ok: false, message: (error as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    const saved = await save();
    if (!saved) return;
    try {
      const { url } = await endpoints.oauthUrl(saved.id);
      const popup = window.open(url, 'flowforge-oauth', 'width=600,height=720');
      const onMessage = async (event: MessageEvent) => {
        const message = event.data as { type?: string; ok?: boolean };
        if (message?.type !== 'flowforge-oauth2') return;
        window.removeEventListener('message', onMessage);
        const fresh = await endpoints.credential(saved.id);
        setConnected(Boolean(fresh.data.oauthConnected));
        toast[message.ok ? 'success' : 'error'](message.ok ? 'Connected' : 'The connection failed');
        void refresh();
      };
      window.addEventListener('message', onMessage);
      if (!popup) toast.error('Allow pop-ups for this site to connect the account');
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const isOAuth = Boolean(definition?.oauth2);
  const needsBrowserAuth = isOAuth && values.grantType !== 'clientCredentials';

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={credentialId ? 'Edit credential' : 'New credential'}
      footer={
        <>
          {type && (
            <Button icon={PlugZap} loading={testing} onClick={() => void test()}>
              Test connection
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!type || !name.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          {!credentialId && !initialType && (
            <Field label="Credential type">
              <select className="ff-input" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">Choose a type…</option>
                {types.list.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {definition && (
            <>
              <Field label="Name">
                <input
                  className="ff-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              {isOAuth && settings && (
                <div className="rounded-md border border-line bg-panel-2 p-3 text-[12.5px]">
                  <div className="mb-1 font-medium">OAuth Redirect URL</div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate">{settings.oauthCallbackUrl}</code>
                    <button
                      title="Copy"
                      className="text-muted hover:text-fg"
                      onClick={() => {
                        void navigator.clipboard.writeText(settings.oauthCallbackUrl);
                        toast.success('Copied');
                      }}
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                  <div className="mt-1 text-muted">
                    Add this URL to the allowed redirect URLs of your OAuth app.
                  </div>
                </div>
              )}
              <NdvContext.Provider value={formContext}>
                <ParameterForm properties={properties} values={values} onChange={setData} />
              </NdvContext.Provider>
              {needsBrowserAuth && (
                <div className="flex items-center gap-3">
                  <Button icon={Link2} onClick={() => void connect()}>
                    {connected ? 'Reconnect account' : 'Connect account'}
                  </Button>
                  {connected !== null && (
                    <Badge tone={connected ? 'success' : 'warning'}>
                      {connected ? 'Connected' : 'Not connected'}
                    </Badge>
                  )}
                </div>
              )}
            </>
          )}
          {result && (
            <div
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-[13px] ${result.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}
            >
              {result.ok ? (
                <CheckCircle2 size={16} className="mt-px shrink-0" />
              ) : (
                <XCircle size={16} className="mt-px shrink-0" />
              )}
              {result.message}
            </div>
          )}
          <p className="text-xs text-muted">
            Secrets are encrypted with AES-256-GCM on the server and never sent back to the browser.
          </p>
        </div>
      )}
    </Modal>
  );
}
