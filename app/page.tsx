'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, Check, ChevronRight, Clock3, Compass, Edit3, LogOut, MessageCircle, Plus, Search, Sparkles, Store, Trash2, X } from 'lucide-react'
import Notifications from './notifications'
import { dateTimeInZone } from '@/lib/scheduling'
import { createClient } from '@/lib/supabase/client'

type Category = { id:string; name:string; slug:string; accent_color?:string; soft_color?:string }
type Service = { id:string; title:string; description:string; duration_minutes:number; business_id:string; category_id:string; is_active:boolean; businesses?:{display_name:string}; categories?:Category }
type Exchange = { id:string; status:string; current_version:number; requester_business_id:string; recipient_business_id:string; awaiting_business_id:string|null; last_activity_at:string; requester?:{display_name:string}; recipient?:{display_name:string}; current_proposal?:any }
const logo='https://hebbkx1anhila5yf.public.blob.vercel-storage.com/SwappaLook%20Logo-D4cPoyBvzgsCqVZ5OkOAuNaFW4m5Qp.png'

function Splash({ready}:{ready:boolean}){
 const [visible,setVisible]=useState(false)
 useEffect(()=>{
  if(sessionStorage.getItem('swappalook:show-splash')!=='1')return
  sessionStorage.removeItem('swappalook:show-splash')
  setVisible(true)
 },[])
 useEffect(()=>{
  if(!visible||!ready)return
  const timer=window.setTimeout(()=>setVisible(false),240)
  return()=>window.clearTimeout(timer)
 },[visible,ready])
 if(!visible)return null
 return <div className={`splash-overlay ${ready?'is-ready':''}`} aria-label="SwappaLook">
  <div className="splash-halo"/><img src="/swappalook-mark.png" alt=""/><span>SwappaLook</span>
 </div>
}
const nav=[{id:'explore',label:'Explorar',icon:Compass},{id:'exchanges',label:'Intercambios',icon:MessageCircle},{id:'calendar',label:'Agenda',icon:CalendarDays},{id:'business',label:'Mi comercio',icon:Store}]
const statusLabel:Record<string,string>={pending:'Pendiente',countered:'Contrapropuesta',accepted:'Aceptado',rejected:'Rechazado'}
function Thumb({category}:{category?:Category}){return <div className="service-thumb" style={{background:category?.soft_color||'#eee8e7',color:category?.accent_color||'#69304f'}}><Sparkles size={22}/></div>}
function dateLabel(v:string,tz='America/New_York'){return new Intl.DateTimeFormat('es-AR',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:tz}).format(new Date(v))}

