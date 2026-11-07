'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, LockKeyhole, Sparkles } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const router = useRouter()
  async function submit(e: React.FormEvent) { e.preventDefault(); setLoading(true); setError(''); const handle = username.trim().toLowerCase().replace(/@swappa$/, ''); const { error } = await createClient().auth.signInWithPassword({ email: `${handle}@swappalook.example`, password }); if (error) { setError('Usuario o contraseña incorrectos.'); setLoading(false); return }; sessionStorage.setItem('swappalook:show-splash', '1'); router.push('/') }
  return <main className="login-page"><div className="login-card"><div className="brand-mark logo-frame"><img src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/SwappaLook%20Logo-D4cPoyBvzgsCqVZ5OkOAuNaFW4m5Qp.png" alt="SwappaLook" /></div><p className="eyebrow">RED PRIVADA DE BELLEZA</p><h1>Swappa<span>Look</span></h1><p className="login-copy">Intercambiá servicios con otros comercios de confianza.</p><form onSubmit={submit} className="login-form"><label>Usuario<input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Nails@swappa" autoComplete="username" required /></label><label>Contraseña<input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="current-password" required /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={loading}>{loading ? 'Ingresando…' : 'Ingresar'}<ArrowRight size={18}/></button></form><div className="login-note"><LockKeyhole size={15}/> Acceso exclusivo para comercios invitados</div></div></main>
}
