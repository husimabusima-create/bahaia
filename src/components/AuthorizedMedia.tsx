import { useEffect, useState, type ComponentProps } from 'react';
import { fetchAuthorizedBlobUrl } from '../lib/media';

export function useAuthorizedMediaUrl(src?: string): {
  blobUrl: string | undefined;
  loading: boolean;
  error: boolean;
} {
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(Boolean(src));
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) {
      setBlobUrl(undefined);
      setLoading(false);
      setError(false);
      return;
    }

    if (!src.startsWith('/api/')) {
      setBlobUrl(src);
      setLoading(false);
      setError(false);
      return;
    }

    const controller = new AbortController();
    let createdUrl: string | undefined;
    setLoading(true);
    setError(false);

    fetchAuthorizedBlobUrl(src, controller.signal)
      .then((url) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [src]);

  return { blobUrl, loading, error };
}

interface AuthorizedVideoProps extends Omit<ComponentProps<'video'>, 'src' | 'poster'> {
  src?: string;
  poster?: string;
}

export function AuthorizedVideo({ src, poster, className, ...rest }: AuthorizedVideoProps) {
  const videoMedia = useAuthorizedMediaUrl(src);
  const posterMedia = useAuthorizedMediaUrl(poster);

  if (videoMedia.error) {
    return (
      <div
        className={`flex items-center justify-center bg-black text-xs text-zinc-400 p-4 text-center ${className || ''}`}
      >
        Unable to load video stream.
      </div>
    );
  }

  if (!videoMedia.blobUrl) {
    return (
      <div
        className={`flex items-center justify-center bg-black text-xs text-zinc-500 p-4 ${className || ''}`}
      >
        Loading video preview...
      </div>
    );
  }

  return (
    <video
      src={videoMedia.blobUrl}
      poster={posterMedia.blobUrl}
      className={className}
      {...rest}
    />
  );
}

interface AuthorizedImageProps extends Omit<ComponentProps<'img'>, 'src'> {
  src?: string;
}

export function AuthorizedImage({ src, alt, className, ...rest }: AuthorizedImageProps) {
  const { blobUrl, error } = useAuthorizedMediaUrl(src);

  if (error || !blobUrl) {
    return (
      <div
        aria-label={alt}
        className={`bg-[#0E1016] flex items-center justify-center text-[11px] text-zinc-500 ${className || ''}`}
      >
        {error ? 'Unavailable' : ''}
      </div>
    );
  }

  return <img src={blobUrl} alt={alt} className={className} {...rest} />;
}

interface AuthorizedAudioProps extends Omit<ComponentProps<'audio'>, 'src'> {
  src?: string;
}

export function AuthorizedAudio({ src, ...rest }: AuthorizedAudioProps) {
  const { blobUrl, error } = useAuthorizedMediaUrl(src);

  if (error) {
    return <p className="text-[11px] text-red-400">Audio preview unavailable.</p>;
  }

  if (!blobUrl) {
    return <p className="text-[11px] text-zinc-500">Loading audio...</p>;
  }

  return <audio src={blobUrl} {...rest} />;
}
