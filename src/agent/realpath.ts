import fs from "node:fs";
import path from "node:path";

const MAX_LINKS = 40;

/**
 * 存在しない末尾は、いちばん近い存在する親の realpath に付ける。切れたリンクは行き先を辿る。
 * リンクを辿った回数が上限を超えたら（ループ含む）投げる
 */
export function realpathLoose(abs: string, links = 0): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    // 存在しない、またはループ。lstat で見分ける
  }
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      if (links >= MAX_LINKS) throw new Error(`リンクが深すぎます: ${abs}`);
      const dir = realpathLoose(path.dirname(abs), links);
      return realpathLoose(path.resolve(dir, fs.readlinkSync(abs)), links + 1);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === undefined) throw error;
  }
  const parent = path.dirname(abs);
  return parent === abs
    ? abs
    : path.join(realpathLoose(parent, links), path.basename(abs));
}

/** base の中なら base からの相対（base 自身は "."）、外なら undefined */
export function relativeInside(
  base: string,
  target: string,
): string | undefined {
  const rel = path.relative(base, target);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/** 書いたとおりの位置と realpath の両方が root の中にあるときだけ true */
export function insideRoot(root: string, abs: string): boolean {
  if (relativeInside(root, abs) === undefined) return false;
  try {
    return (
      relativeInside(realpathLoose(root), realpathLoose(abs)) !== undefined
    );
  } catch {
    return false;
  }
}
