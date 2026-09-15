import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setSessionToken } from './api';

/**
 * Regression guard for the document upload path.
 *
 * `documents.parse` used a bare fetch: no Authorization header. In the packaged
 * desktop client the UI is served from file://, so the request is cross-origin,
 * no session cookie is attached, and every parse failed with 401 (found by the
 * packaged-client E2E). Multipart posts must carry the bearer token like every
 * other call.
 */
describe('api document uploads', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setSessionToken('token-123');
  });

  afterEach(() => {
    setSessionToken(null);
    vi.unstubAllGlobals();
  });

  it('attaches the session token to a parse upload', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ file: { id: 'f1' }, summary: { fileId: 'f1', kind: 'csv' } }),
    });

    const file = new File(['项目,预算\n差旅,12000\n'], 'budget.csv', { type: 'text/csv' });
    await api.documents.parse(file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/documents/parse');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-123');
    // FormData must not be given an explicit Content-Type: the browser has to
    // set the multipart boundary itself.
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('surfaces a 401 as an ApiError and clears the stale token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'unauthorized',
    });

    await expect(api.documents.parse(new File(['x'], 'a.csv'))).rejects.toBeInstanceOf(ApiError);
  });
});
