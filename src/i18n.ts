// 国际化（T-08）：默认中文，可切换英文，切换即时生效无需重启。
// 首次启动（未保存语言设置）时按系统语言选择。
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export function detectSystemLanguage(): LanguageCode {
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : nav.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

export function setLanguage(code: string) {
  const lang = LANGUAGES.some((l) => l.code === code) ? code : 'zh-CN';
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
}

export default i18n;
