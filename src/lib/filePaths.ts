// Match a tree entry and descendants without confusing sibling prefixes.
export const containsPath = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);
export const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;

// Single portable filename; operations stay inside the selected directory.
export function validFileName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && name.toLowerCase() !== '.git'
    && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
}
