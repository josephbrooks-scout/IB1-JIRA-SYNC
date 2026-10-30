import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import type { XmlNode } from '../src/jira/ib1JiraPlan.ts'

export async function loadIb1Xml(filePath: string): Promise<{ fileName: string; document: XmlNode }> {
  const xml = await readFile(filePath, 'utf8')

  if (!/<IB-1[\s>]/.test(xml)) {
    throw new Error(`${filePath} is not IB1 XML (no <IB-1> root). HTML exports cannot be used for Jira tickets.`)
  }

  return {
    fileName: basename(filePath),
    document: new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlNode,
  }
}

// Expands folders to the .xml files inside them (recursively) so a whole inbox folder can be passed at once.
export async function expandInputPaths(paths: string[]): Promise<Array<{ path: string; fromFolder: boolean }>> {
  const files: Array<{ path: string; fromFolder: boolean }> = []

  for (const path of paths) {
    if ((await stat(path)).isDirectory()) {
      const entries = await readdir(path, { recursive: true })

      files.push(
        ...entries
          .filter((entry) => extname(entry).toLowerCase() === '.xml')
          .sort()
          .map((entry) => ({ path: join(path, entry), fromFolder: true })),
      )
    } else {
      files.push({ path, fromFolder: false })
    }
  }

  return files
}

export function isNotIb1Error(error: unknown): boolean {
  return error instanceof Error && error.message.includes('is not IB1 XML')
}
