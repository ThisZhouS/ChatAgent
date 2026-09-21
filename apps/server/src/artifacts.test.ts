import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TaskRecord } from '@chatagent/contracts';
import { createTestApp, devHeaders, OTHER_ORG, poll, TEST_ORG } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) await app.close();
  active = [];
});

async function boot() {
  const test = await createTestApp({ agentIntake: { mode: 'immediate' } });
  active.push(test.app);
  return test;
}

describe('artifact ownership', () => {
  it('binds concurrent task artifacts to their own task only', async () => {
    const { app } = await boot();
    const account = (await app.inject({ method: 'GET', url: '/api/accounts' })).json()[0];

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice'),
      payload: { accountId: account.id, chatId: 'job-a', text: '请生成一份 Word 文档 A' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_bob'),
      payload: { accountId: account.id, chatId: 'job-b', text: '请生成一份 Word 文档 B' },
    });

    const firstTaskId = first.json().taskId as string;
    const secondTaskId = second.json().taskId as string;
    expect(firstTaskId).not.toBe(secondTaskId);

    const tasks = await poll(
      async () => (await app.inject({ method: 'GET', url: '/api/tasks' })).json() as TaskRecord[],
      (list) =>
        list.length === 2 &&
        list.every((task) => task.state === 'completed' || task.state === 'failed'),
    );

    const taskA = tasks.find((task) => task.id === firstTaskId);
    const taskB = tasks.find((task) => task.id === secondTaskId);
    expect(taskA?.state).toBe('completed');
    expect(taskB?.state).toBe('completed');

    const artifactsA = taskA?.artifacts ?? [];
    const artifactsB = taskB?.artifacts ?? [];
    expect(artifactsA).toHaveLength(1);
    expect(artifactsB).toHaveLength(1);
    expect(artifactsA[0]?.id).not.toBe(artifactsB[0]?.id);

    // Strict binding: every artifact carries the owning task id and owner.
    expect(artifactsA[0]?.taskId).toBe(firstTaskId);
    expect(artifactsB[0]?.taskId).toBe(secondTaskId);
    expect(artifactsA[0]?.ownerId).toBe('u_alice');
    expect(artifactsB[0]?.ownerId).toBe('u_bob');

    // The tasks must not cross-claim each other's files.
    const idsA = new Set(artifactsA.map((artifact) => artifact.id));
    expect(idsA.has(artifactsB[0]?.id ?? '')).toBe(false);
  });

  it('authorizes artifact download per task reader and organization', async () => {
    const { app } = await boot();
    const account = (await app.inject({ method: 'GET', url: '/api/accounts' })).json()[0];

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice'),
      payload: { accountId: account.id, chatId: 'job-download', text: '请生成一份 Word 文档' },
    });
    const taskId = sent.json().taskId as string;

    const tasks = await poll(
      async () => (await app.inject({ method: 'GET', url: '/api/tasks' })).json() as TaskRecord[],
      (list) => list.some((task) => task.id === taskId && task.state === 'completed'),
    );
    const artifactId = tasks.find((task) => task.id === taskId)?.artifacts[0]?.id;
    expect(artifactId).toBeTruthy();

    const owner = await app.inject({
      method: 'GET',
      url: `/api/files/${artifactId}`,
      headers: devHeaders('u_alice'),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['content-type']).toContain('wordprocessingml');

    const otherMember = await app.inject({
      method: 'GET',
      url: `/api/files/${artifactId}`,
      headers: devHeaders('u_carol'),
    });
    expect(otherMember.statusCode).toBe(404);

    const otherOrg = await app.inject({
      method: 'GET',
      url: `/api/files/${artifactId}`,
      headers: devHeaders('u_bob', OTHER_ORG),
    });
    expect(otherOrg.statusCode).toBe(404);

    const orgAdminList = await app.inject({
      method: 'GET',
      url: '/api/files',
      headers: devHeaders('u_admin', TEST_ORG, 'Admin'),
    });
    expect(orgAdminList.statusCode).toBe(200);

    const otherOrgList = await app.inject({
      method: 'GET',
      url: '/api/files',
      headers: devHeaders('u_bob', OTHER_ORG),
    });
    expect(otherOrgList.json().artifacts).toHaveLength(0);
    expect(otherOrgList.json().uploads).toHaveLength(0);
  });

  it('authorizes uploaded files by uploader and organization', async () => {
    const { app } = await boot();

    const multipart = buildMultipart('notes.txt', 'text/plain', 'hello world');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...devHeaders('u_alice'), 'content-type': multipart.contentType },
      payload: multipart.payload,
    });
    expect(upload.statusCode).toBe(200);
    const uploadId = upload.json().file.id as string;
    expect(upload.json().summary.kind).toBe('text');

    const otherMember = await app.inject({
      method: 'GET',
      url: `/api/files/${uploadId}`,
      headers: devHeaders('u_carol'),
    });
    expect(otherMember.statusCode).toBe(404);

    const otherOrg = await app.inject({
      method: 'GET',
      url: `/api/files/${uploadId}`,
      headers: devHeaders('u_bob', OTHER_ORG),
    });
    expect(otherOrg.statusCode).toBe(404);

    const uploader = await app.inject({
      method: 'GET',
      url: `/api/files/${uploadId}`,
      headers: devHeaders('u_alice'),
    });
    expect(uploader.statusCode).toBe(200);

    const generated = await app.inject({
      method: 'POST',
      url: '/api/documents/generate/excel',
      headers: devHeaders('u_alice'),
      payload: {
        fileName: 'alice.xlsx',
        sheets: [{ name: 'Sheet1', header: ['a'], rows: [['1']] }],
      },
    });
    expect(generated.statusCode).toBe(200);
    const artifactId = generated.json().id as string;

    const artifactForOtherMember = await app.inject({
      method: 'GET',
      url: `/api/files/${artifactId}`,
      headers: devHeaders('u_carol'),
    });
    expect(artifactForOtherMember.statusCode).toBe(404);

    const artifactForUploader = await app.inject({
      method: 'GET',
      url: `/api/files/${artifactId}`,
      headers: devHeaders('u_alice'),
    });
    expect(artifactForUploader.statusCode).toBe(200);
  });
});

function buildMultipart(
  filename: string,
  contentType: string,
  content: string,
): { payload: string; contentType: string } {
  const boundary = '----chatagenttestboundary';
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { payload: body, contentType: `multipart/form-data; boundary=${boundary}` };
}
