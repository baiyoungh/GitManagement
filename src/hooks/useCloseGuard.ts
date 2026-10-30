import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from '../api';
import { reportError } from '../api/queries';
import { isDirty, useFiles } from '../stores/fileStore';
import { useApp } from '../stores/appStore';
import { saveBuffer } from '../views/FilesView';
import i18n from '../i18n';

export function useCloseGuard() {
  useEffect(() => {
    let deciding = false;
    let disposed = false;
    let lastDirty: boolean | undefined;
    const syncDirty = () => {
      const dirty = Object.values(useFiles.getState().buffers).some((b) => isDirty(b) || b.saving);
      if (dirty !== lastDirty) { lastDirty = dirty; void api.app.setDirty(dirty).catch(reportError); }
    };
    syncDirty();
    const stopDirty = useFiles.subscribe(syncDirty);
    const subscription = listen('app-close-requested', async () => {
      if (deciding || disposed) return;
      deciding = true;
      try {
        const dirty = Object.entries(useFiles.getState().buffers).filter(([, b]) => isDirty(b) || b.saving);
        if (dirty.length) {
          const choice = await useApp.getState().choose({ title: i18n.t('files.unsaved'), body: i18n.t('files.exitBody'), items: dirty.map(([, b]) => b.path),
            confirmLabel: i18n.t('files.saveAll'), altLabel: i18n.t('files.discardExit'), altDanger: true });
          if (choice === 'cancel') return;
          if (choice === 'confirm') {
            for (const [key] of dirty) {
              const b = useFiles.getState().buffers[key];
              if (b?.saving || (b && isDirty(b) && !await saveBuffer(key))) return;
            }
            if (Object.values(useFiles.getState().buffers).some(isDirty)) return;
          }
        }
        await api.app.exit();
      } catch (e) { reportError(e); }
      finally { deciding = false; }
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.values(useFiles.getState().buffers).some(isDirty)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { disposed = true; stopDirty(); void subscription.then((stop) => stop()); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
}
