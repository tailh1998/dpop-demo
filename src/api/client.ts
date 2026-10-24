import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { config, toApiUrl } from '../config';
import { session } from '../auth/session';
import { dpopProofService } from '../security/DpopProofService';

type RetryableRequest = InternalAxiosRequestConfig & { _dpopRetry?: boolean };

export const apiClient = axios.create({
  baseURL: config.apiBaseUrl,
  headers: { 'Content-Type': 'application/json' }
});

apiClient.interceptors.request.use(async (request) => {
  const accessToken = session.getAccessToken();
  if (!accessToken) throw new Error('No authenticated DPoP session is available.');

  const requestUrl = toApiUrl(request.url || '/');
  const proof = await dpopProofService.createProof(request.method || 'GET', requestUrl, accessToken);
  request.headers.set('Authorization', `DPoP ${accessToken}`);
  request.headers.set('DPoP', proof);
  return request;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryableRequest | undefined;
    if (error.response?.status !== 401 || !originalRequest) {
      return Promise.reject(error);
    }
    if (originalRequest._dpopRetry) {
      await session.logout();
      return Promise.reject(error);
    }

    originalRequest._dpopRetry = true;
    await session.refresh();
    return apiClient.request(originalRequest);
  }
);
