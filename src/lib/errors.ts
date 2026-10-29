import i18n from '../i18n';
import type { AppError } from '../api/types';

export function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && typeof (e as AppError).code === 'string';
}

/** 把后端错误码翻译为当前语言的文案；git 原文保留在 detail 中单独展示 */
export function errorMessage(e: unknown): string {
  if (isAppError(e)) {
    const key = `errors.${e.code}`;
    if (i18n.exists(key)) return i18n.t(key, e.params ?? {}) as string;
    return e.detail || e.code;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return i18n.t('errors.unknown');
}

export function errorDetail(e: unknown): string | undefined {
  return isAppError(e) ? e.detail ?? undefined : undefined;
}