export default function Home(){
 const supabase=useMemo(()=>createClient(),[]); const [tab,setTab]=useState('explore'); const [services,setServices]=useState<Service[]>([]); const [mine,setMine]=useState<Service[]>([]); const [categories,setCategories]=useState<Category[]>([]); const [business,setBusiness]=useState<any>(null); const [exchanges,setExchanges]=useState<Exchange[]>([]); const [query,setQuery]=useState(''); const [filter,setFilter]=useState('all'); const [loading,setLoading]=useState(true); const [loadError,setLoadError]=useState(''); const [editing,setEditing]=useState<Service|null>(null); const [showService,setShowService]=useState(false); const [selected,setSelected]=useState<Service|null>(null); const [notice,setNotice]=useState(''); const [exchangeTab,setExchangeTab]=useState<'received'|'sent'>('received')
 const [focusedExchange,setFocusedExchange]=useState<string|null>(null)
 const [exchangeError,setExchangeError]=useState('')
 async function openExchange(id:string){
  const {error}=await supabase.rpc('mark_exchange_read',{p_exchange_id:id})
  await load()
  setFocusedExchange(id)
  setTab('exchanges')
  if(error)setExchangeError('No pudimos marcar las notificaciones como leídas.')
 }
 async function load(){
  try{
   const {data:{user}}=await supabase.auth.getUser();if(!user){location.href='/login';return}
   const {data:businessId,error:idError}=await supabase.rpc('current_business_id')
   const meRes:any=businessId?await supabase.from('businesses').select('id,display_name,description,time_zone,primary_category_id').eq('id',businessId).maybeSingle():{data:null,error:idError}
   const [catsRes,allRes,exRes]=await Promise.all([supabase.from('categories').select('id,name,slug,accent_color,soft_color').eq('is_active',true).order('sort_order'),supabase.from('services').select('id,title,description,duration_minutes,business_id,category_id,is_active,businesses!inner(display_name,is_active),categories!inner(name,slug,accent_color,soft_color)').eq('is_active',true).eq('businesses.is_active',true),supabase.from('exchanges').select('id,status,current_version,requester_business_id,recipient_business_id,awaiting_business_id,last_activity_at,requester:businesses!exchanges_requester_business_id_fkey(display_name),recipient:businesses!exchanges_recipient_business_id_fkey(display_name),current_proposal:exchange_proposals!exchanges_current_proposal_fk(requested_snapshot,offered_snapshot,requested_starts_at,offered_starts_at)').order('last_activity_at',{ascending:false})])
   const me=meRes.data
   const problems:string[]=[]
   if(meRes.error||idError){console.error('[v0] business lookup failed',meRes.error||idError);problems.push('No pudimos cargar los datos de tu comercio. Recargá la página o volvé a iniciar sesión.')}
   else if(!me)problems.push('Tu usuario no tiene un comercio activo asociado. Contactá al administrador para configurarlo.')
   else if(!me.primary_category_id)problems.push('Tu comercio no tiene una categoría asignada. Hasta que se configure no podés publicar servicios.')
   if(catsRes.error||allRes.error){console.error('[v0] catalog lookup failed',catsRes.error||allRes.error);problems.push('No pudimos cargar el catálogo de servicios.')}
   setExchangeError(exRes.error?'No pudimos cargar tus intercambios.':'')
   if(exRes.error){console.error('[v0] exchanges lookup failed',exRes.error);problems.push('No pudimos cargar tus intercambios.')}
   setLoadError(problems.join(' '))
   setBusiness(me||null);setCategories((catsRes.data as any)||[])
   const list:Service[]=(allRes.data as any)||[]
   setServices(list);setMine(list.filter(s=>s.business_id===me?.id));setExchanges((exRes.data as any)||[])
  }catch(err){console.error('[v0] load failed',err);setLoadError('Ocurrió un error inesperado al cargar la aplicación.')}
  finally{setLoading(false)}
 }
 useEffect(()=>{load()},[]); const visible=services.filter(s=>(filter==='all'||s.category_id===filter)&&`${s.title} ${s.businesses?.display_name}`.toLowerCase().includes(query.toLowerCase())); async function logout(){await supabase.auth.signOut();location.href='/login'} function flash(v:string){setNotice(v);setTimeout(()=>setNotice(''),3000)}
 if(loading)return <><Splash ready={false}/><main className="catalog-placeholder" aria-busy="true"><i/><i/><i/></main></>
 return <><Splash ready={true}/><div className="app-shell"><aside className="sidebar"><div className="side-brand"><img src={logo} alt="SwappaLook"/><span>Swappa<span>Look</span></span></div><div className="side-nav">{nav.map(n=><button key={n.id} className={tab===n.id?'active':''} onClick={()=>{setTab(n.id);if(n.id==='exchanges')void load()}}><n.icon size={18}/><span>{n.label}</span>{n.id==='exchanges'&&exchanges.some(e=>e.awaiting_business_id===business?.id)&&<b>{exchanges.filter(e=>e.awaiting_business_id===business?.id).length}</b>}</button>)}</div><div className="sidebar-foot"><div className="profile-mini"><div className="avatar">{business?.display_name?.[0]||'S'}</div><div><strong>{business?.display_name}</strong><small>Comercio activo</small></div></div><button className="logout" onClick={logout}><LogOut size={16}/> Cerrar sesión</button></div></aside><main className="main-area"><header className="topbar"><div><p className="eyebrow">RED DE CONFIANZA</p><h1>{tab==='explore'?'Explorar servicios':nav.find(n=>n.id===tab)?.label}</h1></div>{business?.id&&<Notifications key={business.id} client={supabase} businessId={business.id} onOpen={openExchange}/>}</header><div className="content">{notice&&<div className="toast"><Check size={16}/> {notice}</div>}{tab==='explore'&&<Explore businessId={business?.id} visible={visible} categories={categories} filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} onSelect={setSelected}/>} {tab==='exchanges'&&<Exchanges client={supabase} error={exchangeError} focused={focusedExchange} setFocused={setFocusedExchange} onOpen={openExchange} onRetry={load} exchanges={exchanges} business={business} exchangeTab={exchangeTab} setExchangeTab={setExchangeTab}/>} {tab==='calendar'&&<Agenda exchanges={exchanges} business={business}/>} {tab==='business'&&<Business business={business} loadError={loadError} services={mine} onNew={()=>{setEditing(null);setShowService(true)}} onEdit={(s:Service)=>{setEditing(s);setShowService(true)}} onRefresh={load}/>}</div></main><nav className="bottom-nav">{nav.map(n=><button key={n.id} className={tab===n.id?'active':''} onClick={()=>{setTab(n.id);if(n.id==='exchanges')void load()}}><n.icon size={19}/><span>{n.label}</span></button>)}</nav></div>{showService&&business?.primary_category_id&&<ServiceModal service={editing} business={business} supabase={supabase} onClose={()=>setShowService(false)} onSaved={()=>{setShowService(false);load();flash(editing?'Servicio actualizado':'Servicio guardado')}}/>}{selected&&<ExchangeModal service={selected} owned={selected.business_id===business?.id} onManage={()=>{setSelected(null);setTab('business')}} timeZone={business?.time_zone||'America/New_York'} mine={mine} supabase={supabase} onClose={()=>setSelected(null)} onSaved={()=>{setSelected(null);setFocusedExchange(null);load();setExchangeTab('sent');setTab('exchanges');flash('Propuesta enviada')}}/>}</>
}
function Explore({businessId,visible,categories,filter,setFilter,query,setQuery,onSelect}:any){return <><section className="hero"><div><p className="eyebrow">INTERCAMBIÁ SIN DINERO</p><h2>Encontrá tu próximo intercambio.</h2><p>Descubrí los servicios publicados por la red.</p></div><div className="hero-spark"><Sparkles size={28}/></div></section><div className="search-row"><div className="search-box"><Search size={18}/><input aria-label="Buscar servicio o comercio" placeholder="Buscar servicio o comercio" value={query} onChange={e=>setQuery(e.target.value)}/></div></div><div className="filter-row"><button className={filter==='all'?'filter active':'filter'} onClick={()=>setFilter('all')}>Todos</button>{categories.map((c:Category)=><button key={c.id} className={filter===c.id?'filter active':'filter'} onClick={()=>setFilter(c.id)}>{c.name}</button>)}</div><div className="section-heading"><div><p className="eyebrow">CATÁLOGO INTERNO</p><h2>Servicios para intercambiar</h2></div><span className="muted">{visible.length} disponibles</span></div><div className="service-grid">{visible.map((s:Service)=><button className="service-card" key={s.id} onClick={()=>onSelect(s)}><Thumb category={s.categories}/><div className="service-info"><div className="card-top"><span className="category-label">{s.categories?.name}</span><span className="card-duration"><Clock3 size={14} aria-hidden="true"/>{s.duration_minutes} min</span></div><h3>{s.title}</h3><p>{s.businesses?.display_name}{s.business_id===businessId&&<small className="own-badge">Tu comercio</small>}</p><span className="card-link">Ver servicio <ChevronRight size={15}/></span></div></button>)}{!visible.length&&<div className="empty-card"><Sparkles size={24}/><h3>No encontramos servicios</h3><p>Probá con otra búsqueda o filtro.</p></div>}</div></>}
function Business({business,loadError,services,onNew,onEdit,onRefresh}:any){const ready=!!business?.primary_category_id;return <div className="business-page">{loadError&&<div className="form-error load-error" role="alert">{loadError}</div>}<div className="business-header"><div className="avatar large">{business?.display_name?.[0]||'S'}</div><div><p className="eyebrow">MI COMERCIO</p><h2>{business?.display_name}</h2><p>{business?.description}</p></div></div><div className="glance-card"><div><p className="eyebrow">A PRIMERA VISTA</p><h3>{loadError&&!services.length?'Catálogo no disponible':`${services.length} servicios publicados`}</h3><p>Tu catálogo está disponible para toda la red.</p></div><div className="glance-icon"><Store size={21}/></div></div><div className="section-heading"><div><p className="eyebrow">TU CATÁLOGO</p><h2>Servicios publicados</h2></div><button className="primary-button compact" onClick={onNew} disabled={!ready} title={ready?undefined:'Tu comercio no está configurado'}><Plus size={16}/> Nuevo servicio</button></div><div className="owned-services">{services.map((s:Service)=><div className="owned-service" key={s.id}><Thumb category={s.categories}/><div className="owned-copy"><strong>{s.title}</strong><p>{s.duration_minutes} min · {s.categories?.name}</p></div><button className="icon-button small" aria-label={`Editar ${s.title}`} onClick={()=>onEdit(s)}><Edit3 size={16}/></button><button className="icon-button small danger" aria-label={`Eliminar ${s.title}`} onClick={async()=>{if(confirm('¿Desactivar este servicio?')){const {error}=await createClient().from('services').update({is_active:false}).eq('id',s.id);if(!error)onRefresh()}}}><Trash2 size={16}/></button></div>)}{!services.length&&!loadError&&<div className="empty-card"><Store size={24}/><h3>Tu catálogo está vacío</h3><p>Publicá tu primer servicio para empezar.</p></div>}</div></div>}
function serviceErrorMessage(error:any){
 const text=`${error?.message||''} ${error?.details||''}`
 if(text.includes('CATEGORY_MISMATCH'))return 'Tu comercio solo puede publicar servicios de su propia categoría.'
 if(text.includes('BUSINESS_CATEGORY_MISSING'))return 'Tu comercio no tiene una categoría asignada. Contactá al administrador.'
 if(text.includes('CATEGORY_INACTIVE'))return 'La categoría de tu comercio está inactiva.'
 if(error?.code==='42501'||error?.code==='PGRST301'||error?.status===401||error?.status===403)return 'No tenés permiso para guardar este servicio. Volvé a iniciar sesión e intentá de nuevo.'
 return 'No pudimos guardar el servicio. Revisá tu conexión e intentá de nuevo.'
}
function ServiceModal({service,business,supabase,onClose,onSaved}:any){
 const [form,setForm]=useState({title:service?.title||'',description:service?.description||'',duration_minutes:service?.duration_minutes||60})
 const [saving,setSaving]=useState(false);const [error,setError]=useState('');const inflight=useRef(false)
 useEffect(()=>{const previous=document.body.style.overflow;document.body.style.overflow='hidden';const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!inflight.current)onClose()};window.addEventListener('keydown',onKey);return()=>{document.body.style.overflow=previous;window.removeEventListener('keydown',onKey)}},[onClose])
 async function save(e:React.FormEvent){
  e.preventDefault();if(inflight.current)return
  setError('')
  if(!business?.id||!business?.primary_category_id){setError('Tu comercio no está configurado correctamente. Contactá al administrador.');return}
  const title=form.title.trim();const description=form.description.trim()
  if(title.length<2||description.length<2){setError('Completá el nombre y la descripción.');return}
  inflight.current=true;setSaving(true)
  try{
   const payload={title,description,duration_minutes:Number(form.duration_minutes)}
   const result=service
    ?await supabase.from('services').update(payload).eq('id',service.id).eq('business_id',business.id).select('id')
    :await supabase.from('services').insert({...payload,is_active:true}).select('id')
   if(result.error){console.error('[v0] service save failed',result.error);setError(serviceErrorMessage(result.error));return}
   if(!result.data||result.data.length!==1){setError('El servicio no se guardó. Intentá de nuevo.');return}
   onSaved()
  }catch(err){console.error('[v0] service save exception',err);setError(serviceErrorMessage(err))}
  finally{inflight.current=false;setSaving(false)}
 }
 return createPortal(<div className="service-dialog-layer" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget&&!inflight.current)onClose()}}><form className="service-dialog" role="dialog" aria-modal="true" aria-labelledby="service-dialog-title" onSubmit={save}><div className="service-dialog-head"><div><p className="eyebrow">MI CATÁLOGO</p><h2 id="service-dialog-title">{service?'Editar servicio':'Nuevo servicio'}</h2><p className="modal-note">{business?.display_name} · categoría asignada automáticamente</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar" disabled={saving}><X/></button></div><div className="service-dialog-body"><label>Nombre del servicio<input autoFocus required maxLength={80} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label><label>Descripción<textarea required maxLength={600} rows={4} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></label><label>Duración<select value={form.duration_minutes} onChange={e=>setForm({...form,duration_minutes:Number(e.target.value)})}>{[30,45,60,75,90,120,135,180].map(n=><option key={n} value={n}>{n} minutos</option>)}</select></label>{error&&<p className="form-error" role="alert">{error}</p>}</div><div className="service-dialog-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving?'Guardando…':'Guardar servicio'}</button></div></form></div>,document.body)
}
function ExchangeModal({service,owned,onManage,timeZone,mine,supabase,onClose,onSaved}:{
 service:Service; owned:boolean; onManage:()=>void; timeZone:string; mine:Service[];
 supabase:ReturnType<typeof createClient>; onClose:()=>void; onSaved:()=>void
}){
 const [step,setStep]=useState(0)
 const [offered,setOffered]=useState<Service|null>(null)
 const [received,setReceived]=useState('')
 const [given,setGiven]=useState('')
 const [note,setNote]=useState('')
 const [error,setError]=useState('')
 const [saving,setSaving]=useState(false)
 function validate(){
  const requested=dateTimeInZone(received,timeZone)
  const offeredStart=dateTimeInZone(given,timeZone)
  if(!offered||requested===null||offeredStart===null){setError('Elegí dos fechas y horas válidas.');return null}
  if(requested<=Date.now()||offeredStart<=Date.now()){
   setError(requested<=Date.now()?'El turno que recibís ya pasó.':'El turno que ofrecés ya pasó.')
   return null
  }
  if(requested < offeredStart+offered.duration_minutes*60000 && offeredStart < requested+service.duration_minutes*60000){
   setError('Los dos turnos se superponen.');return null
  }
  return {requested,offeredStart}
 }
 async function submit(e:React.FormEvent){
  e.preventDefault()
  if(saving||owned||!offered)return
  setError('')
  if(step===0){setStep(1);return}
  const times=validate()
  if(!times){setStep(1);return}
  if(step===1){setStep(2);return}
  setSaving(true)
  try{
   const {error:rpc}=await supabase.rpc('create_exchange',{
    p_requested_service_id:service.id,p_offered_service_id:offered.id,
    p_requested_start:new Date(times.requested).toISOString(),
    p_offered_start:new Date(times.offeredStart).toISOString(),p_note:note.trim()||null,
   })
   if(rpc){
    if(rpc.message==='SLOT_UNAVAILABLE'){setStep(1);setError('Uno de los turnos coincide con una reserva o ya pasó. Elegí otro horario.')}
    else if(rpc.message==='SERVICE_UNAVAILABLE'){setStep(0);setError('Uno de los servicios ya no está publicado.')}
    else if(rpc.message==='SLOTS_OVERLAP'){setStep(1);setError('Los dos turnos se superponen.')}
    else setError('No pudimos enviar la propuesta. Intentá de nuevo.')
    return
   }
   onSaved()
  }catch{setError('No pudimos enviar la propuesta. Revisá tu conexión e intentá de nuevo.')}
  finally{setSaving(false)}
 }
 return createPortal(<div className="service-dialog-layer">
  <form className="service-dialog proposal-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-title" onSubmit={submit}>
   <header className="service-dialog-head"><div>
    <p className="eyebrow">{owned?'TU COMERCIO':`${step+1} / 3 · PROPONER INTERCAMBIO`}</p>
    <h2 id="proposal-title">{owned?service.title:['Elegí los servicios','Elegí los turnos','Revisá tu propuesta'][step]}</h2>
   </div><button type="button" className="icon-button" aria-label="Cerrar" disabled={saving} onClick={onClose}><X/></button></header>
   {owned?<><p>{service.description}</p><p>{service.duration_minutes} min</p><button type="button" className="primary-button" onClick={onManage}>Administrar en Mi comercio</button></>:<>
    <div className="proposal-scroll">
     {step===0&&<>
      <div className="proposal-ticket"><small>RECIBÍS</small><strong>{service.title}</strong><span>{service.businesses?.display_name} · {service.duration_minutes} min</span><p>{service.description}</p></div>
      <p className="eyebrow">OFRECÉS</p>
      {mine.map(s=><button type="button" key={s.id} className="proposal-option" aria-pressed={offered?.id===s.id} onClick={()=>{setOffered(s);setError('')}}><span>{s.title} · {s.duration_minutes} min</span>{offered?.id===s.id&&<Check size={18}/>}</button>)}
      {!mine.length&&<button type="button" className="secondary-button" onClick={onManage}>Publicar un servicio en Mi comercio</button>}
     </>}
     {step===1&&offered&&<>
      <AppointmentPicker label="Turno que recibís" service={service} value={received} timeZone={timeZone} onChange={setReceived}/>
      <AppointmentPicker label="Turno que ofrecés" service={offered} value={given} timeZone={timeZone} onChange={setGiven}/>
     </>}
     {step===2&&offered&&<>
      {[[service,received,'RECIBÍS'],[offered,given,'OFRECÉS']].map(([item,value,label])=>{
       const selected=item as Service
       return <div className="proposal-ticket" key={selected.id}><small>{label as string}</small><strong>{selected.title}</strong><span>{selected.businesses?.display_name} · {dateLabel(new Date(dateTimeInZone(value as string,timeZone)!).toISOString(),timeZone)} · {selected.duration_minutes} min</span></div>
      })}
      <label>Mensaje opcional<textarea rows={3} maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label>
     </>}
     {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="proposal-actions">
     {step>0&&<button type="button" className="secondary-button" disabled={saving} onClick={()=>{setError('');setStep(step-1)}}>Atrás</button>}
     <button className="primary-button" disabled={saving||!offered}>{saving?'Enviando…':step===2?'Enviar propuesta':'Continuar'}</button>
    </footer>
   </>}
  </form>
 </div>,document.body)
}
function AppointmentPicker({label,service,value,timeZone,onChange}:{
 label:string;service:Pick<Service,'title'|'duration_minutes'>;value:string;timeZone:string;onChange:(value:string)=>void
}){
 const [date,time]=value.split('T')
 const formatter = new Intl.DateTimeFormat('es-AR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
 const times=Array.from({length:96},(_,index)=>`${String(Math.floor(index/4)).padStart(2,'0')}:${String(index%4*15).padStart(2,'0')}`)
 return <div className="proposal-ticket">
  <small>{label}</small><strong>{service.title} · {service.duration_minutes} min</strong>
  <label>Fecha<span className="date-control"><CalendarDays size={18} aria-hidden="true"/><span>{date?formatter.format(new Date(date+'T12:00:00Z')):'Elegí una fecha'}</span><input type="date" aria-label={`Fecha · ${label}`} min={today} value={date} onChange={e=>onChange(e.target.value)}/></span></label>
  <label>Horario<select aria-label={`Horario · ${label}`} disabled={!date} value={time||''} onChange={e=>onChange(`${date}T${e.target.value}`)}>
   <option value="">{date?'Elegí un horario':'Elegí una fecha primero'}</option>
   {times.filter(slot=>((date?dateTimeInZone(`${date}T${slot}`,timeZone):null)??0)>Date.now()||slot===time).map(slot=><option key={slot}>{slot}</option>)}
  </select></label>
 </div>
}
function Exchanges({client,exchanges,business,exchangeTab,setExchangeTab,error,focused,setFocused,onOpen,onRetry}:{
 client:ReturnType<typeof createClient>; exchanges:Exchange[]; business:{id:string;time_zone:string}|null; exchangeTab:'received'|'sent';
 setExchangeTab:(tab:'received'|'sent')=>void; error:string; focused:string|null;
 setFocused:(id:string|null)=>void; onOpen:(id:string)=>Promise<void>; onRetry:()=>Promise<void>
}){
 const received=exchanges.filter(e=>e.recipient_business_id===business?.id)
 const sent=exchanges.filter(e=>e.requester_business_id===business?.id)
 const selected=exchanges.find(e=>e.id===focused)
 const activeTab=selected?(selected.recipient_business_id===business?.id?'received':'sent'):exchangeTab
 const list=activeTab==='received'?received:sent
 return <section className="page-placeholder">
  <div className="tabs exchange-tabs" aria-label="Bandejas de intercambios">
   {([{id:'received',label:'Recibidos',count:received.length},{id:'sent',label:'Enviados',count:sent.length}] as const).map(item=>
    <button type="button" key={item.id} aria-pressed={activeTab===item.id} className={activeTab===item.id?'selected':''}
     onClick={()=>{setFocused(null);setExchangeTab(item.id)}}>{item.label} <span>{item.count}</span></button>)}
  </div>
  {error&&<p className="form-error" role="alert">{error} <button className="secondary-button" onClick={()=>void onRetry()}>Reintentar</button></p>}
  {list.map(exchange=>{
   const proposal=exchange.current_proposal
   const expanded=focused===exchange.id
   const other=activeTab==='received'?exchange.requester?.display_name:exchange.recipient?.display_name
   return <article className="exchange-entry" key={exchange.id}>
    <button type="button" className="exchange-row" aria-expanded={expanded} onClick={()=>expanded?setFocused(null):void onOpen(exchange.id)}>
     <span className="exchange-avatar"><MessageCircle size={18}/></span>
     <span className="exchange-copy"><strong>{other||'Comercio'}</strong><span>{proposal?.offered_snapshot?.title||'Servicio ofrecido'} ↔ {proposal?.requested_snapshot?.title||'Servicio solicitado'}</span></span>
     <span className={`status ${exchange.status}`}>{statusLabel[exchange.status]}</span>
    </button>
    {expanded&&<div className="exchange-detail">
     {proposal?.requested_starts_at&&<p><strong>{proposal.requested_snapshot?.title}</strong> · {dateLabel(proposal.requested_starts_at,business?.time_zone)}</p>}
     {proposal?.offered_starts_at&&<p><strong>{proposal.offered_snapshot?.title}</strong> · {dateLabel(proposal.offered_starts_at,business?.time_zone)}</p>}
     {exchange.awaiting_business_id&&<p>{exchange.awaiting_business_id===business?.id?'Esperando tu respuesta':'Esperando respuesta del otro comercio'}</p>}
     {exchange.awaiting_business_id===business?.id && (exchange.status==='pending'||exchange.status==='countered') &&
      <ExchangeResponse key={`${exchange.id}-${exchange.current_version}`} exchange={exchange} client={client}
       timeZone={business?.time_zone||'America/New_York'} refresh={onRetry}/>}

    </div>}
   </article>
  })}
  {!list.length&&!error&&<div className="empty-card"><MessageCircle size={24}/><h3>{activeTab==='received'?'Todavía no recibiste propuestas':'Todavía no enviaste propuestas'}</h3></div>}
 </section>
}
function Agenda({exchanges,business}:any){const events=exchanges.filter((e:Exchange)=>['pending','countered','accepted'].includes(e.status)).flatMap((e:Exchange)=>{const p=e.current_proposal||{};const isRequester=e.requester_business_id===business?.id;const other=isRequester?e.recipient?.display_name:e.requester?.display_name;return [{id:e.id,status:e.status,title:p.requested_snapshot?.title||'Servicio',time:p.requested_starts_at,role:isRequester?'Recibís':'Ofrecés',other},{id:e.id,status:e.status,title:p.offered_snapshot?.title||'Servicio',time:p.offered_starts_at,role:isRequester?'Ofrecés':'Recibís',other}]}).filter((e:any)=>e.time).sort((a:any,b:any)=>new Date(a.time).getTime()-new Date(b.time).getTime());return <div className="calendar-page"><div className="calendar-intro"><div><p className="eyebrow">AGENDA</p><h2>Próximos turnos</h2><p>Una vista simple de tus propuestas y turnos confirmados.</p></div></div><div className="agenda-tabs"><strong>Propuestos</strong><span>{events.filter((e:any)=>e.status!=='accepted').length}</span><strong>Confirmados</strong><span>{events.filter((e:any)=>e.status==='accepted').length}</span></div><div className="agenda-list">{events.map((e:any)=><article className={`agenda-item ${e.status==='accepted'?'agenda-confirmed':''}`} key={`${e.id}-${e.role}`}><div className="agenda-date"><strong>{dateLabel(e.time,business?.time_zone)}</strong><span>{e.status==='accepted'?'Confirmado':'Aguardando confirmación'}</span></div><div className="agenda-detail"><strong>{e.title}</strong><p>{e.role} · {e.other}</p></div></article>)}{!events.length&&<div className="empty-card"><CalendarDays size={24}/><h3>Todavía no tenés turnos de intercambio</h3><p>Explorá servicios para iniciar una propuesta.</p></div>}</div></div>}

function ExchangeResponse({exchange,client,timeZone,refresh}:{
 exchange:Exchange; client:ReturnType<typeof createClient>; timeZone:string; refresh:()=>Promise<void>
}){
 const [mode,setMode]=useState<'counter'|'reject'|null>(null)
 const [requested,setRequested]=useState('')
 const [offered,setOffered]=useState('')
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const inflight=useRef(false)
 const proposal=exchange.current_proposal
 function startCounter(){
  const format=new Intl.DateTimeFormat('sv-SE',{
   timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  })
  setRequested(proposal?.requested_starts_at?format.format(new Date(proposal.requested_starts_at)).replace(' ','T'):'')
  setOffered(proposal?.offered_starts_at?format.format(new Date(proposal.offered_starts_at)).replace(' ','T'):'')
  setError('')
  setMode('counter')
 }
 async function respond(action:'accept'|'reject'|'counter'){
  if(inflight.current)return
  setError('')
  const args={p_exchange_id:exchange.id,p_expected_version:exchange.current_version}
  let newTimes:{p_requested_start:string;p_offered_start:string}|undefined
  if(action==='counter'){
   const requestedStart=dateTimeInZone(requested,timeZone)
   const offeredStart=dateTimeInZone(offered,timeZone)
   const now=Date.now()
   if(requestedStart===null||offeredStart===null||requestedStart<=now||offeredStart<=now){
    setError('Elegí una fecha y un horario futuros para ambos turnos.')
    return
   }
   newTimes={p_requested_start:new Date(requestedStart).toISOString(),p_offered_start:new Date(offeredStart).toISOString()}
  }
  inflight.current=true
  setBusy(true)
  try{
   const result=newTimes
    ?await client.rpc('counter_exchange',{...args,...newTimes})
    :await client.rpc(action==='accept'?'accept_exchange':'reject_exchange',args)
   if(result.error){
    const message=result.error.message
    if(['STALE_VERSION','EXCHANGE_CLOSED','NOT_YOUR_TURN'].includes(message)){
     setError('El intercambio cambió. Revisá la propuesta actual.')
     await refresh()
    }else if(message==='SLOT_UNAVAILABLE'){
     setError('Uno de los turnos ya no está disponible. Proponé otro horario.')
    }else if(message==='SLOTS_OVERLAP'){
     setError('Los dos turnos se superponen. Elegí horarios distintos.')
    }else if(message==='SERVICE_INACTIVE'){
     setError('Uno de los servicios ya no está publicado.')
    }else{
     setError('No pudimos guardar la respuesta. Intentá de nuevo.')
    }
    return
   }
   setMode(null)
   await refresh()
  }catch{
   setError('No pudimos actualizar el intercambio. Revisá tu conexión e intentá de nuevo.')
  }finally{
   inflight.current=false
   setBusy(false)
  }
 }
 return <div className="exchange-response" aria-busy={busy}>
  {mode==='counter'&&<>
   <AppointmentPicker label="Primer turno" service={proposal.requested_snapshot} value={requested} timeZone={timeZone} onChange={setRequested}/>
   <AppointmentPicker label="Segundo turno" service={proposal.offered_snapshot} value={offered} timeZone={timeZone} onChange={setOffered}/>
  </>}
  {mode==='reject'&&<p>¿Querés rechazar esta propuesta?</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="exchange-response-actions">
   {mode===null?<>
    <button type="button" className="primary-button" disabled={busy} onClick={()=>void respond('accept')}>Aceptar</button>
    {proposal?.requested_snapshot&&proposal?.offered_snapshot&&
     <button type="button" className="secondary-button" disabled={busy} onClick={startCounter}>Modificar turnos</button>}
    <button type="button" className="secondary-button" disabled={busy} onClick={()=>{setError('');setMode('reject')}}>Rechazar</button>
   </>:<>
    <button type="button" className="primary-button" disabled={busy} onClick={()=>void respond(mode)}>
     {mode==='counter'?'Enviar contrapropuesta':'Confirmar rechazo'}
    </button>
    <button type="button" className="secondary-button" disabled={busy} onClick={()=>{setError('');setMode(null)}}>Volver</button>
   </>}
  </div>
 </div>
}
