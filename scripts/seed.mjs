// Repeatable demo seed for SwappaLook. Server-side only: uses the Supabase
// service-role key. Safe to rerun: users, businesses, categories, services and
// demo availability are upserted by stable keys; booked time is never moved.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
const TIME_ZONE = 'America/New_York'

const missing = []
if (!SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL')
if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
for (const key of ['DEMO_NAILS_PASSWORD', 'DEMO_LASHES_PASSWORD', 'DEMO_BEAUTY_PASSWORD']) {
  if (!process.env[key]) missing.push(key)
}
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  process.exit(1)
}
for (const key of ['DEMO_NAILS_PASSWORD', 'DEMO_LASHES_PASSWORD', 'DEMO_BEAUTY_PASSWORD']) {
  if (process.env[key].length < 8) {
    console.error(`${key} must be at least 8 characters.`)
    process.exit(1)
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Same convention as lib/login.ts: "<handle>@swappa" -> "<handle>@swappalook.example".
function loginToEmail(login) {
  const normalized = login.trim().toLowerCase()
  const handle = normalized.replace(/@swappa$/, '')
  if (!/^[a-z0-9._-]+$/.test(handle)) throw new Error(`Invalid login: ${login}`)
  return { login: `${handle}@swappa`, email: `${handle}@swappalook.example` }
}

const CATEGORIES = [
  { slug: 'nails', name: 'Nails', sort_order: 10, accent_color: '#B4536B', soft_color: '#F8E3E8', thumbnail_url: '/categories/nails.svg' },
  { slug: 'lashes', name: 'Lashes', sort_order: 20, accent_color: '#7A5AA6', soft_color: '#ECE5F6', thumbnail_url: '/categories/lashes.svg' },
  { slug: 'body', name: 'Body', sort_order: 30, accent_color: '#5E7A63', soft_color: '#E3ECE3', thumbnail_url: '/categories/body.svg' },
]

const BUSINESSES = [
  {
    key: 'nails',
    login: 'Nails@swappa',
    display_name: 'Nails',
    description: 'Manicura, esmaltado y diseño de uñas.',
    category: 'nails',
    passwordEnv: 'DEMO_NAILS_PASSWORD',
    hours: ['10:00', '18:00'],
  },
  {
    key: 'lashes',
    login: 'Lashes@swappa',
    display_name: 'Lashes',
    description: 'Lifting, tinte y extensiones de pestañas.',
    category: 'lashes',
    passwordEnv: 'DEMO_LASHES_PASSWORD',
    hours: ['11:00', '19:00'],
  },
  {
    key: 'beauty',
    login: 'Beauty@swappa',
    display_name: 'Beauty',
    description: 'Tratamientos corporales y masajes.',
    category: 'body',
    passwordEnv: 'DEMO_BEAUTY_PASSWORD',
    hours: ['09:00', '17:00'],
  },
]

const SERVICES = [
  ['nails', 'nails', 'manicura-clasica', 'Manicura clásica', 'Limado y cuidado de cutículas con esmaltado tradicional.', 45],
  ['nails', 'nails', 'esmaltado-semipermanente', 'Esmaltado semipermanente', 'Preparación de la uña natural y aplicación de color semipermanente.', 60],
  ['nails', 'nails', 'kapping-gel', 'Kapping gel', 'Refuerzo de la uña natural con una capa de gel y acabado a elección.', 75],
  ['nails', 'nails', 'unas-esculpidas', 'Uñas esculpidas', 'Extensión de uñas con forma y largo acordados durante el turno.', 120],
  ['nails', 'nails', 'nail-art', 'Nail art', 'Diseño decorativo en hasta cuatro uñas sobre una base ya esmaltada.', 30],
  ['lashes', 'lashes', 'lifting-de-pestanas', 'Lifting de pestañas', 'Curvado de las pestañas naturales para realzar su forma.', 60],
  ['lashes', 'lashes', 'tinte-de-pestanas', 'Tinte de pestañas', 'Aplicación de tinte para intensificar el color de las pestañas naturales.', 30],
  ['lashes', 'lashes', 'extensiones-clasicas', 'Extensiones clásicas', 'Colocación de extensiones individuales para un acabado definido.', 120],
  ['lashes', 'lashes', 'volumen-hibrido', 'Volumen híbrido', 'Combinación de extensiones individuales y abanicos para dar volumen.', 135],
  ['lashes', 'lashes', 'retiro-de-extensiones', 'Retiro de extensiones', 'Retiro de extensiones con producto específico y limpieza final.', 30],
  ['beauty', 'body', 'masaje-relajante', 'Masaje relajante', 'Masaje corporal de presión suave, con foco en espalda y hombros.', 60],
  ['beauty', 'body', 'drenaje-linfatico-manual', 'Drenaje linfático manual', 'Sesión de masaje con movimientos suaves y rítmicos.', 60],
  ['beauty', 'body', 'exfoliacion-corporal', 'Exfoliación corporal', 'Aplicación de exfoliante y retiro del producto con toallas tibias.', 45],
  ['beauty', 'body', 'masaje-descontracturante', 'Masaje descontracturante', 'Masaje de presión localizada en espalda, cuello y hombros.', 60],
  ['beauty', 'body', 'hidratacion-corporal', 'Hidratación corporal', 'Aplicación de un tratamiento hidratante mediante masaje suave.', 45],
]

const AVAILABILITY_DAYS = 10

function check(error, context) {
  if (error) throw new Error(`${context}: ${error.message}`)
}

// Offset (ms) of a time zone at a given instant, via Intl.
function tzOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type) => Number(parts.find((p) => p.type === type).value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - date.getTime()
}

function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const first = guess - tzOffsetMs(timeZone, new Date(guess))
  return new Date(guess - tzOffsetMs(timeZone, new Date(first)))
}

