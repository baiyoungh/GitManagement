import { useTranslation } from 'react-i18next';
import { useApp } from '../stores/appStore';
import { Modal } from '../components/ui';
import { ComparePanel } from '../views/ComparePanel';

export function CompareDialog({ repoId, left, right }: { repoId: string; left: string; right: string | null }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const shortL = /^[0-9a-f]{40}$/.test(left) ? left.slice(0, 10) : left;
  return (
    <Modal title={t('compare.title', { left: shortL, right: right ?? t('diff.worktree') })} onClose={close} width={1100}>
      <div className="compare-dialog">
        <ComparePanel repoId={repoId} left={left} right={right} />
      </div>
    </Modal>
  );
}
