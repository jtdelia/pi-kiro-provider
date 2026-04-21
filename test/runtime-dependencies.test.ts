import { builtinModules } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const EXTENSIONS_DIR = new URL("../extensions", import.meta.url);
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((module) => `node:${module}`)]);

function listTypeScriptFiles(directoryPath: string): string[] {
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageManifest;
}

function isExternalRuntimeSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !BUILTIN_MODULES.has(specifier);
}

function getPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }

  const [name] = specifier.split("/");
  return name;
}

function collectRuntimeImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const runtimeImportFromPattern = /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
  const sideEffectImportPattern = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  const runtimeExportFromPattern = /(?:^|\n)\s*export\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/g;

  for (const pattern of [runtimeImportFromPattern, sideEffectImportPattern, runtimeExportFromPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
}

function collectExternalRuntimePackages(): string[] {
  const extensionDirectoryPath = fileURLToPath(EXTENSIONS_DIR);
  const filePaths = listTypeScriptFiles(extensionDirectoryPath);
  const packages = new Set<string>();

  for (const filePath of filePaths) {
    const source = readFileSync(filePath, "utf8");
    const specifiers = collectRuntimeImportSpecifiers(source);

    for (const specifier of specifiers) {
      if (!isExternalRuntimeSpecifier(specifier)) {
        continue;
      }

      packages.add(getPackageName(specifier));
    }
  }

  return [...packages].sort();
}

describe("package runtime dependency coverage", () => {
  it("declares every external runtime import as a dependency or peer dependency", () => {
    const manifest = readPackageManifest();
    const declaredPackages = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);

    const missingPackages = collectExternalRuntimePackages().filter((packageName) => !declaredPackages.has(packageName));

    expect(missingPackages).toEqual([]);
  });

  it("keeps the Smithy event stream codec in production dependencies", () => {
    const manifest = readPackageManifest();

    expect(manifest.dependencies?.["@smithy/eventstream-codec"]).toBeTruthy();
  });
});