function localDate(timeZone, offsetDays) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [y, m, d] = today.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + offsetDays))
  return date.toISOString().slice(0, 10)
}

async function findUserByEmail(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    check(error, 'listUsers')
    const match = data.users.find((u) => u.email?.toLowerCase() === email)
    if (match) return match
    if (data.users.length < 200) return null
  }
  return null
}

async function main() {
  console.log('Seeding categories...')
  const { error: catError } = await supabase.from('categories').upsert(
    CATEGORIES.map((c) => ({ ...c, is_active: true })),
    { onConflict: 'slug' },
  )
  check(catError, 'categories')
  const { data: categories, error: catReadError } = await supabase.from('categories').select('id, slug')
  check(catReadError, 'categories read')
  const categoryId = Object.fromEntries(categories.map((c) => [c.slug, c.id]))

  const businessId = {}
  for (const biz of BUSINESSES) {
    const { login, email } = loginToEmail(biz.login)
    const password = process.env[biz.passwordEnv]
    let user = await findUserByEmail(email)
    if (!user) {
      const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true })
      check(error, `createUser ${login}`)
      user = data.user
      console.log(`Created auth user for ${login}`)
    } else {
      const { error } = await supabase.auth.admin.updateUserById(user.id, { password, email_confirm: true })
      check(error, `updateUser ${login}`)
      console.log(`Updated auth user for ${login}`)
    }

    const { data: row, error } = await supabase
      .from('businesses')
      .upsert(
        {
          user_id: user.id,
          login,
          display_name: biz.display_name,
          description: biz.description,
          time_zone: TIME_ZONE,
          primary_category_id: categoryId[biz.category],
          is_active: true,
        },
        { onConflict: 'login' },
      )
      .select('id')
      .single()
    check(error, `business ${login}`)
    businessId[biz.key] = row.id
  }

  console.log('Seeding services...')
  const { error: svcError } = await supabase.from('services').upsert(
    SERVICES.map(([biz, cat, key, title, description, duration]) => ({
      seed_key: `demo:${biz}:${key}`,
      business_id: businessId[biz],
      category_id: categoryId[cat],
      title,
      description,
      duration_minutes: duration,
      is_active: true,
    })),
    { onConflict: 'seed_key' },
  )
  check(svcError, 'services')

  console.log('Seeding availability...')
  const summary = {}
  for (const biz of BUSINESSES) {
    // Descending order lets blocks shift forward without colliding with each other.
    for (let day = AVAILABILITY_DAYS; day >= 1; day--) {
      const date = localDate(TIME_ZONE, day)
      const start = zonedToUtc(date, biz.hours[0], TIME_ZONE)
      const end = zonedToUtc(date, biz.hours[1], TIME_ZONE)
      const { data, error } = await supabase.rpc('seed_upsert_availability', {
        p_business_id: businessId[biz.key],
        p_seed_key: `demo:${biz.key}:day-${day}`,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      })
      check(error, `availability ${biz.key} day ${day}`)
      summary[data] = (summary[data] || 0) + 1
    }
  }
  console.log('Availability result:', summary)
  console.log('Done. Demo logins: Nails@swappa, Lashes@swappa, Beauty@swappa')
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
