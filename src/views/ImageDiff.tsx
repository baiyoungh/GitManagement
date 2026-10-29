// 图片对比（D-05）：并排 / 叠加（透明度）/ 滑块
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BlobData, Rev } from '../api/types';
import { bytes } from '../lib/format';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';

export function isImagePath(p: string): boolean {
  return ext(p) in MIME;
}

const toRev = (r: Rev) => (r.kind === 'worktree' ? null : r.kind === 'index' ? '' : r.rev);

function dataUrl(path: string, b: BlobData | undefined) {
  return b?.exists && b.base64 ? `data:${MIME[ext(path)] ?? 'application/octet-stream'};base64,${b.base64}` : null;
}

type Mode = 'side' | 'overlay' | 'slider';

export function ImageDiff(props: { repoId: string; path: string; oldPath: string | null; left: Rev; right: Rev }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('side');
  const [ratio, setRatio] = useState(50);
  const [dims, setDims] = useState<{ a?: string; b?: string }>({});
  const oldPath = props.oldPath ?? props.path;
  const q = useQuery({
    queryKey: ['repo', props.repoId, 'image', props.path, props.oldPath, props.left, props.right],
    queryFn: async () => {
      const [a, b] = await Promise.all([api.compare.blob(props.repoId, toRev(props.left), oldPath), api.compare.blob(props.repoId, toRev(props.right), props.path)]);
      return { a, b };
    },
  });
  if (q.isLoading) return <p className="muted pad">{t('common.loading')}</p>;
  if (!q.data) return null;
  const a = dataUrl(oldPath, q.data.a);
  const b = dataUrl(props.path, q.data.b);
  const meta = (x: BlobData, d?: string) => (x.exists ? `${bytes(x.size)}${d ? ` · ${d}` : ''}${x.oid ? ` · ${x.oid.slice(0, 10)}` : ''}` : t('diff.absent'));
  const onLoad = (k: 'a' | 'b') => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDims((d) => ({ ...d, [k]: `${img.naturalWidth}×${img.naturalHeight}` }));
  };
  const both = !!a && !!b;

  return (
    <div className="image-diff">
      <div className="toolbar small">
        <div className="seg" role="group" aria-label={t('diff.imageMode')}>
          {(['side', 'overlay', 'slider'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} disabled={m !== 'side' && !both} onClick={() => setMode(m)}>
              {t(`diff.image_${m}`)}
            </button>
          ))}
        </div>
        {mode !== 'side' && both && (
          <input type="range" min={0} max={100} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} aria-label={t('diff.imageRatio')} />
        )}
      </div>
      {mode === 'side' || !both ? (
        <div className="image-side">
          <figure>
            <figcaption className="muted">{meta(q.data.a, dims.a)}</figcaption>
            {a ? <img src={a} alt={oldPath} onLoad={onLoad('a')} /> : <div className="image-absent muted">{t('diff.absent')}</div>}
          </figure>
          <figure>
            <figcaption className="muted">{meta(q.data.b, dims.b)}</figcaption>
            {b ? <img src={b} alt={props.path} onLoad={onLoad('b')} /> : <div className="image-absent muted">{t('diff.absent')}</div>}
          </figure>
        </div>
      ) : (
        <div className="image-stack">
          <img src={a!} alt={oldPath} />
          {mode === 'overlay' ? (
            <img src={b!} alt={props.path} className="top" style={{ opacity: ratio / 100 }} />
          ) : (
            <img src={b!} alt={props.path} className="top" style={{ clipPath: `inset(0 0 0 ${ratio}%)` }} />
          )}
          {mode === 'slider' && <div className="image-split" style={{ left: `${ratio}%` }} />}
        </div>
      )}
    </div>
  );
}
