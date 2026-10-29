// TanStack Query 封装：后端数据缓存与失效刷新
import { QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { api } from './index';
import { useApp } from '../stores/appStore';
import { errorDetail, errorMessage } from '../lib/errors';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true, staleTime: 2000 },
  },
});

export const keys = {
  appInfo: ['appInfo'] as const,
  repos: ['repos'] as const,
  summary: (id: string) => ['repo', id, 'summary'] as const,
  status: (id: string) => ['repo', id, 'status'] as const,
  checked: (id: string) => ['repo', id, 'checked'] as const,
  branches: (id: string) => ['repo', id, 'branches'] as const,
  remotes: (id: string) => ['repo', id, 'remotes'] as const,
  messages: (id: string) => ['repo', id, 'messages'] as const,
  repo: (id: string) => ['repo', id] as const,
  groups: ['groups'] as const,
  stashes: (id: string) => ['repo', id, 'stashes'] as const,
  changelists: (id: string) => ['repo', id, 'changelists'] as const,
  tags: (id: string) => ['repo', id, 'tags'] as const,
};

/** 仓库内容变化（文件监听、任务完成、写操作后）→ 让该仓库的所有查询失效 */
export function invalidateRepo(repoId: string) {
  void queryClient.invalidateQueries({ queryKey: keys.repo(repoId) });
}

export const useAppInfo = () => useQuery({ queryKey: keys.appInfo, queryFn: api.app.info, staleTime: Infinity });
export const useRepos = () => useQuery({ queryKey: keys.repos, queryFn: api.repo.list });

export const useSummary = (repoId: string, enabled = true) =>
  useQuery({ queryKey: keys.summary(repoId), queryFn: () => api.repo.summary(repoId), enabled });

export const useStatus = (repoId: string | null) =>
  useQuery({ queryKey: keys.status(repoId ?? ''), queryFn: () => api.status.get(repoId!), enabled: !!repoId });

export const useChecked = (repoId: string | null) =>
  useQuery({ queryKey: keys.checked(repoId ?? ''), queryFn: () => api.checked.get(repoId!), enabled: !!repoId, staleTime: Infinity });

export const useBranches = (repoId: string | null) =>
  useQuery({ queryKey: keys.branches(repoId ?? ''), queryFn: () => api.branch.list(repoId!), enabled: !!repoId });

export const useRemotes = (repoId: string | null) =>
  useQuery({ queryKey: keys.remotes(repoId ?? ''), queryFn: () => api.remote.list(repoId!), enabled: !!repoId });

export const useMessages = (repoId: string | null) =>
  useQuery({ queryKey: keys.messages(repoId ?? ''), queryFn: () => api.commit.messages(repoId!), enabled: !!repoId });

export const useGroups = () => useQuery({ queryKey: keys.groups, queryFn: api.group.list });

export const useStashes = (repoId: string | null) =>
  useQuery({ queryKey: keys.stashes(repoId ?? ''), queryFn: () => api.stash.list(repoId!), enabled: !!repoId });

export const useChangelists = (repoId: string | null) =>
  useQuery({ queryKey: keys.changelists(repoId ?? ''), queryFn: () => api.changelist.list(repoId!), enabled: !!repoId });

export const useTags = (repoId: string | null) =>
  useQuery({ queryKey: keys.tags(repoId ?? ''), queryFn: () => api.tag.list(repoId!), enabled: !!repoId });

/** 统一的错误提示 */
export function reportError(e: unknown) {
  useApp.getState().toast('error', errorMessage(e), errorDetail(e));
}

/** 仓库写操作：完成后刷新该仓库，失败时弹出错误 */
export function useRepoMutation<TVars, TRes>(repoId: string | null, fn: (vars: TVars) => Promise<TRes>) {
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      if (repoId) invalidateRepo(repoId);
    },
    onError: reportError,
  });
}
