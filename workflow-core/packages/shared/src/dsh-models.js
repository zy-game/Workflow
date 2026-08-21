const DEFAULT_MODEL_NAMESPACE = 'agent-default-model';

function getPath(value, path) {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[segment];
  }
  return current;
}

export function deriveCredentialRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function credentialRefFor(namespace, settingsPath, provider) {
  const profile = getPath(namespace.value, settingsPath);
  const ref = profile?.apiKeyEnv;
  return typeof ref === 'string' && ref.length > 0 ? ref : deriveCredentialRef(provider);
}

function providerOps(namespace, descriptor, entry, credentialRef) {
  const { settingsPath } = descriptor;
  const profile = getPath(namespace.value, settingsPath);
  if (settingsPath.length === 0) {
    if (!profile || typeof profile !== 'object') {
      throw new Error(`DSH provider ${entry.provider} has no settings profile`);
    }
    return profile.apiKeyEnv ? [] : [{
      op: 'set', path: ['apiKeyEnv'], value: credentialRef,
    }];
  }

  if (!profile || typeof profile !== 'object') {
    return [{
      op: 'set',
      path: settingsPath,
      value: {
        apiKeyEnv: credentialRef,
        baseURL: entry.baseUrl,
        models: [{ id: entry.model }],
      },
    }];
  }

  const ops = [];
  if (!profile.apiKeyEnv) {
    ops.push({ op: 'set', path: [...settingsPath, 'apiKeyEnv'], value: credentialRef });
  }
  if (profile.baseURL !== entry.baseUrl) {
    ops.push({ op: 'set', path: [...settingsPath, 'baseURL'], value: entry.baseUrl });
  }
  const models = Array.isArray(profile.models) ? profile.models : [];
  if (!models.some((model) => (typeof model === 'string' ? model : model?.id) === entry.model)) {
    ops.push({
      op: 'set',
      path: [...settingsPath, 'models'],
      value: [...models, { id: entry.model }],
    });
  }
  return ops;
}

export async function applyDshModel(client, entry, { activate = true } = {}) {
  if (!entry?.provider || !entry?.model || !entry?.key || !entry?.baseUrl) {
    throw new TypeError('provider, model, key, and baseUrl are required');
  }

  const [providerResult, settingsResult] = await Promise.all([
    client.call('llm.providers', {}),
    client.call('settings.describe', {}),
  ]);
  const providers = Array.isArray(providerResult?.providers) ? providerResult.providers : [];
  const descriptor = providers.find((candidate) => candidate.provider === entry.provider);
  if (!descriptor || !descriptor.settingsNs || !Array.isArray(descriptor.settingsPath)) {
    throw new Error(`DSH provider ${entry.provider} is not configurable`);
  }

  const namespaces = Array.isArray(settingsResult?.namespaces) ? settingsResult.namespaces : [];
  const namespace = namespaces.find((candidate) => candidate.ns === descriptor.settingsNs);
  if (!namespace) throw new Error(`DSH settings namespace ${descriptor.settingsNs} is unavailable`);
  const defaultModel = namespaces.find((candidate) => candidate.ns === DEFAULT_MODEL_NAMESPACE);
  if (!defaultModel) throw new Error(`DSH settings namespace ${DEFAULT_MODEL_NAMESPACE} is unavailable`);

  const credentialRef = credentialRefFor(namespace, descriptor.settingsPath, entry.provider);
  const ops = providerOps(namespace, descriptor, entry, credentialRef);
  if (ops.length > 0) {
    await client.call('settings.mutate', {
      ns: descriptor.settingsNs,
      ops,
      expectedRevision: namespace.revision,
    });
  }

  await client.call('credentials.set', { ref: credentialRef, value: entry.key });

  if (activate) {
    const selection = defaultModel.value ?? {};
    if (selection.provider !== entry.provider || selection.model !== entry.model) {
      await client.call('settings.mutate', {
        ns: DEFAULT_MODEL_NAMESPACE,
        ops: [
          { op: 'set', path: ['provider'], value: entry.provider },
          { op: 'set', path: ['model'], value: entry.model },
        ],
        expectedRevision: defaultModel.revision,
      });
    }
  }

  return { provider: entry.provider, model: entry.model, credentialRef };
}
