import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = resolve(__dirname, "../source");

interface SourceDefinition {
  name: string;
  url: string;
  subdir: string;
}

const SOURCES: SourceDefinition[] = [
  {
    name: "counties",
    url: "https://data.humdata.org/dataset/4da920dc-c1dc-4889-b06c-66ecb65e2b94/resource/0d7c191e-35b4-42cd-9df6-bb3b9add3467/download/counties.zip",
    subdir: "counties",
  },
  {
    name: "constituencies",
    url: "https://data.humdata.org/dataset/4da920dc-c1dc-4889-b06c-66ecb65e2b94/resource/8c78dafe-f9f4-4dd3-b6be-a4e57ea7ac22/download/constituencies.zip",
    subdir: "constituencies",
  },
  {
    name: "wards",
    url: "https://data.humdata.org/dataset/4da920dc-c1dc-4889-b06c-66ecb65e2b94/resource/e77739a3-c921-4690-8d3b-62249e26324e/download/ward.results.zip",
    subdir: "wards",
  },
];

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`Downloading: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed (${response.status}): ${response.statusText}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, buffer);
  console.log(
    `  Saved: ${dest} (${(buffer.byteLength / 1024).toFixed(0)} KB)`,
  );
}

function extractZip(zipPath: string, targetDir: string): void {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true });
  }
  mkdirSync(targetDir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: "inherit" });
}

async function main(): Promise<void> {
  mkdirSync(SOURCE_DIR, { recursive: true });

  for (const source of SOURCES) {
    const zipPath = resolve(SOURCE_DIR, `${source.name}.zip`);
    const extractDir = resolve(SOURCE_DIR, source.subdir);

    await downloadFile(source.url, zipPath);
    console.log(`  Extracting ${source.name}...`);
    extractZip(zipPath, extractDir);
    rmSync(zipPath);
    console.log(`  ${source.name} ready.\n`);
  }

  console.log("All source data downloaded and extracted.");
}

main();
