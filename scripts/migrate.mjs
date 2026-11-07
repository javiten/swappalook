// Applies SQL files in supabase/migrations in order, once each.
// Requires POSTGRES_URL_NON_POOLING (or DATABASE_URL). Server-side only.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL
if (!connectionString) {
  console.error('Missing POSTGRES_URL_NON_POOLING (or DATABASE_URL).')
  process.exit(1)
}

const url = new URL(connectionString)
url.searchParams.delete('sslmode')
url.searchParams.delete('supa')
const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname)
const client = new pg.Client({
  connectionString: url.toString(),
  ssl: isLocal ? false : { rejectUnauthorized: false },
})

const dir = path.join(process.cwd(), 'supabase', 'migrations')

async function main() {
  await client.connect()
  await client.query(`
    create schema if not exists swappalook_meta;
    revoke all on schema swappalook_meta from public;
    create table if not exists swappalook_meta.applied_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `)
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const { rows } = await client.query('select name from swappalook_meta.applied_migrations')
  const applied = new Set(rows.map((r) => r.name))

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip    ${file}`)
      continue
    }
    const sql = await readFile(path.join(dir, file), 'utf8')
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into swappalook_meta.applied_migrations (name) values ($1)', [file])
      await client.query('commit')
      console.log(`applied ${file}`)
    } catch (error) {
      await client.query('rollback')
      console.error(`failed  ${file}: ${error.message}`)
      process.exitCode = 1
      return
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => client.end())
