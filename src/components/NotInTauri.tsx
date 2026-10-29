import { useTranslation } from 'react-i18next';
import { detectSystemLanguage, setLanguage } from '../i18n';

setLanguage(detectSystemLanguage());

export function NotInTauri() {
  const { t } = useTranslation();
  return (
    <div className="not-in-tauri" role="alert">
      <h1>GitManagement</h1>
      <p>{t('notInTauri.body')}</p>
      <pre className="mono">pnpm tauri dev</pre>
      <p className="muted">{t('notInTauri.hint')}</p>
    </div>
  );
}
