import { auth } from './firebase';

async function fetchWithAuth(url: string, signal?: AbortSignal): Promise<Response> {
  const getToken = async (forceRefresh: boolean): Promise<string | null> => {
    if (!auth.currentUser) return null;
    try {
      return await auth.currentUser.getIdToken(forceRefresh);
    } catch {
      return null;
    }
  };

  const token = await getToken(false);
  let res = await fetch(url, {
    credentials: 'include',
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (res.status === 401 && auth.currentUser) {
    const freshToken = await getToken(true);
    if (freshToken) {
      res = await fetch(url, {
        credentials: 'include',
        signal,
        headers: { Authorization: `Bearer ${freshToken}` },
      });
    }
  }

  return res;
}

export async function fetchAuthorizedBlobUrl(
  url: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetchWithAuth(url, signal);
  if (!res.ok) {
    throw new Error(`Media request failed (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

function sanitizeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'shortforge-video'}.mp4`;
}

export async function downloadAuthorizedMp4(
  url: string,
  suggestedTitle: string
): Promise<void> {
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      if (json?.error?.message) message = json.error.message;
    } catch {
      // Ignore non-JSON error
    }
    throw new Error(message);
  }

  const disposition = res.headers.get('content-disposition') || '';
  const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = filenameMatch?.[1] || sanitizeFilename(suggestedTitle);

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
  }
}
