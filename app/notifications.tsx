'use client'

import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'

const labels: Record<string, string> = {
  created: 'Recibiste una propuesta',
  countered: 'Recibiste una contrapropuesta',
  archived: 'Archivaron una propuesta',
  accepted: 'Aceptaron el intercambio',
  rejected: 'Rechazaron el intercambio',
  message: 'Recibiste un mensaje',
}

type Notice = {
  id: string
  exchange_id: string
  event_type: string
  read_at: string | null
}

export default function Notifications({client, businessId, onOpen}: {
  client: ReturnType<typeof createClient>
  businessId: string
  onOpen: (exchangeId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notice[]>([])
  const [unread, setUnread] = useState(0)
  const [failed, setFailed] = useState(false)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    let active = true
    let pending = false
    async function refresh() {
      if (pending || document.hidden) return
      pending = true
      try {
        const scoped = () => client.from('notifications')
        const [history, count] = await Promise.all([
          scoped().select('id,exchange_id,event_type,read_at').eq('recipient_business_id', businessId)
            .order('created_at', {ascending: false}).limit(30),
          scoped().select('id', {count: 'exact', head: true}).eq('recipient_business_id', businessId).is('read_at', null),
        ])
        if (!active) return
        if (history.error || count.error) {setFailed(true); return}
        setItems(history.data)
        setUnread(count.count ?? 0)
        setFailed(false)
      } catch {
        if (active) setFailed(true)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 12000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [client, businessId, open, opening])

  async function openExchange(exchangeId: string) {
    setOpening(true)
    try {
      await onOpen(exchangeId)
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  return <div className="notification-anchor" onKeyDown={event => {
    if (event.key === 'Escape') setOpen(false)
  }}>
    <button type="button" className="icon-button notification-bell" aria-label={`Notificaciones, ${unread} sin leer`} aria-expanded={open} aria-controls="notifications-panel" onClick={() => setOpen(!open)}>
      <Bell size={20}/>{unread > 0 && <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <section id="notifications-panel" className="notifications-panel" aria-label="Notificaciones">
      <h2>Notificaciones</h2>
      {failed && <p role="alert">No pudimos actualizar las notificaciones. Volvé a intentar.</p>}
      {!failed && !items.length && <p>Todavía no tenés notificaciones.</p>}
      {items.map(item => <button type="button" key={item.id} disabled={opening} onClick={() => void openExchange(item.exchange_id)}>
        <span>{labels[item.event_type] || 'Novedad en un intercambio'}</span>
        {!item.read_at && <small>Sin leer</small>}
      </button>)}
    </section>}
  </div>
}
