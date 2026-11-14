import type { CredentialProfile, CloneReq } from '../api/types';

/** URL.origin normalizes hostname case and default ports without matching other hosts. */
export function credentialOrigin(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function matchingProfiles(url: string, profiles: CredentialProfile[]): CredentialProfile[] {
  const origin = credentialOrigin(url);
  let username = '';
  try { username = decodeURIComponent(new URL(url.trim()).username); } catch { /* Invalid URLs do not match. */ }
  return origin ? profiles.filter((profile) => credentialOrigin(profile.url) === origin && (!username || profile.username === username)) : [];
}

export function isHttpCredentialUrl(url: string): boolean {
  return credentialOrigin(url) !== null;
}

export function isHttps(url: string): boolean {
  return credentialOrigin(url)?.startsWith('https://') ?? false;
}

/** Only these nonsecret fields may be retained for an explicit clone retry. */
export type CloneRetry = Pick<CloneReq, 'url' | 'dest' | 'branch' | 'depth' | 'name'>;
export function cloneRetry(req: CloneReq): CloneRetry {
  let url = req.url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    url = parsed.toString();
  } catch {
    // scp-style SSH paths have no HTTPS credential payload.
  }
  return { url, dest: req.dest, branch: req.branch, depth: req.depth, name: req.name };
}
