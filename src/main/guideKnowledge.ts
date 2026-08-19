/**
 * Where the guide knowledge md lives.
 *
 * One function — development and the installed build resolve differently, and
 * a harness is a separate process that cannot read inside app.asar. Packaged
 * copies live in extraResources (`guide/knowledge`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function resolveGuideKnowledgeDir(input: {
  packaged: boolean;
  resourcesPath?: string;
  appPath: string;
}): string {
  if (input.packaged) {
    const packaged = path.join(input.resourcesPath || "", "guide", "knowledge");
    if (!input.resourcesPath) {
      throw new Error("설치본에서 가이드 지식 폴더를 찾으려면 resourcesPath가 필요합니다.");
    }
    return packaged;
  }
  return path.join(input.appPath, "guide", "knowledge");
}

export function requireGuideKnowledgeDir(input: {
  packaged: boolean;
  resourcesPath?: string;
  appPath: string;
}): string {
  const dir = resolveGuideKnowledgeDir(input);
  if (!fs.existsSync(path.join(dir, "index.md"))) {
    throw new Error(`가이드 지식 폴더에 index.md가 없습니다: ${dir}`);
  }
  return dir;
}
