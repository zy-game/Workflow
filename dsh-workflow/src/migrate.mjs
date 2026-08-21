#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { runMigrationPair } from './migrate-lib.mjs'

function parseArgs(argv) {
  const result = { mode: 'migrate' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      if (result.mode !== 'migrate') throw new Error('choose only one of --dry-run or --verify')
      result.mode = 'dry-run'
      continue
    }
    if (arg === '--verify') {
      if (result.mode !== 'migrate') throw new Error('choose only one of --dry-run or --verify')
      result.mode = 'verify'
      continue
    }
    if (!arg?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`expected --name value, got ${arg ?? 'end of arguments'}`)
    result[arg.slice(2)] = argv[++i]
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
if (!options.sessions || !options.storage || !options['session-db'] || !options['state-db'] || !options.descriptors) {
  throw new Error('required: --sessions --storage --session-db --state-db --descriptors [--dry-run|--verify]')
}
const descriptors = JSON.parse(await readFile(options.descriptors, 'utf8'))
const result = await runMigrationPair({
  mode: options.mode,
  sessions: {
    sourceRoot: options.sessions,
    destination: options['session-db'],
    compression: options.compression ?? 'zstd',
    attachmentRoot: options.attachments,
  },
  domains: {
    sourceRoot: options.storage,
    destination: options['state-db'],
    descriptors,
  },
})
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
