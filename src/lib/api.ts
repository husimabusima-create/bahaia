import type {
  AppSettings,
  AuthUserInfo,
  AutomationConfig,
  AutomationRunLog,
  DashboardSummary,
  HealthStatus,
  SettingsResponse,
  TopicHistoryEntry,
  TopicSuggestion,
  VideoCategory,
  VideoJob,
  VideoScript,
  VisualMode,
} from '../types';
import { auth } from './firebase';

export class ApiClientError extends Error {
  code: string;
  retryable: boolean;
  status: number;

  constructor(message: string, code: string, retryable: boolean, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

async function buildAuthHeaders(
  initHeaders?: HeadersInit,
  forceRefresh = false
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (initHeaders) {
    const normalized = new Headers(initHeaders);
    normalized.forEach((value, key) => {
      headers[key] = value;
    });
  }

  if (!headers['Authorization'] && !headers['authorization'] && auth.currentUser) {
    try {
      const token = await auth.currentUser.getIdToken(forceRefresh);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    } catch {
      // Let backend return 401 cleanly if token retrieval fails
    }
  }

  return headers;
}

async function request<T>(
  url: string,
  init?: RequestInit,
  allowTokenRetry = true
): Promise<T> {
  const headers = await buildAuthHeaders(init?.headers, false);
  let res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (
    res.status === 401 &&
    allowTokenRetry &&
    auth.currentUser &&
    url !== '/api/auth/session' &&
    url !== '/api/auth/logout'
  ) {
    try {
      const freshToken = await auth.currentUser.getIdToken(true);
      if (freshToken) {
        await fetch('/api/auth/session', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${freshToken}`,
          },
          body: JSON.stringify({}),
        });
        const retryHeaders = await buildAuthHeaders(init?.headers, false);
        retryHeaders['Authorization'] = `Bearer ${freshToken}`;
        res = await fetch(url, {
          ...init,
          credentials: 'include',
          headers: retryHeaders,
        });
      }
    } catch {
      // Fall through to normal error handling
    }
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body fallback
  }

  if (!res.ok) {
    const errObj =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { code?: string; message?: string; retryable?: boolean } }).error
        : undefined;
    throw new ApiClientError(
      errObj?.message || `Request failed with status ${res.status}`,
      errObj?.code || 'HTTP_ERROR',
      Boolean(errObj?.retryable),
      res.status
    );
  }

  return body as T;
}

export const api = {
  createSession: (idToken: string) =>
    request<{ authenticated: boolean; user: AuthUserInfo }>(
      '/api/auth/session',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({}),
      },
      false
    ),

  clearSession: () =>
    request<{ signedOut: boolean }>(
      '/api/auth/logout',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
      false
    ),

  getMe: () => request<{ authenticated: boolean; user: AuthUserInfo }>('/api/auth/me'),

  getHealth: () => request<HealthStatus>('/api/health'),
  getDashboard: () => request<DashboardSummary>('/api/dashboard'),

  suggestTopics: (category: VideoCategory) =>
    request<{ suggestions: TopicSuggestion[] }>('/api/topics/suggest', {
      method: 'POST',
      body: JSON.stringify({ category }),
    }),

  getTopicHistory: () => request<{ history: TopicHistoryEntry[] }>('/api/topics/history'),

  generateScript: (params: {
    topic: string;
    category: VideoCategory;
    targetDurationSeconds: number;
    voiceId: string;
    visualMode: VisualMode;
  }) =>
    request<{ video: VideoJob }>('/api/scripts/generate', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  listVideos: (filters?: { status?: string; category?: string }) => {
    const search = new URLSearchParams();
    if (filters?.status && filters.status !== 'all') search.set('status', filters.status);
    if (filters?.category && filters.category !== 'all') search.set('category', filters.category);
    const qs = search.toString();
    return request<{ videos: VideoJob[] }>(`/api/videos${qs ? `?${qs}` : ''}`);
  },

  getVideo: (id: string) => request<{ video: VideoJob }>(`/api/videos/${id}`),

  saveScript: (
    id: string,
    script: VideoScript,
    options?: { voiceId?: string; visualMode?: VisualMode }
  ) =>
    request<{ video: VideoJob }>(`/api/videos/${id}/script`, {
      method: 'PATCH',
      body: JSON.stringify({ script, ...(options ?? {}) }),
    }),

  deleteVideo: (id: string) =>
    request<{ deleted: boolean }>(`/api/videos/${id}`, {
      method: 'DELETE',
    }),

  triggerRender: (id: string, options?: { voiceId?: string; visualMode?: VisualMode }) =>
    request<{ video: VideoJob }>(`/api/videos/${id}/render`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),

  getAutomation: () =>
    request<{ config: AutomationConfig; runs: AutomationRunLog[] }>('/api/automation'),

  updateAutomation: (patch: Partial<AutomationConfig>) =>
    request<{ config: AutomationConfig; runs: AutomationRunLog[] }>('/api/automation', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  triggerAutomationManual: () =>
    request<{ video?: VideoJob; skipped?: boolean; reason?: string; runId?: string }>(
      '/api/automation/run-manual',
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    ),

  getSettings: () => request<SettingsResponse>('/api/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
